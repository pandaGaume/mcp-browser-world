import { IMcpBehaviorAdapter, McpBehavior, McpBehaviorOptions, McpResource, McpResourceContent, McpToolMethod, McpToolResult } from "@dev/core";

export class McpCameraBehavior extends McpBehavior {
    private _baseUri: string;

    public constructor(adapter: IMcpBehaviorAdapter, options: McpBehaviorOptions) {
        const baseUri = `${options.namespace}://scene`;
        options.uriTemplate = options.uriTemplate ?? `${baseUri}/{cameraName}`;
        super(adapter, options);
        this._baseUri = baseUri;
    }

    @McpToolMethod({
        name: "camera.setTarget",
        description: "Sets the camera look-at point (world space) by calling TargetCamera.setTarget(Vector3).",
        inputSchema: {
            type: "object",
            properties: {
                uri: { type: "string", description: "Camera URI e.g. camera://scene/MyCamera" },
                target: {
                    type: "object",
                    description: "World-space point to look at. WebGL right-handed system, y-axis up.",
                    properties: {
                        x: { type: "number" },
                        y: { type: "number" },
                        z: { type: "number" },
                    },
                    required: ["x", "y", "z"],
                    additionalProperties: false,
                },
            },
            required: ["uri", "target"],
            additionalProperties: false,
        },
    })
    public async setTarget(args: { uri: string; target: { x: number; y: number; z: number } }): Promise<McpToolResult> {
        // decorated methods delegate to the adapter — BJS mutation lives there
        return this.adapter.executeToolAsync("camera.setTarget", args.uri, { target: args.target });
    }

    protected override _buildResources(): McpResource[] {
        return [
            {
                uri: this._baseUri, // e.g. camera://scene
                name: "Scene Cameras",
                description: "Cameras available in the active Babylon.js scene",
                mimeType: "application/json",
            },
            {
                uri: this.uriTemplate ?? `${this._baseUri}/{cameraName}`,
                name: "Camera Instance",
                description: "Individual camera in the scene, identified by name",
                mimeType: "application/json",
            },
        ];
    }

    protected override async _buildResourceContentAsync(uri: string): Promise<McpResourceContent | undefined> {
        if (uri.startsWith(this._baseUri)) {
            // delegate to adapter to read live camera data from the scene
            // e.g. camera://scene -> [{ name: "MainCamera", position: {x,y,z}, ... }, { name: "SecondaryCamera", ... }, ...]
            // e.g. camera://scene/MainCamera -> { name: "MainCamera", position: {x,y,z}, ... }
            // adapter returns MCP-serialized content matching the resource's advertised mimeType
            const content = await this.adapter.readResourceAsync(uri);
            return content;
        }
        return undefined;
    }
}
