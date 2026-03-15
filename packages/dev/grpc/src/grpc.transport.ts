import type { IMessageTransport } from "./transport.interfaces.js";
import * as grpc from "@grpc/grpc-js";
import {
    type McpChannelCall,
    type McpMessage,
    type GrpcServiceClient,
    getMcpTransportClient,
    createInsecureCredentials,
    createSslCredentials,
    reconnectDelay,
} from "./grpc.helpers.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface GrpcTransportOptions {
    /** Use TLS for the channel. Defaults to `false`. */
    useTls?: boolean;
    /** PEM-encoded root certificates (TLS only). */
    rootCerts?: Buffer;
    /** PEM-encoded client private key (mutual TLS). */
    privateKey?: Buffer;
    /** PEM-encoded client certificate chain (mutual TLS). */
    certChain?: Buffer;
    /** Additional gRPC metadata sent with the Channel call. */
    metadata?: Record<string, string>;
    /** gRPC channel options (keep-alive, max message size, etc.). */
    channelOptions?: Record<string, string | number>;
}

// ---------------------------------------------------------------------------
// GrpcTransport
// ---------------------------------------------------------------------------

/**
 * 1:1 gRPC transport — connects to a remote gRPC server exposing the
 * `mcp.McpTransport` service and opens a bidirectional streaming `Channel()`.
 *
 * Mirrors {@link DirectTransport} from `@dev/core` but over gRPC instead of
 * WebSocket. Call {@link connect} after setting event callbacks.
 *
 * ```typescript
 * const transport = new GrpcTransport("localhost", 50051);
 * transport.onOpen = () => console.log("ready");
 * transport.onMessage = (data) => console.log("received", data);
 * transport.connect();
 * ```
 */
export class GrpcTransport implements IMessageTransport {
    private readonly _host: string;
    private readonly _port: number;
    private readonly _options: GrpcTransportOptions;

    private _client: InstanceType<GrpcServiceClient> | null = null;
    private _stream: McpChannelCall | null = null;
    private _open = false;
    private _stopped = false;
    private _reconnectAttempts = 0;

    onMessage: ((data: string) => void) | null = null;
    onOpen: (() => void) | null = null;
    onClose: (() => void) | null = null;
    onError: ((error: Error) => void) | null = null;

    constructor(host: string, port: number, options?: GrpcTransportOptions) {
        this._host = host;
        this._port = port;
        this._options = options ?? {};
    }

    get isOpen(): boolean {
        return this._open;
    }

    /**
     * Opens the gRPC channel and starts the bidirectional stream.
     * Must be called after assigning `onOpen` / `onMessage` / etc.
     */
    connect(): void {
        this._stopped = false;
        void this._connectAsync();
    }

    send(data: string): void {
        if (!this._open || !this._stream) return;
        const msg: McpMessage = { payload: data };
        this._stream.write(msg);
    }

    close(): void {
        this._stopped = true;
        this._teardown();
    }

    // ── Internal ─────────────────────────────────────────────────────────

    private async _connectAsync(): Promise<void> {
        try {
            const ClientCtor = await getMcpTransportClient();
            const address = `${this._host}:${this._port}`;
            const credentials = this._options.useTls
                ? createSslCredentials(this._options.rootCerts, this._options.privateKey, this._options.certChain)
                : createInsecureCredentials();

            this._client = new ClientCtor(address, credentials, this._options.channelOptions);

            // Wait for the channel to be ready before opening the stream.
            const deadline = new Date(Date.now() + 10_000);
            this._client.waitForReady(deadline, (err) => {
                if (err) {
                    this.onError?.(new Error(`GrpcTransport: channel not ready — ${err.message}`));
                    this._scheduleReconnect();
                    return;
                }
                this._openStream();
            });
        } catch (err) {
            this.onError?.(new Error(`GrpcTransport: failed to load proto — ${err}`));
        }
    }

    private _openStream(): void {
        if (!this._client) return;

        const metadata = new grpc.Metadata();
        if (this._options.metadata) {
            for (const [key, value] of Object.entries(this._options.metadata)) {
                metadata.add(key, value);
            }
        }

        const stream = this._client.Channel();
        this._stream = stream;
        this._open = true;
        this._reconnectAttempts = 0;
        this.onOpen?.();

        stream.on("data", (msg: McpMessage) => {
            if (msg.payload) {
                this.onMessage?.(msg.payload);
            }
        });

        stream.on("error", (err: Error) => {
            this.onError?.(new Error(`GrpcTransport: stream error — ${err.message}`));
        });

        stream.on("end", () => {
            this._open = false;
            this._stream = null;
            this.onClose?.();
            if (!this._stopped) {
                this._scheduleReconnect();
            }
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
