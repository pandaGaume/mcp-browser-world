import type { IMessageTransport } from "./transport.interfaces.js";
import {
    type McpMultiplexChannelCall,
    type McpEnvelope,
    type GrpcMultiplexServiceClient,
    getMcpMultiplexTransportClient,
    createInsecureCredentials,
    createSslCredentials,
    reconnectDelay,
} from "./grpc.helpers.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface GrpcMultiplexTransportOptions {
    useTls?: boolean;
    rootCerts?: Buffer;
    privateKey?: Buffer;
    certChain?: Buffer;
    channelOptions?: Record<string, string | number>;
}

// ---------------------------------------------------------------------------
// GrpcMultiplexChannel — shared gRPC channel singleton (internal)
// ---------------------------------------------------------------------------

/**
 * Manages a single gRPC bidirectional stream shared by multiple
 * {@link GrpcMultiplexTransport} instances. Messages are routed via
 * the `{ provider, payload }` envelope — same semantics as
 * {@link MultiplexSocket} from `@dev/core` but over gRPC.
 *
 * Reconnection is handled centrally here.
 */
class GrpcMultiplexChannel {
    private static readonly _instances = new Map<string, GrpcMultiplexChannel>();

    private readonly _address: string;
    private readonly _options: GrpcMultiplexTransportOptions;
    private readonly _transports = new Map<string, GrpcMultiplexTransport>();

    private _client: InstanceType<GrpcMultiplexServiceClient> | null = null;
    private _stream: McpMultiplexChannelCall | null = null;
    private _open = false;
    private _stopped = false;
    private _reconnectAttempts = 0;

    private constructor(address: string, options: GrpcMultiplexTransportOptions) {
        this._address = address;
        this._options = options;
    }

    /** Returns (or creates) the singleton channel for a given address. */
    static getOrCreate(host: string, port: number, options?: GrpcMultiplexTransportOptions): GrpcMultiplexChannel {
        const address = `${host}:${port}`;
        let instance = GrpcMultiplexChannel._instances.get(address);
        if (!instance) {
            instance = new GrpcMultiplexChannel(address, options ?? {});
            GrpcMultiplexChannel._instances.set(address, instance);
        }
        return instance;
    }

    get isOpen(): boolean {
        return this._open;
    }

    // ── Registration ────────────────────────────────────────────────────

    register(name: string, transport: GrpcMultiplexTransport): void {
        this._transports.set(name, transport);

        if (this._open) {
            this._announceProvider(name);
            transport.onOpen?.();
        } else if (!this._client) {
            this._stopped = false;
            void this._connectAsync();
        }
    }

    unregister(name: string): void {
        this._transports.delete(name);

        if (this._transports.size === 0) {
            this._stopped = true;
            this._teardown();
            GrpcMultiplexChannel._instances.delete(this._address);
        }
    }

    send(provider: string, data: string): void {
        if (!this._open || !this._stream) return;
        const envelope: McpEnvelope = { provider, payload: data };
        this._stream.write(envelope);
    }

    // ── Connection lifecycle ────────────────────────────────────────────

    private async _connectAsync(): Promise<void> {
        try {
            const ClientCtor = await getMcpMultiplexTransportClient();
            const credentials = this._options.useTls
                ? createSslCredentials(this._options.rootCerts, this._options.privateKey, this._options.certChain)
                : createInsecureCredentials();

            this._client = new ClientCtor(this._address, credentials, this._options.channelOptions);

            const deadline = new Date(Date.now() + 10_000);
            this._client.waitForReady(deadline, (err) => {
                if (err) {
                    for (const transport of this._transports.values()) {
                        transport.onError?.(new Error(`GrpcMultiplexChannel: channel not ready — ${err.message}`));
                    }
                    this._scheduleReconnect();
                    return;
                }
                this._openStream();
            });
        } catch (err) {
            for (const transport of this._transports.values()) {
                transport.onError?.(new Error(`GrpcMultiplexChannel: failed to load proto — ${err}`));
            }
        }
    }

    private _openStream(): void {
        if (!this._client) return;

        const stream = this._client.Channel();
        this._stream = stream;
        this._open = true;
        this._reconnectAttempts = 0;

        for (const name of this._transports.keys()) {
            this._announceProvider(name);
        }
        for (const transport of this._transports.values()) {
            transport.onOpen?.();
        }

        stream.on("data", (envelope: McpEnvelope) => {
            if (!envelope.provider || !envelope.payload) return;
            const transport = this._transports.get(envelope.provider);
            transport?.onMessage?.(envelope.payload);
        });

        stream.on("error", (err: Error) => {
            for (const transport of this._transports.values()) {
                transport.onError?.(new Error(`GrpcMultiplexChannel: stream error — ${err.message}`));
            }
        });

        stream.on("end", () => {
            this._open = false;
            this._stream = null;
            for (const transport of this._transports.values()) {
                transport.onClose?.();
            }
            if (!this._stopped) {
                this._scheduleReconnect();
            }
        });
    }

    private _announceProvider(name: string): void {
        if (!this._open || !this._stream) return;
        const envelope: McpEnvelope = {
            provider: name,
            payload: JSON.stringify({ jsonrpc: "2.0", method: "notifications/register" }),
        };
        this._stream.write(envelope);
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

// ---------------------------------------------------------------------------
// GrpcMultiplexTransport — per-server transport (public)
// ---------------------------------------------------------------------------

/**
 * A transport that multiplexes multiple MCP servers over a single shared
 * gRPC bidirectional stream using the `{ provider, payload }` envelope.
 *
 * Mirrors {@link MultiplexTransport} from `@dev/core` but over gRPC.
 *
 * ```typescript
 * const t1 = GrpcMultiplexTransport.create("scene-1", "localhost", 50051);
 * const t2 = GrpcMultiplexTransport.create("scene-2", "localhost", 50051);
 * // t1 and t2 share a single gRPC channel under the hood.
 * ```
 */
export class GrpcMultiplexTransport implements IMessageTransport {
    private readonly _name: string;
    private readonly _channel: GrpcMultiplexChannel;
    private _registered = false;

    onMessage: ((data: string) => void) | null = null;
    onOpen: (() => void) | null = null;
    onClose: (() => void) | null = null;
    onError: ((error: Error) => void) | null = null;

    constructor(name: string, channel: GrpcMultiplexChannel) {
        this._name = name;
        this._channel = channel;
    }

    static create(name: string, host: string, port: number, options?: GrpcMultiplexTransportOptions): GrpcMultiplexTransport {
        return new GrpcMultiplexTransport(name, GrpcMultiplexChannel.getOrCreate(host, port, options));
    }

    get isOpen(): boolean {
        return this._channel.isOpen;
    }

    /**
     * Activates this transport by registering with the shared channel.
     * Also exposed as `connect()` so McpServer/McpClient can activate it
     * via duck-typing without needing `instanceof` checks on this class.
     */
    connect(): void {
        this.activate();
    }

    activate(): void {
        if (!this._registered) {
            this._registered = true;
            this._channel.register(this._name, this);
        }
    }

    send(data: string): void {
        this._channel.send(this._name, data);
    }

    close(): void {
        if (this._registered) {
            this._registered = false;
            this._channel.unregister(this._name);
        }
    }
}
