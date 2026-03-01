/* eslint-disable @typescript-eslint/no-explicit-any */
import type { McpResource, McpResourceContent, McpTool } from "./interfaces";
import { McpBehaviorInstanceBase } from "./McpBehaviorInstanceBase";

type BehaviorCtor = abstract new (...args: unknown[]) => McpBehaviorInstanceBase<unknown>;

type ToolHandler = (args: unknown) => Promise<unknown> | unknown;

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

export abstract class CachedMcpBehaviorInstanceBase<T> extends McpBehaviorInstanceBase<T> {
    private static resourceCache = new Map<BehaviorCtor, McpResource | undefined>();
    private static resourceContentCache = new Map<BehaviorCtor, McpResourceContent | undefined>();
    private static resourceContentPromiseCache = new Map<BehaviorCtor, Promise<McpResourceContent | undefined>>();
    private static toolsCache = new Map<BehaviorCtor, McpTool[]>();

    public static ClearAllCachesFor(ctor: BehaviorCtor): void {
        CachedMcpBehaviorInstanceBase.clearResourceCacheFor(ctor);
        CachedMcpBehaviorInstanceBase.clearToolsCacheFor(ctor);
        CachedMcpBehaviorInstanceBase.clearResourceCacheContentFor(ctor);
    }

    public static ClearAllCaches(): void {
        CachedMcpBehaviorInstanceBase.resourceCache.clear();
        CachedMcpBehaviorInstanceBase.toolsCache.clear();
        CachedMcpBehaviorInstanceBase.resourceContentCache.clear();
        CachedMcpBehaviorInstanceBase.resourceContentPromiseCache.clear();
    }

    public static clearResourceCacheFor(ctor: BehaviorCtor): void {
        CachedMcpBehaviorInstanceBase.resourceCache.delete(ctor);
    }

    public static clearAllResourceCaches(): void {
        CachedMcpBehaviorInstanceBase.resourceCache.clear();
    }

    public static clearResourceCacheContentFor(ctor: BehaviorCtor): void {
        CachedMcpBehaviorInstanceBase.resourceContentCache.delete(ctor);
        CachedMcpBehaviorInstanceBase.resourceContentPromiseCache.delete(ctor);
    }

    public static clearAllResourceCacheContents(): void {
        CachedMcpBehaviorInstanceBase.resourceContentCache.clear();
        CachedMcpBehaviorInstanceBase.resourceContentPromiseCache.clear();
    }

    public static clearToolsCacheFor(ctor: BehaviorCtor): void {
        CachedMcpBehaviorInstanceBase.toolsCache.delete(ctor);
    }

    public static clearAllToolsCaches(): void {
        CachedMcpBehaviorInstanceBase.toolsCache.clear();
    }

    public constructor(target: T, uri: string) {
        super(target, uri);
    }

    public override getResource(): McpResource | undefined {
        const ctor = this.constructor as unknown as BehaviorCtor;

        const cached = CachedMcpBehaviorInstanceBase.resourceCache.get(ctor);
        if (CachedMcpBehaviorInstanceBase.resourceCache.has(ctor)) {
            return cached;
        }

        const res = this._buildResource();
        CachedMcpBehaviorInstanceBase.resourceCache.set(ctor, res);
        return res;
    }

    public override readResourceAsync(): Promise<McpResourceContent | undefined> {
        const ctor = this.constructor as unknown as BehaviorCtor;

        // 1) if content already cached, return it
        if (CachedMcpBehaviorInstanceBase.resourceContentCache.has(ctor)) {
            return Promise.resolve(CachedMcpBehaviorInstanceBase.resourceContentCache.get(ctor));
        }

        // 2) if build is in progress, return the existing promise
        const existingPromise = CachedMcpBehaviorInstanceBase.resourceContentPromiseCache.get(ctor);
        if (existingPromise) return existingPromise;

        // 3) else build content and cache promise immediately to prevent duplicate builds in case of concurrent calls
        const p = this._buildResourceContentAsync()
            .then((content: any) => {
                CachedMcpBehaviorInstanceBase.resourceContentCache.set(ctor, content);
                return content;
            })
            .catch((err: any) => {
                // if build fails, remove the promise from cache so that future calls can retry
                CachedMcpBehaviorInstanceBase.resourceContentPromiseCache.delete(ctor);
                throw err;
            });

        CachedMcpBehaviorInstanceBase.resourceContentPromiseCache.set(ctor, p);
        return p;
    }

    public override getTools(): McpTool[] {
        const ctor = this.constructor as unknown as BehaviorCtor;

        const cached = CachedMcpBehaviorInstanceBase.toolsCache.get(ctor);
        if (cached) return cached;

        const defs = this._collectToolDefs();
        const tools = defs.map(({ methodKey: _mk, ...tool }) => tool);
        CachedMcpBehaviorInstanceBase.toolsCache.set(ctor, tools);
        return tools;
    }

    public override async callTool(name: string, args: unknown): Promise<unknown> {
        const def = this._collectToolDefs().find((d) => d.name === name);
        if (!def) {
            throw new Error(`Unknown tool: ${name}`);
        }

        const fn = (this as any)[def.methodKey] as ToolHandler;
        if (typeof fn !== "function") {
            throw new Error(`Tool handler is not a function: ${String(def.methodKey)}`);
        }

        return await fn.call(this, args);
    }

    protected _buildResource(): McpResource | undefined {
        return super.getResource();
    }

    protected _buildResourceContentAsync(): Promise<McpResourceContent | undefined> {
        return super.readResourceAsync();
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
