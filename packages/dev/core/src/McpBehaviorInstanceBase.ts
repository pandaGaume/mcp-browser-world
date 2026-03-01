/* eslint-disable @typescript-eslint/no-explicit-any */
import type { IMcpBehaviorInstance, McpResource, McpResourceContent, McpTool } from "./interfaces";

export abstract class McpBehaviorInstanceBase<T> implements IMcpBehaviorInstance<T> {
    private _target: T;
    private _uri: string;

    constructor(target: T, uri: string) {
        this._target = target;
        this._uri = uri;
    }

    public get target(): T {
        return this._target;
    }

    public get uri(): string {
        return this._uri;
    }

    /**
     * Returns the resource metadata for this instance.
     * Might be implemented by subclasses to provide meaningful metadata.
     * Cached as part of the instance metadata in the MCP server and returned in `resources/list` responses.
     * We decided to put this on the instance rather than the behavior because of the capability of override.
     */
    public getResource(): McpResource | undefined {
        return undefined;
    }

    public readResourceAsync(): Promise<McpResourceContent | undefined> {
        return Promise.resolve(undefined);
    }

    public getTools(): McpTool[] {
        return [];
    }

    public callTool(_name: string, _args: unknown): Promise<unknown> {
        return Promise.resolve(undefined);
    }
}
