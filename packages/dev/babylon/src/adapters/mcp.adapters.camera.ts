import { Camera, Engine, EventState, Nullable, Observer, Scene, TargetCamera, Vector3 } from "@babylonjs/core";
import { JsonRpcMimeType, McpAdapterBase, McpResourceContent, McpToolResult, McpToolResults } from "@dev/core";
import { McpCameraBehavior } from "../behaviours";
import { McpBabylonDomain, McpCameraResourceUriPrefix } from "../mcp.commons";
import { ICameraState, IFrustum } from "../states";

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
        this._initializeCameraIndex();
    }

    public async readResourceAsync(uri: string): Promise<McpResourceContent | undefined> {
        let text: string | undefined = undefined;
        if (uri === `${McpCameraResourceUriPrefix}`) {
            // list cameras resource
            const cameras = this._scene.cameras.map((camera) => ({
                uri: this._buildUriForCamera(camera),
                name: camera.name,
                type: camera.getClassName(),
            }));
            text = JSON.stringify(cameras);
        }
        if (uri.startsWith(`${McpCameraResourceUriPrefix}/`)) {
            // single camera resource
            const camera = this._indexedCameras.get(uri);
            if (camera) {
                text = JSON.stringify(this._getCameraState(camera));
            }
        }
        return text
            ? {
                  uri: uri,
                  text: text,
                  mimeType: JsonRpcMimeType,
              }
            : undefined;
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
                    const z = this._scene.useRightHandedSystem ? target.z : -target.z;
                    camera.setTarget(new Vector3(target.x, target.y, z));

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

    /**
     * Serializes the current state of a Babylon.js {@link Camera} into an {@link ICameraState}.
     *
     * Projection mode:
     * - `Camera.PERSPECTIVE_CAMERA` → {@link IPerspectiveFrustum} with `fov` (vertical, radians), `near`, `far`
     * - `Camera.ORTHOGRAPHIC_CAMERA` → {@link IOrthoFrustum} with explicit `left/right/top/bottom` bounds if set
     *
     * Rotation:
     * - If the camera has a `rotationQuaternion`, it is preferred and stored in `rotationQuat`.
     * - Otherwise `rotation` (Euler angles, radians) is stored in `rotationEuler`.
     * - Both are only available on {@link TargetCamera} subclasses (FreeCamera, ArcRotateCamera, etc.).
     *   Base {@link Camera} instances carry no rotation state and will have neither field set.
     *
     * Target:
     * - Only populated for {@link TargetCamera} subclasses that expose a `target` property.
     */
    protected _getCameraState(camera: Camera): ICameraState | undefined {
        // If the scene is already right-handed, no Z flip needed
        const zSign = this._scene.useRightHandedSystem ? 1 : -1;

        const frustum: IFrustum =
            camera.mode === Camera.ORTHOGRAPHIC_CAMERA
                ? {
                      kind: "orthographic",
                      near: camera.minZ,
                      far: camera.maxZ,
                      left: camera.orthoLeft ?? undefined,
                      right: camera.orthoRight ?? undefined,
                      top: camera.orthoTop ?? undefined,
                      bottom: camera.orthoBottom ?? undefined,
                  }
                : {
                      kind: "perspective",
                      fov: camera.fov,
                      near: camera.minZ,
                      far: camera.maxZ,
                  };

        const p = camera.position;
        const u = camera.upVector;

        const state: ICameraState = {
            id: camera.id,
            name: camera.name,
            position: { x: p.x, y: p.y, z: p.z * zSign },
            up: { x: u.x, y: u.y, z: u.z * zSign },
            frustum,
            viewport: {
                x: camera.viewport.x,
                y: camera.viewport.y,
                width: camera.viewport.width,
                height: camera.viewport.height,
            },
            isEnabled: camera.isEnabled(),
            layerMask: camera.layerMask,
        };

        if (camera instanceof TargetCamera) {
            const t = camera.target;
            state.target = { x: t.x, y: t.y, z: t.z * zSign };

            if (camera.rotationQuaternion) {
                const q = camera.rotationQuaternion;
                // LH→RH: negate x and y. If already RH, no conversion.
                state.rotationQuat = this._scene.useRightHandedSystem ? { x: q.x, y: q.y, z: q.z, w: q.w } : { x: -q.x, y: -q.y, z: q.z, w: q.w };
            } else {
                const r = camera.rotation;
                // LH→RH: negate x and y, z is invariant. If already RH, no conversion.
                state.rotationEuler = this._scene.useRightHandedSystem ? { x: r.x, y: r.y, z: r.z } : { x: -r.x, y: -r.y, z: r.z };
            }
        }

        return state;
    }
}
