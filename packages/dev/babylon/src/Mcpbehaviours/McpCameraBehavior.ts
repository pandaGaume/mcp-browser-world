import { TargetCamera, Vector3 } from "@babylonjs/core";

import { CachedMcpBehaviorInstanceBase, McpToolMethod } from "@dev/core";

export class McpCameraBehaviorInstance extends CachedMcpBehaviorInstanceBase<TargetCamera> {
    public constructor(target: TargetCamera, uri: string) {
        super(target, uri);
    }

    // Local API (typed, convenient for in-app calls)
    public lookAt(target: Vector3): void {
        this.target.setTarget(target);
    }

    @McpToolMethod({
        name: "camera.setTarget",
        description: "Sets the target camera look-at point (world space) by calling TargetCamera.setTarget(Vector3).",
        inputSchema: {
            type: "object",
            properties: {
                target: {
                    type: "object",
                    properties: {
                        x: { type: "number" },
                        y: { type: "number" },
                        z: { type: "number" },
                    },
                    required: ["x", "y", "z"],
                    additionalProperties: false,
                },
            },
            required: ["target"],
            additionalProperties: false,
        },
    })
    public setTarget(args: unknown): void {
        const a = args as { target?: { x?: unknown; y?: unknown; z?: unknown } };
        const t = a?.target;
        if (!t || typeof t.x !== "number" || typeof t.y !== "number" || typeof t.z !== "number") {
            throw new Error("Invalid args for camera.setTarget: expected { target: { x:number, y:number, z:number } }");
        }

        this.lookAt(new Vector3(t.x, t.y, t.z));
    }
}
