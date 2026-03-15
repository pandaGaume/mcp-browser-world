import type { IMessageTransport } from "./transport.interfaces.js";
import * as grpc from "@grpc/grpc-js";
import {
    type McpMessage,
    getMcpTransportService,
    createInsecureServerCredentials,
} from "./grpc.helpers.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface GrpcServerOptions {
    /** Server credentials. Defaults to insecure (no TLS). */
    credentials?: grpc.ServerCredentials;
    /** gRPC server options (max message size, etc.). */
    serverOptions?: Record<string, string | number>;
}

// ---------------------------------------------------------------------------
// GrpcServerTransport
// ---------------------------------------------------------------------------

/**
 * Server-side gRPC transport — starts a gRPC server exposing the
 * `mcp.McpTransport` service and accepts one bidirectional streaming
 * connection at a time.
 *
 * This is the inverse of {@link GrpcTransport}: external clients (Python,
 * Ray, etc.) connect *to* this server to exchange MCP JSON-RPC messages.
 *
 * ```typescript
 * const transport = new GrpcServerTransport(50051);
 * transport.onOpen = () => console.log("client connected");
 * transport.onMessage = (data) => handleJsonRpc(data);
 * await transport.listen();
 * ```
 */
export class GrpcServerTransport implements IMessageTransport {
    private readonly _port: number;
    private readonly _options: GrpcServerOptions;

    private _server: grpc.Server | null = null;
    private _stream: grpc.ServerDuplexStream<McpMessage, McpMessage> | null = null;
    private _open = false;

    onMessage: ((data: string) => void) | null = null;
    onOpen: (() => void) | null = null;
    onClose: (() => void) | null = null;
    onError: ((error: Error) => void) | null = null;

    constructor(port: number, options?: GrpcServerOptions) {
        this._port = port;
        this._options = options ?? {};
    }

    get isOpen(): boolean {
        return this._open;
    }

    /**
     * Starts the gRPC server and begins listening for incoming `Channel()` calls.
     * The promise resolves once the server is bound and listening.
     */
    async listen(): Promise<void> {
        const service = await getMcpTransportService();
        this._server = new grpc.Server(this._options.serverOptions);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const implementation: Record<string, any> = {
            Channel: (stream: grpc.ServerDuplexStream<McpMessage, McpMessage>) => {
                // Only accept one active connection; reject if already occupied.
                if (this._open && this._stream) {
                    stream.destroy(new Error("GrpcServerTransport: another client is already connected"));
                    return;
                }

                this._stream = stream;
                this._open = true;
                this.onOpen?.();

                stream.on("data", (msg: McpMessage) => {
                    if (msg.payload) {
                        this.onMessage?.(msg.payload);
                    }
                });

                stream.on("error", (err: Error) => {
                    this.onError?.(new Error(`GrpcServerTransport: stream error — ${err.message}`));
                });

                stream.on("end", () => {
                    this._open = false;
                    this._stream = null;
                    this.onClose?.();
                });
            },
        };

        this._server.addService(service, implementation);

        const credentials = this._options.credentials ?? createInsecureServerCredentials();

        return new Promise<void>((resolve, reject) => {
            this._server!.bindAsync(`0.0.0.0:${this._port}`, credentials, (err) => {
                if (err) {
                    reject(new Error(`GrpcServerTransport: bind failed on port ${this._port} — ${err.message}`));
                    return;
                }
                resolve();
            });
        });
    }

    /**
     * Alias for `listen()` cast as a fire-and-forget call.
     * Allows McpServer/McpClient to activate this transport via duck-typing.
     */
    connect(): void {
        void this.listen();
    }

    send(data: string): void {
        if (!this._open || !this._stream) return;
        const msg: McpMessage = { payload: data };
        this._stream.write(msg);
    }

    close(): void {
        this._open = false;
        if (this._stream) {
            this._stream.end();
            this._stream = null;
        }
        if (this._server) {
            this._server.forceShutdown();
            this._server = null;
        }
    }
}
