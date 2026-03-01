import type { IMcpBehavior, IMcpBehaviorInstance, IMcpInitializer, IMcpServer, IMcpServerHandlers, IMcpServerOptions, McpResource } from "../interfaces";
import type {
    JsonRpcNotification,
    JsonRpcRequest,
    JsonRpcResponse,
    McpClientCapabilities,
    McpClientInfo,
    McpInitializeResult,
    McpResourceTemplate,
    McpServerCapabilities,
    McpTool,
} from "../interfaces";
import { Mcp } from "./jsonrpc.helpers";

/**
 * Default implementation of {@link IMcpServer}.
 *
 * Connects to a WebSocket tunnel and routes incoming JSON-RPC messages to the
 * appropriate MCP handler. Also implements {@link IMcpServerHandlers} so it can
 * act as its own default handler — or delegate to a custom one supplied via the
 * builder's `withHandlers()`.
 *
 * Lifecycle:
 * ```
 * start() → WebSocket opens → receives messages → dispatches to handlers
 * stop()  → WebSocket closes, reconnection cancelled
 * ```
 */
export class McpServer implements IMcpServer, IMcpServerHandlers {
    private readonly _name: string;
    private readonly _wsUrl: string;
    private readonly _options: IMcpServerOptions;
    private readonly _initializer: IMcpInitializer | undefined;

    /**
     * The active message handler. Defaults to `this` (self-routing).
     * Can be replaced by a custom {@link IMcpServerHandlers} via the builder.
     */
    private readonly _handlers: IMcpServerHandlers;

    private _ws: WebSocket | null = null;
    private _isRunning = false;

    /** Set to true by {@link stop} to prevent reconnection after an explicit close. */
    private _stopped = false;

    /**
     * Set to true when the client sends `notifications/initialized`, signalling that
     * the session handshake is complete and the client is ready to issue requests.
     */
    private _sessionReady = false;

    /** Counts consecutive failed reconnection attempts; reset on successful open. */
    private _reconnectAttempts = 0;

    /** Handle for the pending idle-timeout timer, if active. */
    private _idleTimer: ReturnType<typeof setTimeout> | null = null;

    /** Registered behavior types, keyed by namespace. */
    private readonly _behaviors = new Map<string, IMcpBehavior<unknown>>();

    /** Live object instances, keyed by URI. */
    private readonly _instances = new Map<string, IMcpBehaviorInstance>();

    constructor(name: string, wsUrl: string, options: IMcpServerOptions, initializer?: IMcpInitializer, handlers?: IMcpServerHandlers) {
        this._name = name;
        this._wsUrl = wsUrl;
        this._options = options;
        this._initializer = initializer;
        // If no custom handlers provided, the server routes messages itself.
        this._handlers = handlers ?? this;
    }

    // -------------------------------------------------------------------------
    // IMcpServer — identity & state
    // -------------------------------------------------------------------------

    get name(): string {
        return this._name;
    }

    get isRunning(): boolean {
        return this._isRunning;
    }

    get isSessionReady(): boolean {
        return this._sessionReady;
    }

    // -------------------------------------------------------------------------
    // IMcpServer — lifecycle
    // -------------------------------------------------------------------------

    /**
     * Opens the WebSocket connection to the tunnel URL.
     * Resolves when the connection is established, rejects on the first error.
     * Safe to call again after {@link stop} to reconnect manually.
     */
    start(): Promise<void> {
        this._stopped = false;
        this._reconnectAttempts = 0;
        return this._connect();
    }

    /**
     * Closes the WebSocket connection and cancels any pending reconnection.
     * After calling this, no further reconnection attempts will be made until
     * {@link start} is called again.
     */
    async stop(): Promise<void> {
        this._stopped = true;
        this._clearIdleTimer();
        this._ws?.close();
        this._ws = null;
        this._isRunning = false;
    }

    // -------------------------------------------------------------------------
    // IMcpServer — behavior & instance management
    // -------------------------------------------------------------------------

    /**
     * Registers a behavior type with the server so that instances of that type
     * can be attached via {@link attach}.
     * Also contributes to the capabilities advertised during `initialize`.
     */
    registerBehavior<T>(behavior: IMcpBehavior<T>): void {
        this._behaviors.set(behavior.namespace, behavior as IMcpBehavior<unknown>);
    }

    /**
     * Wraps `target` with the given behavior and registers the resulting instance
     * as a live MCP resource with callable tools.
     * Safe to call while the server is running; the client will see the new resource
     * on its next `resources/list` or `tools/list` call.
     *
     * @returns The created instance, whose {@link IMcpBehaviorInstance.uri} can be
     *          passed to {@link detach} to remove it later.
     */
    attach<T>(target: T, behavior: IMcpBehavior<T>): IMcpBehaviorInstance | undefined {
        const instance = behavior.attach(target);
        if (instance) {
            this._instances.set(instance.uri, instance);
            this._notifyResourcesListChanged();
        }
        return instance;
    }

    /**
     * Removes a previously attached instance by URI.
     * The resource and its tools disappear from subsequent `resources/list` and
     * `tools/list` responses.
     */
    detach(uri: string): void {
        this._instances.delete(uri);
        this._notifyResourcesListChanged();
    }

    // -------------------------------------------------------------------------
    // IMcpServerHandlers — default MCP method implementations
    // -------------------------------------------------------------------------

    /**
     * Handles the `initialize` handshake.
     * Delegates identity/version to {@link IMcpInitializer} if one was provided,
     * then merges with capabilities derived from registered behaviors.
     */
    initialize(req: JsonRpcRequest): JsonRpcResponse {
        const params = req.params as { clientInfo?: McpClientInfo; capabilities?: McpClientCapabilities } | undefined;

        const identity = this._initializer
            ? this._initializer.initialize(params?.clientInfo ?? { name: "unknown", version: "0.0.0" }, params?.capabilities ?? {})
            : { protocolVersion: "2024-11-05", serverInfo: { name: this._name, version: "0.0.0" } };

        const result: McpInitializeResult = { ...identity, capabilities: this._deriveCapabilities() };

        return Mcp.initializeResult(req.id, result);
    }

    /**
     * Handles `resources/templates/list`.
     * Collects URI templates from all registered behavior types that declare one.
     * Each unique namespace contributes at most one template entry.
     */
    resourcesTemplatesList(req: JsonRpcRequest): JsonRpcResponse {
        const templates: McpResourceTemplate[] = [];
        for (const behavior of this._behaviors.values()) {
            if (behavior.uriTemplate) {
                templates.push({
                    uriTemplate: behavior.uriTemplate,
                    name: behavior.name ?? behavior.namespace,
                    description: behavior.description,
                    mimeType: behavior.mimeType,
                });
            }
        }
        return Mcp.resourcesTemplatesListResult(req.id, templates);
    }

    /**
     * Handles `resources/list`.
     * Returns the union of all live {@link IMcpBehaviorInstance} resources.
     */
    resourcesList(req: JsonRpcRequest): JsonRpcResponse {
        const resources = Array.from(this._instances.values())
            .map((i) => i.getResource())
            .filter((r): r is McpResource => r !== undefined);
        return Mcp.resourcesListResult(req.id, resources);
    }

    /**
     * Handles `resources/read`.
     * Looks up the instance by URI and returns its current state.
     * Returns a `-32002` error if the URI is not found.
     */
    async resourcesRead(req: JsonRpcRequest): Promise<JsonRpcResponse> {
        const params = req.params as { uri?: string } | undefined;
        const uri = params?.uri;

        if (!uri) return Mcp.invalidParams(req.id, "Missing required parameter: uri");
        const instance = this._instances.get(uri);
        if (!instance) return Mcp.resourceNotFound(req.id, uri);
        const r = await instance.readResourceAsync();
        if (!r) return Mcp.resourceNotFound(req.id, uri);

        return Mcp.resourcesReadResult(req.id, r);
    }

    /**
     * Handles `tools/list`.
     * Deduplicates tools by name: all instances of the same behavior expose
     * identical schemas, so each tool is listed only once.
     * The target instance is identified at call time via the `uri` argument.
     */
    toolsList(req: JsonRpcRequest): JsonRpcResponse {
        const seen = new Set<string>();
        const tools: McpTool[] = [];

        for (const instance of this._instances.values()) {
            for (const tool of instance.getTools()) {
                if (!seen.has(tool.name)) {
                    seen.add(tool.name);
                    tools.push(tool);
                }
            }
        }

        return Mcp.toolsListResult(req.id, tools);
    }

    /**
     * Handles `tools/call`.
     *
     * Routing strategy (in order):
     * 1. If `arguments.uri` is present, route directly to that instance (fast path).
     *    Behaviors should declare `uri` as a required field in their tool `inputSchema`.
     * 2. Otherwise, scan all instances for the first one that declares the tool (fallback
     *    for single-instance scenarios where a URI is not needed).
     */
    async toolsCall(req: JsonRpcRequest): Promise<JsonRpcResponse> {
        const params = req.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
        const name = params?.name;
        const args = params?.arguments ?? {};

        if (!name) return Mcp.invalidParams(req.id, "Missing required parameter: name");

        // Fast path: route by instance URI when the caller provides it.
        const uri = args["uri"] as string | undefined;
        if (uri) {
            const instance = this._instances.get(uri);
            if (!instance) return Mcp.instanceNotFound(req.id, uri);
            return this._callTool(req, instance, name, args);
        }

        // Fallback: find the first instance that declares this tool.
        for (const instance of this._instances.values()) {
            if (instance.getTools().some((t) => t.name === name)) {
                return this._callTool(req, instance, name, args);
            }
        }

        return Mcp.toolNotFound(req.id, name);
    }

    // -------------------------------------------------------------------------
    // WebSocket connection management
    // -------------------------------------------------------------------------

    /**
     * Opens a new WebSocket connection and wires up all event handlers.
     * Called by {@link start} and scheduled again by {@link _scheduleReconnect}.
     */
    private _connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(this._wsUrl);

            ws.onopen = () => {
                this._ws = ws;
                this._isRunning = true;
                this._reconnectAttempts = 0; // reset back-off counter on success
                resolve();
            };

            ws.onerror = () => {
                // Only reject the initial promise; subsequent errors are handled via onclose.
                if (!this._isRunning) {
                    reject(new Error(`McpServer: could not connect to ${this._wsUrl}`));
                }
            };

            ws.onclose = () => this._onDisconnect();

            ws.onmessage = (event: MessageEvent<string>) => {
                this._resetIdleTimer();
                void this._handleMessage(event.data);
            };
        });
    }

    /**
     * Called whenever the WebSocket closes (cleanly or not).
     * Triggers reconnection unless {@link stop} was called explicitly.
     */
    private _onDisconnect(): void {
        this._isRunning = false;
        this._ws = null;
        this._sessionReady = false; // handshake must be repeated on reconnection
        this._clearIdleTimer();

        if (!this._stopped) {
            this._scheduleReconnect();
        }
    }

    /**
     * Schedules a reconnection attempt using exponential back-off with jitter.
     *
     * Delay formula: `min(baseDelayMs * 2^attempt, maxDelayMs) * jitter`
     * where `jitter ∈ [0.5, 1.0]` to spread reconnection storms.
     *
     * Gives up silently once `maxAttempts` is reached (if configured).
     */
    private _scheduleReconnect(): void {
        const policy = this._options.reconnect;
        // No reconnect policy means no automatic reconnection.
        if (!policy) return;

        const maxAttempts = policy.maxAttempts ?? Infinity;
        if (this._reconnectAttempts >= maxAttempts) return;

        const base = policy.baseDelayMs ?? 1_000;
        const max = policy.maxDelayMs ?? 30_000;
        const jitter = 0.5 + Math.random() * 0.5; // [0.5, 1.0]
        const delay = Math.min(base * 2 ** this._reconnectAttempts, max) * jitter;

        this._reconnectAttempts++;

        setTimeout(() => void this._connect(), delay);
    }

    // -------------------------------------------------------------------------
    // Message handling
    // -------------------------------------------------------------------------

    /**
     * Entry point for every raw WebSocket message.
     * Distinguishes JSON-RPC notifications (no `id`) from requests (has `id`):
     * - Notifications are handled but never answered.
     * - Requests are dispatched and produce a response sent back over the socket.
     */
    private async _handleMessage(data: string): Promise<void> {
        let msg: JsonRpcRequest | JsonRpcNotification;
        try {
            msg = JSON.parse(data) as JsonRpcRequest | JsonRpcNotification;
        } catch {
            // Per JSON-RPC 2.0 spec, id is null when the request cannot be parsed.
            this._send(Mcp.parseError());
            return;
        }

        // Notifications carry no `id` — handle silently, never respond.
        if (!("id" in msg) || msg.id === null) {
            this._handleNotification(msg as JsonRpcNotification);
            return;
        }

        this._send(await this._dispatch(msg as JsonRpcRequest));
    }

    /**
     * Handles JSON-RPC notifications sent by the client.
     * Per the MCP spec, no response is ever sent for notifications.
     * Unknown notification methods are silently ignored.
     */
    private _handleNotification(notification: JsonRpcNotification): void {
        switch (notification.method) {
            case "notifications/initialized":
                // Client has finished its own initialisation and is ready to send requests.
                this._sessionReady = true;
                break;
            // All other notifications are intentionally ignored.
        }
    }

    /**
     * Routes a parsed JSON-RPC request to the correct handler method.
     * Unknown methods receive a `-32601 Method not found` error.
     */
    private async _dispatch(req: JsonRpcRequest): Promise<JsonRpcResponse> {
        switch (req.method) {
            case "initialize":
                return this._handlers.initialize(req);
            case "resources/list":
                return this._handlers.resourcesList(req);
            case "resources/templates/list":
                return this._handlers.resourcesTemplatesList(req);
            case "resources/read":
                return this._handlers.resourcesRead(req);
            case "tools/list":
                return this._handlers.toolsList(req);
            case "tools/call":
                return this._handlers.toolsCall(req);
            default:
                return Mcp.methodNotFound(req.id, req.method);
        }
    }

    // -------------------------------------------------------------------------
    // Idle timeout
    // -------------------------------------------------------------------------

    /**
     * Resets the idle-timeout timer on each incoming message.
     * When the timer expires the connection is closed, which may trigger reconnection.
     */
    private _resetIdleTimer(): void {
        if (!this._options.idleTimeoutMs) return;
        this._clearIdleTimer();
        this._idleTimer = setTimeout(() => {
            this._ws?.close();
        }, this._options.idleTimeoutMs);
    }

    private _clearIdleTimer(): void {
        if (this._idleTimer !== null) {
            clearTimeout(this._idleTimer);
            this._idleTimer = null;
        }
    }

    // -------------------------------------------------------------------------
    // Shared helpers
    // -------------------------------------------------------------------------

    /**
     * Sends a `notifications/resources/list_changed` notification to the client.
     * Only fires when the session is fully initialized and the WebSocket is open.
     */
    private _notifyResourcesListChanged(): void {
        if (!this._sessionReady) return;
        this._sendNotification(Mcp.resourcesListChanged());
    }

    /**
     * Serializes and sends a JSON-RPC notification over the WebSocket, if open.
     * Unlike {@link _send}, this accepts a notification (no `id`) rather than a response.
     */
    private _sendNotification(notification: { jsonrpc: "2.0"; method: string; params?: unknown }): void {
        if (this._ws?.readyState === WebSocket.OPEN) {
            this._ws.send(JSON.stringify(notification));
        }
    }

    /**
     * Derives server capabilities from registered behavior types.
     * Any registered behavior implies both `resources` and `tools` support.
     */
    private _deriveCapabilities(): McpServerCapabilities {
        if (this._behaviors.size === 0 && this._instances.size === 0) return {};
        return { resources: { listChanged: true }, tools: { listChanged: true } };
    }

    /** Invokes a tool on a specific instance and wraps the result as a JSON-RPC response. */
    private async _callTool(req: JsonRpcRequest, instance: IMcpBehaviorInstance, name: string, args: unknown): Promise<JsonRpcResponse> {
        try {
            const result = await instance.callTool(name, args);
            return Mcp.toolCallResult(req.id, JSON.stringify(result));
        } catch (err) {
            return Mcp.internalError(req.id, err instanceof Error ? err.message : "Internal error");
        }
    }

    /** Sends a serialized JSON-RPC response over the WebSocket, if open. */
    private _send(response: JsonRpcResponse): void {
        if (this._ws?.readyState === WebSocket.OPEN) {
            this._ws.send(JSON.stringify(response));
        }
    }
}
