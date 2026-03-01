import type { IMcpBehavior, McpResource, McpResourceContent, McpTool, McpToolResult } from "./interfaces";
import { McpToolResults } from "./mcp.toolResult";

export type McpBehaviorOptions = {
    namespace: string;
    uriTemplate?: string;
    name?: string;
    description?: string;
    mimeType?: string;
};

export class McpBehaviorOptionsBuilder {
    private _namespace: string;
    private _uriTemplate?: string;
    private _name?: string;
    private _description?: string;
    private _mimeType?: string;

    public constructor(namespace: string) {
        this._namespace = namespace;
    }

    public withUriTemplate(uriTemplate: string): this {
        this._uriTemplate = uriTemplate;
        return this;
    }

    public withName(name: string): this {
        this._name = name;
        return this;
    }

    public withDescription(description: string): this {
        this._description = description;
        return this;
    }

    public withMimeType(mimeType: string): this {
        this._mimeType = mimeType;
        return this;
    }

    public build(): McpBehaviorOptions {
        return {
            namespace: this._namespace,
            uriTemplate: this._uriTemplate,
            name: this._name,
            description: this._description,
            mimeType: this._mimeType,
        };
    }
}

export class McpBehaviorBase implements IMcpBehavior {
    private _namespace: string;
    private _uriTemplate?: string;
    private _name?: string;
    private _description?: string;
    private _mimeType?: string;

    public constructor(options: McpBehaviorOptions) {
        this._namespace = options.namespace;
        this._uriTemplate = options.uriTemplate;
        this._name = options.name;
        this._description = options.description;
        this._mimeType = options.mimeType;
    }

    public get namespace(): string {
        return this._namespace;
    }

    public get uriTemplate(): string | undefined {
        return this._uriTemplate;
    }

    public get name(): string | undefined {
        return this._name;
    }

    public get description(): string | undefined {
        return this._description;
    }

    public get mimeType(): string | undefined {
        return this._mimeType;
    }

    public readResourceAsync(_uri: string): Promise<McpResourceContent | undefined> {
        return Promise.resolve(undefined);
    }

    public executeToolAsync(_uri: string, _toolName: string, _args: Record<string, unknown>): Promise<McpToolResult> {
        return Promise.resolve(McpToolResults.error(`Tool not implemented: ${_toolName}`));
    }

    public getResources(): McpResource[] {
        throw new Error("Method not implemented.");
    }

    public getResourceTemplates(): string[] {
        throw new Error("Method not implemented.");
    }

    public getTools(): McpTool[] {
        throw new Error("Method not implemented.");
    }
}
