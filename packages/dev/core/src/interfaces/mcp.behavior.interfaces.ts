import type { McpResource, McpResourceContent, McpTool } from "./mcp.core.interfaces";

export interface IMcpBehaviorOperations {
    /** Returns the resource metadata (name, mimeType, description) for this instance. */
    getResource(): McpResource | undefined;

    /** Returns the current state of this object serialized as resource content. */
    readResourceAsync(): Promise<McpResourceContent | undefined>;

    /**
     * Returns the tools exposed by this instance.
     * Tool names must be prefixed with the behavior namespace,
     * e.g. `"mesh.getPosition"`, `"mesh.setPosition"`.
     */
    getTools(): McpTool[];

    /**
     * Executes a namespaced tool on this instance.
     *
     * @param name - Full namespaced tool name (e.g. `"mesh.setPosition"`).
     * @param args - Tool arguments as described by the tool's `inputSchema`.
     * @returns The tool's result payload.
     */
    callTool(name: string, args: unknown): Promise<unknown>;
}

/**
 * Represents a single object instance registered with the MCP server.
 *
 * An instance is the live, per-object counterpart of an {@link IMcpBehavior}.
 * It simultaneously acts as:
 * - a **resource** — the object's current state, readable via `resources/read`
 * - a **tool executor** — operations the client can invoke on this specific object
 *
 * Created by {@link IMcpBehavior.attach} and managed by {@link IMcpServer}.
 */
export interface IMcpBehaviorInstance<T = unknown> extends IMcpBehaviorOperations {
    /**
     * URI uniquely identifying this instance within the MCP server.
     * Used as the resource identifier and as the routing key for tool calls.
     *
     * Convention: `babylon://<namespace>/<objectName>`
     * e.g. `babylon://mesh/heroMesh`, `babylon://light/sunLight`
     */
    readonly uri: string;
    /**
     * The original object this instance represents.
     */
    target: T;
}

export interface IUriFactory {
    createUri(behavior: IMcpBehavior, target: unknown): string;
}

export interface IMcpBehaviorInstanceFactory<T> {
    createMcpBehaviorInstance(behavior: IMcpBehavior, target: T, uri: string): IMcpBehaviorInstance<T> | undefined;
}

/**
 * Describes a category of object behavior that can be attached to instances.
 *
 * A behavior is the reusable "capability template" for a specific type of object
 * (e.g. `MeshBehavior`, `LightBehavior`, `CameraBehavior`). It knows how to wrap
 * any instance of `T` into an {@link IMcpBehaviorInstance} that exposes that
 * object's state and operations to the MCP client.
 *
 * Multiple instances of the same behavior type can be attached to different objects.
 * Each call to {@link attach} produces an independent {@link IMcpBehaviorInstance}.
 *
 * @template T The type of object this behavior operates on (e.g. `Mesh`, `Light`).
 *
 * @example
 * ```typescript
 * class MeshBehavior implements IMcpBehavior<Mesh> {
 *     readonly namespace = "mesh";
 *
 *     attach(target: Mesh): IMcpBehaviorInstance {
 *         return new MeshBehaviorInstance(target);
 *     }
 * }
 *
 * // Register the behavior type, then attach specific objects:
 * server.registerBehavior(new MeshBehavior());
 * server.attach(heroMesh, meshBehavior);
 * server.attach(groundMesh, meshBehavior);
 * ```
 */
export interface IMcpBehavior<T = unknown> {
    /**
     * Unique namespace for this behavior's tools.
     * Prefixed to all tool names to avoid collisions across behaviors.
     * e.g. `"mesh"` → tools named `"mesh.getPosition"`, `"mesh.setPosition"`.
     *
     * Must be lowercase, alphanumeric, no spaces.
     */
    readonly namespace: string;

    /** Human-readable name for this behavior category, used in template listings. */
    readonly name?: string;

    /**
     * RFC 6570 URI template describing the resource URIs produced by this behavior.
     * Advertised via `resources/templates/list` so clients can discover the URI
     * scheme and construct valid identifiers without enumerating every instance.
     *
     * @example `"mesh://scene/{meshName}"`
     * @example `"camera://scene/{cameraName}"`
     */
    readonly uriTemplate?: string;

    /** Optional description of what instances of this behavior represent. */
    readonly description?: string;

    /** MIME type of content returned by `resources/read` for instances of this behavior. */
    readonly mimeType?: string;

    /**
     * Wraps a specific object in an {@link IMcpBehaviorInstance}, making it
     * visible to the MCP client as a resource with callable tools.
     *
     * @param target - The object to attach this behavior to.
     * @returns A new instance representing `target` in the MCP server.
     */
    attach(target: T): IMcpBehaviorInstance<T> | undefined;
}
