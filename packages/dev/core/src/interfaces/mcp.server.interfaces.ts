import type { McpClientCapabilities, McpClientInfo, McpServerIdentity } from "./mcp.core.interfaces";
import type { IMcpBehavior, IMcpBehaviorInstance } from "./mcp.behavior.interfaces";
import type { JsonRpcRequest, JsonRpcResponse } from "./mcp.jsonrpc.interfaces";

/**
 * Handles the domain-level MCP initialization handshake.
 *
 * Responsible for protocol version negotiation and server identity.
 * Capabilities are intentionally excluded — the server derives them
 * automatically from all registered {@link IMcpBehavior}s at handshake time.
 *
 * @example
 * ```typescript
 * class MyInitializer implements IMcpInitializer {
 *     initialize(_clientInfo: McpClientInfo, _caps: McpClientCapabilities): McpServerIdentity {
 *         return {
 *             protocolVersion: "2024-11-05",
 *             serverInfo: { name: "babylon-mcp-server", version: "1.0.0" },
 *             instructions: "Interact with the active Babylon.js scene.",
 *         };
 *     }
 * }
 * ```
 */
export interface IMcpInitializer {
    /**
     * @param clientInfo - Identity of the connecting client.
     * @param clientCapabilities - Features the client declares it supports.
     * @returns Server identity and protocol version. Capabilities are auto-derived
     *          by the server and must not be included here.
     */
    initialize(clientInfo: McpClientInfo, clientCapabilities: McpClientCapabilities): McpServerIdentity;
}

/**
 * Handles JSON-RPC protocol-level MCP requests, routing them to the domain layer.
 *
 * Each method maps to one MCP protocol method:
 * - `initialize`              → `initialize`
 * - `resourcesList`           → `resources/list`
 * - `resourcesTemplatesList`  → `resources/templates/list`
 * - `resourcesRead`           → `resources/read`
 * - `toolsList`               → `tools/list`
 * - `toolsCall`               → `tools/call`
 *
 * Aggregates results across all registered {@link IMcpBehavior}s and their instances.
 */
export interface IMcpServerHandlers {
    initialize(req: JsonRpcRequest): JsonRpcResponse;
    resourcesList(req: JsonRpcRequest): JsonRpcResponse;
    resourcesTemplatesList(req: JsonRpcRequest): JsonRpcResponse;
    resourcesRead(req: JsonRpcRequest): Promise<JsonRpcResponse>;
    toolsList(req: JsonRpcRequest): JsonRpcResponse;
    toolsCall(req: JsonRpcRequest): Promise<JsonRpcResponse>;
}

/**
 * Configuration options for an {@link IMcpServer} instance.
 */
export interface IMcpServerOptions {
    /**
     * Close the WebSocket connection after this many milliseconds of inactivity
     * (i.e. no message received). The timer resets on every incoming message.
     * Omit to disable idle detection.
     */
    idleTimeoutMs?: number;

    /** Automatic reconnection policy applied when the connection drops unexpectedly. */
    reconnect?: {
        /**
         * Initial delay in milliseconds before the first reconnection attempt.
         * Subsequent attempts use exponential back-off: `min(baseDelayMs * 2^n, maxDelayMs)`.
         * @default 1000
         */
        baseDelayMs?: number;

        /**
         * Upper bound on the reconnection delay in milliseconds.
         * @default 30000
         */
        maxDelayMs?: number;

        /**
         * Maximum number of reconnection attempts before giving up.
         * Omit for unlimited attempts.
         */
        maxAttempts?: number;
    };
}

/**
 * Fluent builder for constructing an {@link IMcpServer}.
 *
 * Call {@link withBehavior} once per behavior type you want to support.
 * After {@link build}, use {@link IMcpServer.attach} to register live object instances.
 *
 * @example
 * ```typescript
 * const server = builder
 *     .withName("babylon-scene")
 *     .withWsUrl("ws://localhost:8080")
 *     .withInitializer(new SceneInitializer())
 *     .withBehavior(new MeshBehavior())
 *     .withBehavior(new LightBehavior())
 *     .withOptions({ idleTimeoutMs: 30_000 })
 *     .build();
 *
 * await server.start();
 * server.attach(heroMesh, meshBehavior);
 * server.attach(sunLight, lightBehavior);
 * ```
 */
export interface IMcpServerBuilder {
    withWsUrl(url: string): IMcpServerBuilder;
    withName(name: string): IMcpServerBuilder;
    withInitializer(initializer: IMcpInitializer): IMcpServerBuilder;
    withBehavior<T>(...behavior: IMcpBehavior<T>[]): IMcpServerBuilder;
    /**
     * Replaces the default JSON-RPC message routing with a custom implementation.
     * When omitted, {@link McpServer} handles routing itself.
     * Use this to intercept, override, or extend individual MCP method handlers.
     */
    withHandlers(handlers: IMcpServerHandlers): IMcpServerBuilder;
    withOptions(o: IMcpServerOptions): IMcpServerBuilder;
    build(): IMcpServer;
}

/**
 * A running MCP server that acts as an aggregating proxy over registered behaviors.
 *
 * Resources and tools exposed to the client are the union of all
 * {@link IMcpBehaviorInstance}s currently attached to the server.
 * Behaviors and instances can be added or removed at any time, even while running.
 *
 * Obtained via {@link IMcpServerBuilder.build}.
 */
export interface IMcpServer {
    /** Human-readable name of this server instance. */
    readonly name: string;

    /** Whether the server is currently running and accepting connections. */
    readonly isRunning: boolean;

    /** Starts the server and begins accepting client connections. */
    start(): Promise<void>;

    /** Gracefully stops the server and closes all active connections. */
    stop(): Promise<void>;

    /**
     * Registers a behavior type with the server.
     * Must be called before {@link attach} can be used with this behavior.
     * Safe to call while the server is running.
     *
     * @param behavior - The behavior type to register.
     */
    registerBehavior<T>(behavior: IMcpBehavior<T>): void;

    /**
     * Attaches a specific object instance to a registered behavior,
     * making it visible to the MCP client as a resource with tools.
     * Safe to call while the server is running.
     *
     * @param target - The object to expose (e.g. a Babylon.js `Mesh` or `Light`).
     * @param behavior - The registered behavior that knows how to wrap `target`.
     * @returns The created {@link IMcpBehaviorInstance}, useful for later detaching.
     */
    attach<T>(target: T, behavior: IMcpBehavior<T>): IMcpBehaviorInstance | undefined;

    /**
     * Removes a previously attached instance from the server by its URI.
     * The resource and its tools will no longer be visible to the client.
     * Safe to call while the server is running.
     *
     * @param uri - The URI of the instance to remove (from {@link IMcpBehaviorInstance.uri}).
     */
    detach(uri: string): void;
}
