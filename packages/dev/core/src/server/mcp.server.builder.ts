import type { IMcpBehavior, IMcpInitializer, IMcpServer, IMcpServerBuilder, IMcpServerHandlers, IMcpServerOptions } from "../interfaces";
import { McpServer } from "./mcp.server";

/**
 * Fluent builder that constructs a configured {@link McpServer}.
 *
 * @example
 * ```typescript
 * const server = new McpServerBuilder()
 *     .withName("babylon-scene")
 *     .withWsUrl("ws://localhost:8080")
 *     .withInitializer(new SceneInitializer())
 *     .withBehavior(new MeshBehavior(), new LightBehavior())
 *     .withOptions({ idleTimeoutMs: 30_000, reconnect: { baseDelayMs: 1_000, maxDelayMs: 30_000 } })
 *     .build();
 *
 * await server.start();
 * server.attach(heroMesh, meshBehavior);
 * ```
 */
export class McpServerBuilder implements IMcpServerBuilder {
    private _name = "mcp-server";
    private _wsUrl = "";
    private _initializer: IMcpInitializer | undefined;
    private _handlers: IMcpServerHandlers | undefined;
    private _behaviors: IMcpBehavior[] = [];
    private _options: IMcpServerOptions = {};

    /** Sets the human-readable name reported in `initialize` responses. */
    withName(name: string): this {
        this._name = name;
        return this;
    }

    /** Sets the WebSocket tunnel URL the server will connect to on {@link IMcpServer.start}. */
    withWsUrl(url: string): this {
        this._wsUrl = url;
        return this;
    }

    /**
     * Provides the domain-level initializer that supplies server identity and
     * protocol version during the MCP handshake.
     * If omitted, the server uses built-in defaults.
     */
    withInitializer(initializer: IMcpInitializer): this {
        this._initializer = initializer;
        return this;
    }

    /**
     * Registers one or more behavior types.
     * Accepts multiple behaviors in a single call for convenience.
     * Behaviors contribute to the advertised capabilities and enable {@link IMcpServer.attach}.
     */
    register(...behavior: IMcpBehavior[]): this {
        this._behaviors.push(...(behavior as IMcpBehavior[]));
        return this;
    }

    /**
     * Replaces the default JSON-RPC message routing with a custom handler implementation.
     * When omitted, {@link McpServer} handles routing itself using its built-in logic.
     *
     * Use this to intercept specific MCP methods, add logging, or delegate to a
     * completely different routing strategy.
     */
    withHandlers(handlers: IMcpServerHandlers): this {
        this._handlers = handlers;
        return this;
    }

    /**
     * Merges the given options with any previously set options.
     * Later calls override earlier ones for the same key.
     */
    withOptions(o: IMcpServerOptions): this {
        this._options = { ...this._options, ...o };
        return this;
    }

    /**
     * Constructs and returns a configured {@link IMcpServer}.
     * @throws {Error} if `withWsUrl()` was not called.
     */
    build(): IMcpServer {
        if (!this._wsUrl) throw new Error("McpServerBuilder: withWsUrl() is required before build()");

        const server = new McpServer(this._name, this._wsUrl, this._options, this._initializer, this._handlers);

        for (const behavior of this._behaviors) {
            server.register(behavior);
        }

        return server;
    }
}
