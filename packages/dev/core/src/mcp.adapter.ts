import { createEventEmitter, IEventEmitter, IEventSource, IMcpBehaviorAdapter, McpResourceContent, McpToolResult } from "./interfaces";

export abstract class McpAdapterBase implements IMcpBehaviorAdapter {
    private _domain: string;
    private _onResourceContentChanged?: IEventEmitter<string>;
    private _onResourcesChanged?: IEventEmitter<void>;

    constructor(domain: string) {
        this._domain = domain;
    }

    public get domain(): string {
        return this._domain;
    }

    public get onResourceContentChanged(): IEventSource<string> {
        if (!this._onResourceContentChanged) {
            this._onResourceContentChanged = createEventEmitter<string>();
        }
        return this._onResourceContentChanged;
    }

    public get onResourcesChanged(): IEventSource<void> {
        if (!this._onResourcesChanged) {
            this._onResourcesChanged = createEventEmitter<void>();
        }
        return this._onResourcesChanged;
    }

    public dispose(): void {
        this._onResourceContentChanged?.clear();
        this._onResourceContentChanged = undefined;
        this._onResourcesChanged?.clear();
        this._onResourcesChanged = undefined;
    }

    protected _forwardResourceChanged() {
        this._onResourcesChanged?.emit();
    }

    protected _forwardResourceContentChanged(uri: string) {
        this._onResourceContentChanged?.emit(uri);
    }

    public abstract readResourceAsync(uri: string): Promise<McpResourceContent | undefined>;
    public abstract executeToolAsync(uri: string, toolName: string, args: Record<string, unknown>): Promise<McpToolResult>;
}
