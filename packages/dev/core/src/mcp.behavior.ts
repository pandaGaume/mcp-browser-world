/* eslint-disable @typescript-eslint/no-explicit-any */
import { IMcpBehaviorAdapter, McpResource, McpResourceContent, McpResourceTemplate, McpTool, McpToolResult } from "./interfaces";
import { McpBehaviorBase, McpBehaviorOptions } from "./mcp.behaviorBase";

export abstract class McpBehavior extends McpBehaviorBase {
    private _resourceCache?: McpResource[];
    private _resourceTemplateCache?: McpResourceTemplate[];
    private _resourceContentCache = new Map<string, McpResourceContent>();
    private _resourceContentPromiseCache = new Map<string, Promise<McpResourceContent | undefined>>();
    private _toolsCache?: McpTool[];
    private _adapter: IMcpBehaviorAdapter;

    public constructor(adapter: IMcpBehaviorAdapter, options: McpBehaviorOptions) {
        super(options);
        this._adapter = adapter;
    }

    protected get adapter(): IMcpBehaviorAdapter {
        return this._adapter;
    }

    public override getResources(): McpResource[] {
        if (this._resourceCache) {
            return this._resourceCache;
        }
        this._resourceCache = this._buildResources();
        return this._resourceCache;
    }

    public override getResourceTemplates(): McpResourceTemplate[] {
        if (this._resourceTemplateCache) {
            return this._resourceTemplateCache;
        }
        this._resourceTemplateCache = this._buildTemplate();
        return this._resourceTemplateCache;
    }

    public override getTools(): McpTool[] {
        if (this._toolsCache) {
            return this._toolsCache;
        }
        this._toolsCache = this._buildTools();
        return this._toolsCache;
    }

    public override async readResourceAsync(uri: string): Promise<McpResourceContent | undefined> {
        // behavior root uri — build own resource content (cached)
        const rootUri = this.getResources()[0]?.uri;
        if (uri === rootUri) {
            if (this._resourceContentCache.has(uri)) {
                return this._resourceContentCache.get(uri)!;
            }

            // coalesce concurrent requests for the same uri into one promise
            if (this._resourceContentPromiseCache.has(uri)) {
                return this._resourceContentPromiseCache.get(uri)!;
            }

            const promise = this._buildResourceContentAsync(uri).then((content) => {
                if (content) {
                    this._resourceContentCache.set(uri, content);
                }
                this._resourceContentPromiseCache.delete(uri);
                return content;
            });

            this._resourceContentPromiseCache.set(uri, promise);
            return promise;
        }

        // specific instance uri — delegate to adapter
        return this._adapter.readResourceAsync(uri);
    }

    public override async executeToolAsync(uri: string, toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
        return this._adapter.executeToolAsync(uri, toolName, args);
    }

    protected _buildResources(): McpResource[] {
        return [];
    }

    protected _buildTemplate(): McpResourceTemplate[] {
        return [];
    }

    protected async _buildResourceContentAsync(uri: string): Promise<McpResourceContent | undefined> {
        return await this.adapter.readResourceAsync(uri);
    }

    protected _buildTools(): McpTool[] {
        return [];
    }
}
