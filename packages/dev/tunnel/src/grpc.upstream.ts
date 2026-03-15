import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface GrpcUpstreamConfig {
    /** Logical name of this backend (used as the first segment in composite provider names). */
    name: string;
    /** gRPC server host. */
    host: string;
    /** gRPC server port. */
    port: number;
    /** Use TLS for the channel. Defaults to `false`. */
    useTls?: boolean;
    /** PEM-encoded root certificates (TLS only). */
    rootCerts?: Buffer;
}

// ---------------------------------------------------------------------------
// Proto loading (self-contained — no cross-package import)
// ---------------------------------------------------------------------------

interface McpMessage {
    payload: string;
}
type McpChannelCall = grpc.ClientDuplexStream<McpMessage, McpMessage>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type McpServiceClient = new (addr: string, creds: grpc.ChannelCredentials, opts?: any) => grpc.Client & { Channel(): McpChannelCall };

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROTO_PATH = join(__dirname, "..", "proto", "mcp.proto");

let _cached: grpc.GrpcObject | null = null;

async function loadProto(): Promise<McpServiceClient> {
    if (!_cached) {
        const def = await protoLoader.load(PROTO_PATH, {
            keepCase: true,
            longs: String,
            enums: String,
            defaults: true,
            oneofs: true,
        });
        _cached = grpc.loadPackageDefinition(def);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (_cached.mcp as any).McpTransport as McpServiceClient;
}

// ---------------------------------------------------------------------------
// Reconnection helper (same algorithm as MultiplexSocket)
// ---------------------------------------------------------------------------

function reconnectDelay(attempt: number): number {
    const base = 1_000,
        max = 30_000;
    const jitter = 0.5 + Math.random() * 0.5;
    return Math.min(base * 2 ** attempt, max) * jitter;
}

// ---------------------------------------------------------------------------
// GrpcUpstream
// ---------------------------------------------------------------------------

/**
 * Manages a bidirectional gRPC stream to a remote MCP-compatible server.
 * One instance per configured backend. The tunnel uses this to bridge
 * browser WebSocket clients to gRPC servers (LLM, Ray, etc.).
 *
 * Messages are raw JSON-RPC strings — wrapped in `McpMessage { payload }`
 * on the wire, unwrapped transparently.
 */
export class GrpcUpstream {
    readonly name: string;
    private readonly _address: string;
    private readonly _config: GrpcUpstreamConfig;

    private _client: InstanceType<McpServiceClient> | null = null;
    private _stream: McpChannelCall | null = null;
    private _open = false;
    private _stopped = false;
    private _reconnectAttempts = 0;

    /**
     * Called when a message arrives from the gRPC server.
     * The tunnel wires this to `_routeFromProvider`.
     */
    onMessage: ((data: string) => void) | null = null;

    /** Called when the upstream connection opens. */
    onOpen: (() => void) | null = null;

    /** Called when the upstream connection closes. */
    onClose: (() => void) | null = null;

    /** Called on transport-level errors. */
    onError: ((error: Error) => void) | null = null;

    constructor(config: GrpcUpstreamConfig) {
        this.name = config.name;
        this._address = `${config.host}:${config.port}`;
        this._config = config;
    }

    get isOpen(): boolean {
        return this._open;
    }

    /** Opens the gRPC channel and starts the bidirectional stream. */
    connect(): void {
        this._stopped = false;
        void this._connectAsync();
    }

    /** Sends a JSON-RPC message to the gRPC server. */
    send(data: string): void {
        if (!this._open || !this._stream) return;
        this._stream.write({ payload: data } satisfies McpMessage);
    }

    /** Gracefully closes the stream and channel. */
    close(): void {
        this._stopped = true;
        this._teardown();
    }

    // ── Internal ─────────────────────────────────────────────────────────

    private async _connectAsync(): Promise<void> {
        try {
            const Ctor = await loadProto();
            const creds = this._config.useTls ? grpc.credentials.createSsl(this._config.rootCerts) : grpc.credentials.createInsecure();

            this._client = new Ctor(this._address, creds);

            const deadline = new Date(Date.now() + 10_000);
            this._client.waitForReady(deadline, (err) => {
                if (err) {
                    this.onError?.(new Error(`GrpcUpstream "${this.name}": channel not ready — ${err.message}`));
                    this._scheduleReconnect();
                    return;
                }
                this._openStream();
            });
        } catch (err) {
            this.onError?.(new Error(`GrpcUpstream "${this.name}": failed to load proto — ${err}`));
        }
    }

    private _openStream(): void {
        if (!this._client) return;

        const stream = this._client.Channel();
        this._stream = stream;
        this._open = true;
        this._reconnectAttempts = 0;
        this.onOpen?.();

        stream.on("data", (msg: McpMessage) => {
            if (msg.payload) this.onMessage?.(msg.payload);
        });

        stream.on("error", (err: Error) => {
            this.onError?.(new Error(`GrpcUpstream "${this.name}": stream error — ${err.message}`));
        });

        stream.on("end", () => {
            this._open = false;
            this._stream = null;
            this.onClose?.();
            if (!this._stopped) this._scheduleReconnect();
        });
    }

    private _teardown(): void {
        this._open = false;
        if (this._stream) {
            this._stream.end();
            this._stream = null;
        }
        if (this._client) {
            this._client.close();
            this._client = null;
        }
    }

    private _scheduleReconnect(): void {
        const delay = reconnectDelay(this._reconnectAttempts);
        this._reconnectAttempts++;
        setTimeout(() => {
            if (!this._stopped) {
                this._teardown();
                void this._connectAsync();
            }
        }, delay);
    }
}
