import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface GrpcClientOptions {
    /** Use TLS for the channel. */
    useTls?: boolean;
    /** PEM root certificates (for server verification). */
    rootCerts?: Buffer;
    /** PEM private key (mutual TLS). */
    privateKey?: Buffer;
    /** PEM certificate chain (mutual TLS). */
    certChain?: Buffer;
    /** Metadata headers sent with every call. */
    metadata?: Record<string, string>;
    /** Low-level gRPC channel options. */
    channelOptions?: Record<string, string | number>;
    /** Override proto-loader options. */
    protoLoaderOptions?: protoLoader.Options;
}

// ---------------------------------------------------------------------------
// GrpcBidiStream
// ---------------------------------------------------------------------------

/**
 * Wrapper around a bidirectional gRPC stream.
 */
export class GrpcBidiStream {
    onMessage: ((data: Record<string, unknown>) => void) | null = null;
    onEnd: (() => void) | null = null;
    onError: ((error: Error) => void) | null = null;

    constructor(private readonly _call: grpc.ClientDuplexStream<unknown, unknown>) {
        this._call.on("data", (data: unknown) => this.onMessage?.(data as Record<string, unknown>));
        this._call.on("end", () => this.onEnd?.());
        this._call.on("error", (err: Error) => this.onError?.(err));
    }

    write(message: Record<string, unknown>): void {
        this._call.write(message);
    }

    end(): void {
        this._call.end();
    }
}

// ---------------------------------------------------------------------------
// GrpcClientStream
// ---------------------------------------------------------------------------

/**
 * Wrapper around a client-streaming gRPC call.
 * Write messages with {@link write}, then call {@link end} to get the response.
 */
export class GrpcClientStream {
    constructor(
        private readonly _call: grpc.ClientWritableStream<unknown>,
        private readonly _result: Promise<Record<string, unknown>>
    ) {}

    write(message: Record<string, unknown>): void {
        this._call.write(message);
    }

    async end(): Promise<Record<string, unknown>> {
        this._call.end();
        return this._result;
    }
}

// ---------------------------------------------------------------------------
// GrpcClient
// ---------------------------------------------------------------------------

/**
 * Generic gRPC client that can load any `.proto` file and call any service.
 *
 * Unlike the MCP-specific transports ({@link GrpcTransport}, etc.), this class
 * does **not** assume the remote server speaks MCP/JSON-RPC. Use it to
 * communicate with LLM inference servers (vLLM, TGI, Ray Serve, etc.) or any
 * other gRPC-compatible backend.
 *
 * @example
 * ```typescript
 * const client = new GrpcClient("localhost", 50051, "./llm.proto");
 * await client.load();
 *
 * // Unary call
 * const result = await client.unary("llm.InferenceService", "Predict", { input: "hello" });
 *
 * // Server-streaming
 * for await (const chunk of client.serverStream("llm.InferenceService", "StreamGenerate", { prompt: "hello" })) {
 *     console.log(chunk);
 * }
 *
 * client.close();
 * ```
 */
export class GrpcClient {
    private readonly _address: string;
    private readonly _protoPath: string;
    private readonly _options: GrpcClientOptions;

    private _grpcObject: grpc.GrpcObject | null = null;
    private _credentials: grpc.ChannelCredentials | null = null;
    private _metadata: grpc.Metadata | null = null;
    private readonly _clients = new Map<string, grpc.Client>();

    constructor(host: string, port: number, protoPath: string, options?: GrpcClientOptions) {
        this._address = `${host}:${port}`;
        this._protoPath = protoPath;
        this._options = options ?? {};
    }

    /**
     * Loads the proto definition and prepares credentials.
     * Must be called before any RPC method.
     */
    async load(): Promise<void> {
        const def = await protoLoader.load(this._protoPath, {
            keepCase: true,
            longs: String,
            enums: String,
            defaults: true,
            oneofs: true,
            ...this._options.protoLoaderOptions,
        });

        this._grpcObject = grpc.loadPackageDefinition(def);

        // Credentials
        const opts = this._options;
        if (opts.useTls) {
            this._credentials = grpc.credentials.createSsl(opts.rootCerts ?? null, opts.privateKey ?? null, opts.certChain ?? null);
        } else {
            this._credentials = grpc.credentials.createInsecure();
        }

        // Default metadata
        if (opts.metadata) {
            this._metadata = new grpc.Metadata();
            for (const [k, v] of Object.entries(opts.metadata)) {
                this._metadata.add(k, v);
            }
        }
    }

    /**
     * Resolves a dotted service path (e.g. `"llm.v1.InferenceService"`) to its
     * gRPC service client constructor.
     */
    private _resolveService(servicePath: string): grpc.ServiceClientConstructor {
        if (!this._grpcObject) throw new Error("Proto not loaded — call load() first");

        const parts = servicePath.split(".");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let current: any = this._grpcObject;

        for (const part of parts) {
            current = current?.[part];
            if (!current) throw new Error(`Service path "${servicePath}" not found (failed at "${part}")`);
        }

        if (typeof current !== "function") {
            throw new Error(`"${servicePath}" is not a service constructor`);
        }

        return current as grpc.ServiceClientConstructor;
    }

    private _getClient(servicePath: string): grpc.Client {
        let client = this._clients.get(servicePath);
        if (!client) {
            const Ctor = this._resolveService(servicePath);
            client = new Ctor(this._address, this._credentials!, this._options.channelOptions ?? {});
            this._clients.set(servicePath, client);
        }
        return client;
    }

    /**
     * Waits until the underlying channel is ready (READY state).
     * Only meaningful after at least one RPC has been initiated or a service
     * has been resolved via {@link getServiceClient}.
     */
    async waitForReady(deadlineMs = 5000): Promise<void> {
        if (this._clients.size === 0) return;
        const client = this._clients.values().next().value!;
        return new Promise((resolve, reject) => {
            const deadline = new Date(Date.now() + deadlineMs);
            client.waitForReady(deadline, (err: Error | null) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    /**
     * Returns the raw gRPC service client for advanced usage.
     * Call methods directly on the returned object using the gRPC-js API.
     */
    getServiceClient(servicePath: string): grpc.Client {
        return this._getClient(servicePath);
    }

    // ----- Unary RPC ---------------------------------------------------------

    /**
     * Makes a unary (request/response) RPC call.
     *
     * @param servicePath  Dotted service path, e.g. `"mypackage.MyService"`.
     * @param method       RPC method name, e.g. `"Predict"`.
     * @param request      Request message fields.
     */
    async unary(servicePath: string, method: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const client = this._getClient(servicePath) as any;
        const fn = client[method];
        if (typeof fn !== "function") throw new Error(`Method "${method}" not found on "${servicePath}"`);

        return new Promise((resolve, reject) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const args: any[] = [request];
            if (this._metadata) args.push(this._metadata);
            args.push((err: grpc.ServiceError | null, response: unknown) => {
                if (err) reject(err);
                else resolve(response as Record<string, unknown>);
            });
            fn.apply(client, args);
        });
    }

    // ----- Server streaming --------------------------------------------------

    /**
     * Starts a server-streaming RPC. Returns an `AsyncIterable` of response
     * messages.
     *
     * @example
     * ```typescript
     * for await (const chunk of client.serverStream("llm.LLM", "StreamGenerate", { prompt: "hi" })) {
     *     process.stdout.write(chunk.text as string);
     * }
     * ```
     */
    serverStream(servicePath: string, method: string, request: Record<string, unknown>): AsyncIterable<Record<string, unknown>> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const client = this._getClient(servicePath) as any;
        const fn = client[method];
        if (typeof fn !== "function") throw new Error(`Method "${method}" not found on "${servicePath}"`);

        const call: grpc.ClientReadableStream<unknown> = this._metadata ? fn.call(client, request, this._metadata) : fn.call(client, request);

        return {
            [Symbol.asyncIterator]() {
                let ended = false;
                let error: Error | null = null;
                const buffer: Record<string, unknown>[] = [];
                let waiting: { resolve: (v: IteratorResult<Record<string, unknown>>) => void; reject: (e: Error) => void } | null = null;

                call.on("data", (data: unknown) => {
                    const msg = data as Record<string, unknown>;
                    if (waiting) {
                        const w = waiting;
                        waiting = null;
                        w.resolve({ value: msg, done: false });
                    } else {
                        buffer.push(msg);
                    }
                });

                call.on("end", () => {
                    ended = true;
                    if (waiting) {
                        const w = waiting;
                        waiting = null;
                        w.resolve({ value: undefined as unknown as Record<string, unknown>, done: true });
                    }
                });

                call.on("error", (err: Error) => {
                    error = err;
                    ended = true;
                    if (waiting) {
                        const w = waiting;
                        waiting = null;
                        w.reject(err);
                    }
                });

                return {
                    next(): Promise<IteratorResult<Record<string, unknown>>> {
                        if (buffer.length > 0) {
                            return Promise.resolve({ value: buffer.shift()!, done: false });
                        }
                        if (error) {
                            return Promise.reject(error);
                        }
                        if (ended) {
                            return Promise.resolve({ value: undefined as unknown as Record<string, unknown>, done: true });
                        }
                        return new Promise((resolve, reject) => {
                            waiting = { resolve, reject };
                        });
                    },
                };
            },
        };
    }

    // ----- Client streaming --------------------------------------------------

    /**
     * Starts a client-streaming RPC. Write messages, then call `end()` to
     * receive the single response.
     */
    clientStream(servicePath: string, method: string): GrpcClientStream {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const client = this._getClient(servicePath) as any;
        const fn = client[method];
        if (typeof fn !== "function") throw new Error(`Method "${method}" not found on "${servicePath}"`);

        let resolveResult!: (value: Record<string, unknown>) => void;
        let rejectResult!: (err: Error) => void;
        const resultPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
            resolveResult = resolve;
            rejectResult = reject;
        });

        const call = this._metadata
            ? fn.call(client, this._metadata, (err: grpc.ServiceError | null, response: unknown) => {
                  if (err) rejectResult(err);
                  else resolveResult(response as Record<string, unknown>);
              })
            : fn.call(client, (err: grpc.ServiceError | null, response: unknown) => {
                  if (err) rejectResult(err);
                  else resolveResult(response as Record<string, unknown>);
              });

        return new GrpcClientStream(call, resultPromise);
    }

    // ----- Bidirectional streaming --------------------------------------------

    /**
     * Starts a bidirectional streaming RPC.
     *
     * @example
     * ```typescript
     * const stream = client.bidiStream("llm.LLM", "Chat");
     * stream.onMessage = (msg) => console.log(msg);
     * stream.write({ message: "Hello" });
     * stream.end();
     * ```
     */
    bidiStream(servicePath: string, method: string): GrpcBidiStream {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const client = this._getClient(servicePath) as any;
        const fn = client[method];
        if (typeof fn !== "function") throw new Error(`Method "${method}" not found on "${servicePath}"`);

        const call = this._metadata ? fn.call(client, this._metadata) : fn.call(client);

        return new GrpcBidiStream(call);
    }

    /** Closes all underlying gRPC channels. */
    close(): void {
        for (const client of this._clients.values()) {
            client.close();
        }
        this._clients.clear();
    }
}
