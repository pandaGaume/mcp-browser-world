/* eslint-disable @typescript-eslint/no-explicit-any */
import { IMcpBehaviorAdapter, McpResource, McpResourceContent, McpTool, McpToolResult } from "./interfaces";
import { McpBehaviorBase, McpBehaviorOptions } from "./mcp.behaviorBase";
import { McpToolResults } from "./mcp.toolResult";

export type BehaviorCtor = abstract new (...args: unknown[]) => McpBehaviorBase;

export type ToolHandler = (args: unknown) => Promise<unknown> | unknown;

type ToolDef = McpTool & {
    methodKey: string | symbol;
};

const TOOL_DEFS = Symbol("mcp:tool_defs");

function getOrCreateToolDefs(ctor: any): ToolDef[] {
    if (!ctor[TOOL_DEFS]) ctor[TOOL_DEFS] = [] as ToolDef[];
    return ctor[TOOL_DEFS] as ToolDef[];
}

export function McpToolMethod(def: Omit<ToolDef, "methodKey">) {
    return function (target: any, propertyKey: string | symbol, _descriptor: PropertyDescriptor) {
        const ctor = target.constructor;
        const defs = getOrCreateToolDefs(ctor);

        // last one wins if same method is redecorated
        const existingIdx = defs.findIndex((d) => d.methodKey === propertyKey);
        const entry: ToolDef = { ...def, methodKey: propertyKey };
        if (existingIdx >= 0) defs[existingIdx] = entry;
        else defs.push(entry);
    };
}

export abstract class McpBehavior extends McpBehaviorBase {
    private _resourceCache?: McpResource[];
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

    public override getTools(): McpTool[] {
        if (this._toolsCache) {
            return this._toolsCache;
        }
        const defs = this._collectToolDefs();
        const tools = defs.map(({ methodKey: _mk, ...tool }) => tool);
        this._toolsCache = tools;
        return tools;
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
        // verify tool is registered on this behavior
        const defs = this._collectToolDefs();
        const def = defs.find((d) => d.name === toolName);

        if (!def) {
            return McpToolResults.error(`Tool not found: ${toolName}`);
        }

        // if behavior has a method decorated with @McpToolMethod — call it directly
        const method = (this as any)[def.methodKey];
        if (typeof method === "function") {
            try {
                const result = await method.call(this, args);
                return McpToolResults.json(result);
            } catch (err) {
                return McpToolResults.error(err instanceof Error ? err.message : String(err));
            }
        }

        // otherwise delegate to adapter
        return this._adapter.executeToolAsync(toolName, uri, args);
    }

    protected _buildResources(): McpResource[] {
        return [];
    }

    protected _buildResourceContentAsync(_uri: string): Promise<McpResourceContent | undefined> {
        return Promise.resolve(undefined);
    }

    protected _collectToolDefs(): ToolDef[] {
        // Merge decorated methods across inheritance chain, child overrides by name
        const merged = new Map<string, ToolDef>();

        let proto: any = Object.getPrototypeOf(this);
        while (proto && proto.constructor && proto.constructor !== Object) {
            const ctor = proto.constructor;
            const defs: ToolDef[] = (ctor as any)[TOOL_DEFS] ?? [];
            for (const d of defs) {
                merged.set(d.name, d);
            }
            proto = Object.getPrototypeOf(proto);
        }

        return Array.from(merged.values());
    }
}
