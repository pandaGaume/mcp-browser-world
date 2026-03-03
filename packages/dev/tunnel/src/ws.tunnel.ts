import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as nodePath from "path";
import { randomUUID } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import { WebSocket, WebSocketServer } from "ws";

// ---------------------------------------------------------------------------
// Static-file helpers
// ---------------------------------------------------------------------------

/** Maps file extensions to their HTTP Content-Type values. */
const MIME: Readonly<Record<string, string>> = {
    ".html":  "text/html; charset=utf-8",
    ".js":    "application/javascript; charset=utf-8",
    ".mjs":   "application/javascript; charset=utf-8",
    ".css":   "text/css; charset=utf-8",
    ".json":  "application/json; charset=utf-8",
    ".map":   "application/json; charset=utf-8",
    ".svg":   "image/svg+xml",
    ".png":   "image/png",
    ".ico":   "image/x-icon",
    ".woff2": "font/woff2",
    ".woff":  "font/woff",
};

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Where a JSON-RPC response should be delivered.
 * Either a WebSocket socket (raw WS client), an SSE session (legacy MCP/HTTP),
 * or a held-open HTTP response (Streamable HTTP transport, MCP 2025-03-26).
 */
type ResponseSink =
    | { type: "ws";   socket: WebSocket }
    | { type: "sse";  sessionId: string }
    | { type: "http"; res: ServerResponse };

/**
 * All mutable state for one named provider slot.
 * Created lazily on first client connection; the WebSocket field is set when
 * the Babylon.js provider actually connects (and cleared on disconnect).
 */
interface ProviderState {
    /** The active provider WebSocket, or `null` when the provider is not connected. */
    ws: WebSocket | null;
    /** Pending JSON-RPC request ids → response sinks waiting for a reply. */
    readonly pending: Map<string | number, ResponseSink>;
    /** Active legacy SSE sessions (Claude), keyed by session id. */
    readonly sseSessions: Map<string, ServerResponse>;
    /** Active Streamable HTTP GET streams (MCP Inspector), keyed by session id. */
    readonly mcpGetSessions: Map<string, ServerResponse>;
    /** Raw WebSocket MCP clients connected to this provider. */
    readonly wsClients: Set<WebSocket>;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single static-file mount: serves the contents of `dir` under `urlPrefix`.
 *
 * @example
 * { urlPrefix: "/",       dir: "/absolute/path/to/www" }
 * { urlPrefix: "/bundle", dir: "/absolute/path/to/bundle" }
 */
export interface StaticMount {
    /** URL prefix that triggers this mount (e.g. `"/"` or `"/bundle"`). */
    urlPrefix: string;
    /** Absolute path to the directory to serve. */
    dir: string;
}

/**
 * Configuration options for a {@link WsTunnel} instance.
 */
export interface WsTunnelOptions {
    /** TCP port to listen on. */
    port: number;

    /**
     * Host/interface to bind to.
     * @default "0.0.0.0"
     */
    host?: string;

    /**
     * URL path **prefix** the Babylon.js `McpServer` (provider) connects to via WebSocket.
     * Each provider appends its name: `<providerPath>/<encodedName>`.
     * @default "/provider"
     */
    providerPath?: string;

    /**
     * URL path raw WebSocket MCP clients connect to.
     * @default "/"
     */
    clientPath?: string;

    /**
     * **Suffix** appended to a provider name for the SSE endpoint.
     * Full URL: `/<providerName>/sse`
     * @default "/sse"
     */
    ssePath?: string;

    /**
     * **Suffix** appended to a provider name for the legacy SSE POST endpoint.
     * Full URL: `/<providerName>/messages`
     * @default "/messages"
     */
    messagesPath?: string;

    /**
     * **Suffix** appended to a provider name for the Streamable HTTP endpoint (MCP 2025-03-26).
     * Full URL: `/<providerName>/mcp`
     * MCP Inspector connects here.
     * @default "/mcp"
     */
    mcpPath?: string;

    /**
     * URL path that returns a `{ files: string[] }` JSON listing of every file
     * inside the `samples/` subdirectory of the root static mount.
     * @default "/__samples_index__"
     */
    samplesIndexPath?: string;

    /**
     * Optional static-file mounts served over plain HTTP.
     * Matched by longest URL prefix; directory requests fall back to `index.html`.
     */
    staticMounts?: StaticMount[];

    /**
     * TLS configuration. When provided, the server uses HTTPS and WSS instead of HTTP and WS.
     * Both `cert` and `key` must be PEM-encoded strings (file contents, not file paths).
     * Use {@link WsTunnelBuilder.withTlsFiles} to load from disk paths.
     * @default undefined — plain HTTP/WS
     */
    tls?: {
        /** PEM-encoded TLS certificate. */
        cert: string;
        /** PEM-encoded private key. */
        key: string;
    };
}

// ---------------------------------------------------------------------------
// WsTunnel
// ---------------------------------------------------------------------------

/**
 * A multi-provider relay that bridges any number of Babylon.js `McpServer`
 * instances (the **providers**) with their respective MCP clients.
 *
 * ## Transport overview
 * ```
 * Provider "babylon-scene"
 *   ws://host/provider/babylon-scene    ← WebSocket registration
 *
 * MCP Inspector (Streamable HTTP, 2025-03-26)
 *   GET  http://host/babylon-scene/mcp  ← persistent SSE notification stream
 *   POST http://host/babylon-scene/mcp  → JSON-RPC requests
 *
 * Claude (legacy SSE transport)
 *   GET  http://host/babylon-scene/sse      ← SSE notification stream
 *   POST http://host/babylon-scene/messages → JSON-RPC requests
 * ```
 *
 * Each provider gets its own isolated set of sessions, pending requests, and
 * notification streams. Multiple providers can be connected simultaneously.
 */
export class WsTunnel {
    private readonly _options: WsTunnelOptions;
    private _httpServer: http.Server | https.Server | null = null;
    private _wss: WebSocketServer | null = null;

    /**
     * Per-provider state, keyed by provider name.
     * Created lazily: a slot is allocated the first time any client references
     * a provider name, even before the Babylon.js WebSocket connects.
     */
    private readonly _providers = new Map<string, ProviderState>();

    constructor(options: WsTunnelOptions) {
        this._options = options;
    }

    // -------------------------------------------------------------------------
    // Public state
    // -------------------------------------------------------------------------

    get isListening(): boolean { return this._httpServer?.listening ?? false; }

    /** Total number of connected MCP clients across all providers. */
    get clientCount(): number {
        let n = 0;
        for (const s of this._providers.values()) {
            n += s.wsClients.size + s.sseSessions.size + s.mcpGetSessions.size;
        }
        return n;
    }

    /** Names of all providers that currently have an active WebSocket connection. */
    get providerNames(): readonly string[] {
        return [...this._providers.entries()]
            .filter(([, s]) => s.ws?.readyState === WebSocket.OPEN)
            .map(([name]) => name);
    }

    /** @deprecated Check `providerNames.length > 0` instead. */
    get hasProvider(): boolean { return this.providerNames.length > 0; }

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    /**
     * Starts the tunnel. Resolves once the HTTP server is listening.
     */
    start(): Promise<void> {
        return new Promise((resolve) => {
            const handler = (req: IncomingMessage, res: ServerResponse) => this._handleHttp(req, res);
            this._httpServer = this._options.tls
                ? https.createServer({ cert: this._options.tls.cert, key: this._options.tls.key }, handler)
                : http.createServer(handler);
            this._wss = new WebSocketServer({ server: this._httpServer });

            this._wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
                const url          = req.url ?? "/";
                const providerPath = this._options.providerPath ?? "/provider";

                if (url.startsWith(providerPath + "/") || url === providerPath) {
                    // Extract name: everything after "<providerPath>/"
                    const raw  = url.slice(providerPath.length).replace(/^\//, "");
                    const name = decodeURIComponent(raw.split("?")[0]) || "(unnamed)";
                    this._onProviderConnect(ws, name);
                } else {
                    // Raw WS MCP client: URL is "/<providerName>" or "/"
                    const raw  = url.replace(/^\//, "").split("?")[0];
                    const name = decodeURIComponent(raw) || "";
                    this._onClientConnect(ws, name);
                }
            });

            this._httpServer.listen(this._options.port, this._options.host ?? "0.0.0.0", () => resolve());
        });
    }

    /**
     * Gracefully closes all connections and stops the HTTP server.
     */
    stop(): Promise<void> {
        return new Promise((resolve, reject) => {
            for (const state of this._providers.values()) {
                for (const res of state.sseSessions.values()) res.end();
                state.sseSessions.clear();
                for (const res of state.mcpGetSessions.values()) res.end();
                state.mcpGetSessions.clear();
                for (const client of state.wsClients) client.close();
                state.wsClients.clear();
                state.ws?.close();
            }
            this._providers.clear();
            this._wss?.close();
            this._httpServer?.close((err) => (err ? reject(err) : resolve()));
        });
    }

    // -------------------------------------------------------------------------
    // HTTP dispatcher
    // -------------------------------------------------------------------------

    private _handleHttp(req: IncomingMessage, res: ServerResponse): void {
        const method = req.method ?? "GET";
        const rawUrl = (req.url ?? "/").split("?")[0];

        // CORS
        res.setHeader("Access-Control-Allow-Origin",  "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers",
            req.headers["access-control-request-headers"] ?? "Content-Type, Accept, Mcp-Session-Id");
        res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

        if (method === "OPTIONS") { res.writeHead(204); res.end(); return; }

        // Samples index (no provider prefix)
        const samplesIndexPath = this._options.samplesIndexPath ?? "/__samples_index__";
        if (method === "GET" && rawUrl === samplesIndexPath) {
            this._handleSamplesIndex(res);
            return;
        }

        // Route /<providerName>/<endpoint>
        const route = this._parseProviderRoute(rawUrl);
        if (route) {
            const { providerName, endpoint } = route;
            const mcpSuffix      = (this._options.mcpPath      ?? "/mcp")      .replace(/^\//, "");
            const sseSuffix      = (this._options.ssePath       ?? "/sse")      .replace(/^\//, "");
            const messagesSuffix = (this._options.messagesPath  ?? "/messages") .replace(/^\//, "");

            if (endpoint === mcpSuffix) {
                if (method === "GET")  { this._handleMcpGetStream(req, res, providerName); return; }
                if (method === "POST") { this._handleMcpPost(req, res, providerName);      return; }
            }
            if (endpoint === sseSuffix && method === "GET") {
                this._handleSseConnect(req, res, providerName);
                return;
            }
            if (endpoint === messagesSuffix && method === "POST") {
                this._handleSseMessage(req, res, providerName);
                return;
            }
        }

        // Static files
        if (this._options.staticMounts?.length) {
            this._serveStatic(req, res);
        } else {
            res.writeHead(404); res.end();
        }
    }

    /**
     * Parses `/<providerName>/<endpoint>` from a URL path.
     * Returns `null` if the URL does not match this two-segment pattern.
     */
    private _parseProviderRoute(rawUrl: string): { providerName: string; endpoint: string } | null {
        const parts = rawUrl.split("/").filter(Boolean);
        if (parts.length !== 2) return null;
        const providerName = decodeURIComponent(parts[0]);
        const endpoint     = decodeURIComponent(parts[1]);
        if (!providerName || !endpoint) return null;
        return { providerName, endpoint };
    }

    // -------------------------------------------------------------------------
    // MCP / SSE transport (per provider)
    // -------------------------------------------------------------------------

    /**
     * Handles `GET /<providerName>/sse` — opens a long-lived SSE stream for Claude.
     * Sends an `endpoint` event so Claude knows where to POST its requests.
     */
    private _handleSseConnect(req: IncomingMessage, res: ServerResponse, providerName: string): void {
        const sessionId    = randomUUID();
        const messagesSuffix = (this._options.messagesPath ?? "/messages").replace(/^\//, "");
        const messagesUrl    = `/${encodeURIComponent(providerName)}/${messagesSuffix}`;

        res.writeHead(200, {
            "Content-Type":  "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "Connection":    "keep-alive",
        });
        res.write(`event: endpoint\ndata: ${messagesUrl}?sessionId=${sessionId}\n\n`);

        const state = this._getOrCreateProviderState(providerName);
        state.sseSessions.set(sessionId, res);

        req.on("close", () => {
            state.sseSessions.delete(sessionId);
            for (const [id, sink] of state.pending) {
                if (sink.type === "sse" && sink.sessionId === sessionId) state.pending.delete(id);
            }
        });
    }

    /**
     * Handles `POST /<providerName>/messages?sessionId=…` — receives a JSON-RPC
     * request from Claude and forwards it to the provider.
     * Always responds 202 Accepted; the real response arrives over SSE.
     */
    private _handleSseMessage(req: IncomingMessage, res: ServerResponse, providerName: string): void {
        const params    = new URL(req.url ?? "", "http://localhost").searchParams;
        const sessionId = params.get("sessionId") ?? "";
        const state     = this._getOrCreateProviderState(providerName);

        if (!state.sseSessions.has(sessionId)) {
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end("Unknown or expired session");
            return;
        }

        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end",  () => {
            try {
                const msg = JSON.parse(body) as { id?: string | number };
                if (msg.id != null) state.pending.set(msg.id, { type: "sse", sessionId });
            } catch { /* malformed — forward anyway */ }

            if (state.ws?.readyState === WebSocket.OPEN) {
                state.ws.send(body);
            } else {
                const sseRes = state.sseSessions.get(sessionId);
                if (sseRes) {
                    let errId: string | number | null = null;
                    try { errId = (JSON.parse(body) as { id?: string | number }).id ?? null; } catch { /* */ }
                    this._sendSseEvent(sseRes, JSON.stringify({
                        jsonrpc: "2.0", id: errId,
                        error: { code: -32000, message: `Provider "${providerName}" not connected` },
                    }));
                }
            }

            res.writeHead(202); res.end();
        });
    }

    /**
     * Handles `POST /<providerName>/mcp` — Streamable HTTP transport (MCP 2025-03-26).
     * Forwards the JSON-RPC request to the provider and holds the HTTP response
     * open until the reply arrives, then writes it as `application/json`.
     */
    private _handleMcpPost(req: IncomingMessage, res: ServerResponse, providerName: string): void {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
            let msg: { id?: string | number } = {};
            try { msg = JSON.parse(body) as { id?: string | number }; }
            catch {
                res.writeHead(400, { "Content-Type": "text/plain" });
                res.end("Invalid JSON");
                return;
            }

            const state = this._getOrCreateProviderState(providerName);

            if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({
                    jsonrpc: "2.0", id: msg.id ?? null,
                    error: { code: -32000, message: `Provider "${providerName}" not connected` },
                }));
                return;
            }

            if (msg.id != null) {
                // Request: hold the response open; reply arrives in _routeFromProvider.
                state.pending.set(msg.id, { type: "http", res });
            } else {
                // Notification: forward and acknowledge immediately.
                res.writeHead(202);
                res.end();
            }

            state.ws.send(body);
        });
    }

    /**
     * Handles `GET /<providerName>/mcp` — opens a persistent SSE stream per MCP 2025-03-26.
     * Streamable HTTP clients (e.g. MCP Inspector) use this to receive
     * server-initiated notifications without re-polling.
     */
    private _handleMcpGetStream(req: IncomingMessage, res: ServerResponse, providerName: string): void {
        const sessionId = (req.headers["mcp-session-id"] as string | undefined) ?? randomUUID();

        res.writeHead(200, {
            "Content-Type":  "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "Connection":    "keep-alive",
            "Mcp-Session-Id": sessionId,
        });
        res.write(": stream open\n\n");

        const state = this._getOrCreateProviderState(providerName);
        state.mcpGetSessions.set(sessionId, res);

        req.on("close", () => {
            state.mcpGetSessions.delete(sessionId);
        });
    }

    /** Writes one JSON-RPC message as an SSE `message` event. */
    private _sendSseEvent(res: ServerResponse, data: string): void {
        let line: string;
        try { line = JSON.stringify(JSON.parse(data)); } catch { line = data; }
        res.write(`event: message\ndata: ${line}\n\n`);
    }

    // -------------------------------------------------------------------------
    // WebSocket connection handlers
    // -------------------------------------------------------------------------

    private _onProviderConnect(ws: WebSocket, name: string): void {
        const existing = this._providers.get(name);
        if (existing?.ws?.readyState === WebSocket.OPEN) {
            ws.close(1008, `Provider "${name}" is already connected`);
            return;
        }

        const state = this._getOrCreateProviderState(name);
        state.ws = ws;

        ws.on("message", (data: Buffer) => this._routeFromProvider(state, data.toString()));

        ws.on("close", () => {
            state.ws = null;
            // Notify all pending sinks that the provider is gone.
            const error = JSON.stringify({
                jsonrpc: "2.0", id: null,
                error: { code: -32000, message: `Provider "${name}" disconnected` },
            });
            for (const sink of state.pending.values()) {
                if (sink.type === "ws" && sink.socket.readyState === WebSocket.OPEN) {
                    sink.socket.send(error);
                } else if (sink.type === "sse") {
                    const sseRes = state.sseSessions.get(sink.sessionId);
                    if (sseRes) this._sendSseEvent(sseRes, error);
                } else if (sink.type === "http") {
                    sink.res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                    sink.res.end(error);
                }
            }
            state.pending.clear();
        });
    }

    private _onClientConnect(ws: WebSocket, providerName: string): void {
        const state = this._getOrCreateProviderState(providerName);
        state.wsClients.add(ws);

        ws.on("message", (data: Buffer) => this._routeFromClient(ws, state, data.toString()));

        ws.on("close", () => {
            state.wsClients.delete(ws);
            for (const [id, sink] of state.pending) {
                if (sink.type === "ws" && sink.socket === ws) state.pending.delete(id);
            }
        });
    }

    // -------------------------------------------------------------------------
    // Message routing
    // -------------------------------------------------------------------------

    private _routeFromClient(client: WebSocket, state: ProviderState, data: string): void {
        try {
            const msg = JSON.parse(data) as { id?: string | number };
            if (msg?.id != null) state.pending.set(msg.id, { type: "ws", socket: client });
        } catch { /* forward as-is */ }

        if (state.ws?.readyState === WebSocket.OPEN) {
            state.ws.send(data);
        } else {
            client.send(JSON.stringify({
                jsonrpc: "2.0", id: null,
                error: { code: -32000, message: "No provider connected" },
            }));
        }
    }

    private _routeFromProvider(state: ProviderState, data: string): void {
        try {
            const msg = JSON.parse(data) as { id?: string | number };

            if (msg.id != null) {
                // Response: route to the specific sink that made the request.
                const sink = state.pending.get(msg.id);
                if (sink?.type === "ws" && sink.socket.readyState === WebSocket.OPEN) {
                    sink.socket.send(data);
                } else if (sink?.type === "sse") {
                    const sseRes = state.sseSessions.get(sink.sessionId);
                    if (sseRes) this._sendSseEvent(sseRes, data);
                } else if (sink?.type === "http") {
                    sink.res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                    sink.res.end(data);
                }
                state.pending.delete(msg.id);
            } else {
                // Notification (no id): broadcast to all clients of this provider.
                this._broadcast(state, data);
            }
        } catch {
            this._broadcast(state, data);
        }
    }

    /** Sends a message to all clients connected to one provider. */
    private _broadcast(state: ProviderState, data: string): void {
        for (const client of state.wsClients) {
            if (client.readyState === WebSocket.OPEN) client.send(data);
        }
        for (const sseRes of state.sseSessions.values()) {
            this._sendSseEvent(sseRes, data);
        }
        for (const mcpRes of state.mcpGetSessions.values()) {
            this._sendSseEvent(mcpRes, data);
        }
    }

    // -------------------------------------------------------------------------
    // Provider state helpers
    // -------------------------------------------------------------------------

    /** Returns the state for `name`, creating it lazily if it doesn't exist yet. */
    private _getOrCreateProviderState(name: string): ProviderState {
        let state = this._providers.get(name);
        if (!state) {
            state = {
                ws: null,
                pending: new Map(),
                sseSessions: new Map(),
                mcpGetSessions: new Map(),
                wsClients: new Set(),
            };
            this._providers.set(name, state);
        }
        return state;
    }

    // -------------------------------------------------------------------------
    // Samples index
    // -------------------------------------------------------------------------

    private _handleSamplesIndex(res: ServerResponse): void {
        const rootMount = (this._options.staticMounts ?? []).find((m) => m.urlPrefix === "/");

        let files: string[] = [];
        if (rootMount) {
            const samplesDir = nodePath.join(rootMount.dir, "samples");
            try {
                if (fs.existsSync(samplesDir) && fs.statSync(samplesDir).isDirectory()) {
                    files = fs.readdirSync(samplesDir).filter((name) =>
                        fs.statSync(nodePath.join(samplesDir, name)).isFile()
                    );
                }
            } catch { /* return empty list on any I/O error */ }
        }

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ files }));
    }

    // -------------------------------------------------------------------------
    // Static file serving
    // -------------------------------------------------------------------------

    private _serveStatic(req: IncomingMessage, res: ServerResponse): void {
        const rawUrl = (req.url ?? "/").split("?")[0].split("#")[0];
        const mounts = this._options.staticMounts ?? [];

        const mount = [...mounts]
            .filter((m) => {
                const prefix = m.urlPrefix.endsWith("/") ? m.urlPrefix : m.urlPrefix + "/";
                return rawUrl === m.urlPrefix || rawUrl.startsWith(prefix);
            })
            .sort((a, b) => b.urlPrefix.length - a.urlPrefix.length)[0];

        if (!mount) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not found"); return; }

        const relative   = rawUrl.slice(mount.urlPrefix.length) || "/";
        const normalized = nodePath.normalize(relative);

        if (normalized.startsWith("..")) { res.writeHead(403); res.end("Forbidden"); return; }

        const mountAbs = nodePath.resolve(mount.dir);
        let   filePath = nodePath.join(mountAbs, normalized);

        if (!filePath.startsWith(mountAbs + nodePath.sep) && filePath !== mountAbs) {
            res.writeHead(403); res.end("Forbidden"); return;
        }

        try {
            if (fs.statSync(filePath).isDirectory()) filePath = nodePath.join(filePath, "index.html");
        } catch { res.writeHead(404); res.end("Not found"); return; }

        if (!fs.existsSync(filePath)) { res.writeHead(404); res.end("Not found"); return; }

        const ext = nodePath.extname(filePath).toLowerCase();
        res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
        fs.createReadStream(filePath).pipe(res);
    }
}
