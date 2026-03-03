import { IMcpBehaviorAdapter, JsonRpcMimeType, McpBehavior, McpBehaviorOptions, McpResource, McpResourceTemplate, McpTool } from "@dev/core";
import { McpCameraNamespace } from "../mcp.commons";

export class McpCameraBehavior extends McpBehavior {
    public static CameraSetTargetFn = "camera.setTarget";

    public constructor(adapter: IMcpBehaviorAdapter, options: McpBehaviorOptions = {}) {
        super(adapter, {
            ...options,
            domain: options.domain ?? adapter.domain,
            namespace: options.namespace ?? McpCameraNamespace,
        });
    }

    protected override _buildTools(): McpTool[] {
        return [
            {
                name: McpCameraBehavior.CameraSetTargetFn,
                description: "Sets the camera look-at point (world space) by calling TargetCamera.setTarget(Vector3). coordinates are World-space, right-handed system, y-axis up",
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
            },
        ];
    }

    protected override _buildResources(): McpResource[] {
        return [
            {
                uri: `${this.baseUri}`,
                name: "Cameras list.",
                description: "Cameras available in the scene (paged).",
                mimeType: JsonRpcMimeType,
            },
        ];
    }

    protected override _buildTemplate(): McpResourceTemplate[] {
        return [
            {
                uriTemplate: `${this.baseUri}/{cameraId}`,
                name: "Scene camera",
                description: "A single camera in a scene.",
                mimeType: JsonRpcMimeType,
            },
        ];
    }
}
