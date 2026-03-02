import { Camera, Engine, EventState, Nullable, Observer, Scene, TargetCamera, Vector3 } from "@babylonjs/core";
import { McpAdapterBase, McpResourceContent, McpToolResult, McpToolResults } from "@dev/core";
import { McpCameraBehavior } from "../behaviours";
import { McpBabylonDomain, McpCameraResourceUriPrefix } from "../mcp.commons";
import { ICameraState } from "../states";

export class McpCameraAdapter extends McpAdapterBase {
    private _scene: Scene;
    private _indexedCameras = new Map<string, Camera>();
    private _observers: Nullable<Observer<Camera>>[] = [];

    public constructor(scene?: Scene) {
        super(McpBabylonDomain);
        this._scene = scene ?? Engine.LastCreatedScene!;
        if (!this._scene) {
            throw new Error("McpCameraAdapter requires a Babylon.js Scene. Provide one in the constructor or ensure Engine.LastCreatedScene is set.");
        }
        this._observers.push(this._scene.onNewCameraAddedObservable.add(this._onCameraAdded.bind(this)));
        this._observers.push(this._scene.onCameraRemovedObservable.add(this._onCameraRemoved.bind(this)));
    }

    public async readResourceAsync(uri: string): Promise<McpResourceContent | undefined> {
        if (uri === `${McpCameraResourceUriPrefix}`) {
            // list cameras resource
            const cameras = this._scene.cameras.map((camera) => ({
                uri: this._buildUriForCamera(camera),
                name: camera.name,
                type: camera.getClassName(),
            }));
            return {
                uri: uri,
                text: JSON.stringify(cameras),
                mimeType: "application/json",
            };
        }
        if (uri.startsWith(`${McpCameraResourceUriPrefix}/`)) {
            // single camera resource
            const camera = this._indexedCameras.get(uri);
            if (camera) {
                return {
                    uri: uri,
                    text: JSON.stringify(this._getCameraState(camera)),
                    mimeType: "application/json",
                };
            }
        }
        return undefined;
    }

    public async executeToolAsync(uri: string, toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
        const camera = this._indexedCameras.get(uri);
        if (!camera) {
            return McpToolResults.error(`404 - Camera not found for URI: ${uri}`);
        }
        switch (toolName) {
            case McpCameraBehavior.CameraSetTargetFn: {
                if (camera instanceof TargetCamera) {
                    const target = args["target"] as { x: number; y: number; z: number };
                    if (!target || typeof target.x !== "number" || typeof target.y !== "number" || typeof target.z !== "number") {
                        return McpToolResults.error(`405 - Invalid arguments for ${toolName}. Expected { target: { x: number, y: number, z: number } }`);
                    }
                    // the LLM is more likely to generate a right-handed y-up vector.
                    camera.setTarget(new Vector3(target.x, target.y, -target.z));

                    return McpToolResults.text(`Camera ${camera.name} target set to (${target.x}, ${target.y}, ${target.z})`);
                } else {
                    return McpToolResults.error(`405 - Camera ${camera.name} does not support setting target (not a TargetCamera)`);
                }
                break;
            }
            default: {
                return McpToolResults.error(`404 - Tool not found: ${toolName}`);
            }
        }
    }

    public override dispose(): void {
        super.dispose();
        this._observers.forEach((observer) => {
            observer?.remove();
        });
    }

    protected _initializeCameraIndex(): void {
        this._scene.cameras.forEach((camera) => {
            this._indexedCameras.set(this._buildUriForCamera(camera), camera);
        });
    }

    protected _buildUriForCamera(camera: Camera): string {
        return `${McpCameraResourceUriPrefix}/${camera.name}`;
    }

    protected _onCameraAdded(eventData: Camera, _eventState: EventState) {
        const uri = this._buildUriForCamera(eventData);
        this._indexedCameras.set(uri, eventData);
        this._forwardResourceChanged();
    }

    protected _onCameraRemoved(eventData: Camera, _eventState: EventState) {
        const uri = this._buildUriForCamera(eventData);
        this._indexedCameras.delete(uri);
        this._forwardResourceChanged();
    }

    protected _getCameraState(_camera: Camera): ICameraState | undefined {
        return undefined;
    }
}
