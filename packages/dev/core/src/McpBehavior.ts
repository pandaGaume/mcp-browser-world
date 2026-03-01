import type { IMcpBehavior, IMcpBehaviorInstance, IMcpBehaviorInstanceFactory, IUriFactory } from "./interfaces";

export class McpBehaviorBuilder<T> {
    private _namespace: string;
    private _uriTemplate?: string;
    private _name?: string;
    private _description?: string;
    private _mimeType?: string;
    private _uriFactory?: IUriFactory;
    private _instanceFactory?: IMcpBehaviorInstanceFactory<T>;

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
    public withUriFactory(uriFactory: IUriFactory): this {
        this._uriFactory = uriFactory;
        return this;
    }

    public withInstanceFactory(instanceFactory: IMcpBehaviorInstanceFactory<T>): this {
        this._instanceFactory = instanceFactory;
        return this;
    }

    public build(): IMcpBehavior<T> {
        return new McpBehavior<T>({
            namespace: this._namespace,
            uriTemplate: this._uriTemplate,
            name: this._name,
            description: this._description,
            mimeType: this._mimeType,
            uriFactory: this._uriFactory,
            instanceFactory: this._instanceFactory,
        });
    }
}

export class McpBehavior<T> implements IMcpBehavior<T>, IUriFactory, IMcpBehaviorInstanceFactory<T> {
    private _namespace: string;
    private _uriTemplate?: string;
    private _name?: string;
    private _description?: string;
    private _mimeType?: string;
    private _uriFactory: IUriFactory;
    private _instanceFactory: IMcpBehaviorInstanceFactory<T>;

    public constructor(options: {
        namespace: string;
        uriTemplate?: string;
        name?: string;
        description?: string;
        mimeType?: string;
        uriFactory?: IUriFactory;
        instanceFactory?: IMcpBehaviorInstanceFactory<T>;
    }) {
        this._namespace = options.namespace;
        this._uriTemplate = options.uriTemplate;
        this._name = options.name;
        this._description = options.description;
        this._mimeType = options.mimeType;
        this._uriFactory = options.uriFactory ?? this;
        this._instanceFactory = options.instanceFactory ?? this;
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

    public attach(target: T): IMcpBehaviorInstance<T> | undefined {
        return this._instanceFactory.createMcpBehaviorInstance(this, target, this._uriFactory.createUri(this, target));
    }

    public createUri(behavior: IMcpBehavior<T>, _target: T): string {
        // Simple default URI generation using namespace and a random ID.
        // Can be overridden by subclasses for more meaningful URIs.
        const id = Math.random().toString(36).substr(2, 9);
        return `${behavior.namespace}://${id}`;
    }

    public createMcpBehaviorInstance(_behavior: IMcpBehavior, _target: T, _uri: string): IMcpBehaviorInstance<T> | undefined {
        throw new Error("No instance factory provided for this behavior");
    }
}
