import { Camera, Engine, EventState, Nullable, Observer, Scene, TargetCamera, Vector3 } from "@babylonjs/core";
import { McpAdapterBase, McpResourceContent, McpToolResult, McpToolResults } from "@dev/core";
import { McpCameraBehavior } from "../behaviours";
import { McpBabylonDomain, McpCameraResourceUriPrefix } from "../mcp.commons";
import { ICameraState } from "../states";

/**
 * MCP adapter for Babylon.js cameras.
 *
 * Bridges the MCP protocol layer and the live Babylon.js scene:
 * - `readResourceAsync` exposes the camera list and individual camera states as JSON resources.
 * - `executeToolAsync` dispatches tool calls (e.g. `camera.setTarget`) to the matching camera.
 *
 * The adapter maintains an internal URI→Camera index, kept in sync with the scene
 * via `onNewCameraAddedObservable` / `onCameraRemovedObservable`.
 * Subscribers are notified of structural changes via `onResourcesChanged`.
 *
 * All vectors are returned in the right-handed y-up coordinate system.
 * When the scene's `useRightHandedSystem` flag is false (BJS default, left-handed),
 * Z coordinates are negated on the way out and restored on the way in.
 */
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
        this._initializeCameraIndex();
        this._observers.push(this._scene.onNewCameraAddedObservable.add(this._onCameraAdded.bind(this)));
        this._observers.push(this._scene.onCameraRemovedObservable.add(this._onCameraRemoved.bind(this)));
    }

    /**
     * Reads a camera resource by URI.
     *
     * Two URI patterns are handled:
     * - `{prefix}`        → returns the full list of cameras (name, URI, type) as a JSON array.
     * - `{prefix}/{name}` → returns the full {@link ICameraState} of a single camera as JSON.
     *
     * Returns `undefined` for any URI that does not match either pattern.
     */
    public async readResourceAsync(uri: string): Promise<McpResourceContent | undefined> {
        if (uri === `${McpCameraResourceUriPrefix}`) {
            // List resource: enumerate all cameras currently in the scene.
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
            // Instance resource: return the state of a specific camera.
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

    /**
     * Dispatches a tool call to the camera identified by {@link uri}.
     *
     * Supported tools:
     * - `camera.setTarget` — moves the look-at point of a {@link TargetCamera}.
     *
     * Returns a descriptive error result (never throws) if the URI is unknown,
     * the camera type is incompatible with the requested tool, or the arguments are malformed.
     */
    public async executeToolAsync(uri: string, toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
        const camera = this._indexedCameras.get(uri);
        if (!camera) {
            return McpToolResults.error(
                `No camera found for URI "${uri}". ` +
                `Read the resource "${McpCameraResourceUriPrefix}" to get the list of available camera URIs.`
            );
        }
        switch (toolName) {
            case McpCameraBehavior.CameraSetTargetFn: {
                if (!(camera instanceof TargetCamera)) {
                    return McpToolResults.error(
                        `Camera "${camera.name}" (type: ${camera.getClassName()}) does not support "setTarget". ` +
                        `Only TargetCamera subclasses (FreeCamera, ArcRotateCamera, etc.) expose a look-at point.`
                    );
                }
                const target = args["target"] as { x: number; y: number; z: number } | undefined;
                if (!target || typeof target.x !== "number" || typeof target.y !== "number" || typeof target.z !== "number") {
                    return McpToolResults.error(
                        `Invalid "target" argument for "${toolName}". ` +
                        `Expected an object with numeric fields x, y, z in world space (right-handed y-up). ` +
                        `Received: ${JSON.stringify(args["target"])}`
                    );
                }
                // Input is right-handed y-up; flip Z to BJS left-handed when needed.
                const z = this._scene.useRightHandedSystem ? target.z : -target.z;
                camera.setTarget(new Vector3(target.x, target.y, z));
                return McpToolResults.text(
                    `Camera "${camera.name}" is now looking at (${target.x}, ${target.y}, ${target.z}) in world space.`
                );
            }
            default: {
                return McpToolResults.error(
                    `Unknown tool "${toolName}" for camera adapter. ` +
                    `Available tools: "${McpCameraBehavior.CameraSetTargetFn}".`
                );
            }
        }
    }

    /** Removes all BJS observables and clears the event emitters inherited from {@link McpAdapterBase}. */
    public override dispose(): void {
        super.dispose();
        this._observers.forEach((observer) => {
            observer?.remove();
        });
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    /**
     * Populates the URI→Camera index from the cameras already present in the scene.
     * Called once at construction time before subscribing to add/remove observables,
     * so cameras that exist before the adapter is created are not missed.
     */
    protected _initializeCameraIndex(): void {
        this._scene.cameras.forEach((camera) => {
            this._indexedCameras.set(this._buildUriForCamera(camera), camera);
        });
    }

    /** Returns the MCP resource URI for a given camera, e.g. `camera://scene/MyCam`. */
    protected _buildUriForCamera(camera: Camera): string {
        return `${McpCameraResourceUriPrefix}/${camera.name}`;
    }

    /** Called when a new camera is added to the scene; adds it to the index and notifies subscribers. */
    protected _onCameraAdded(eventData: Camera, _eventState: EventState) {
        const uri = this._buildUriForCamera(eventData);
        this._indexedCameras.set(uri, eventData);
        this._forwardResourceChanged();
    }

    /** Called when a camera is removed from the scene; removes it from the index and notifies subscribers. */
    protected _onCameraRemoved(eventData: Camera, _eventState: EventState) {
        const uri = this._buildUriForCamera(eventData);
        this._indexedCameras.delete(uri);
        this._forwardResourceChanged();
    }

    /**
     * Serializes the current state of a Babylon.js {@link Camera} into an {@link ICameraState}.
     *
     * Projection mode:
     * - `Camera.PERSPECTIVE_CAMERA`  → {@link IPerspectiveFrustum} with `fov` (vertical, radians), `near`, `far`.
     * - `Camera.ORTHOGRAPHIC_CAMERA` → {@link IOrthoFrustum} with explicit `left/right/top/bottom` bounds if set.
     *
     * Rotation:
     * - If the camera has a `rotationQuaternion`, it is preferred and stored in `rotationQuat`.
     * - Otherwise `rotation` (Euler angles, radians) is stored in `rotationEuler`.
     * - Both are only available on {@link TargetCamera} subclasses.
     *   Base {@link Camera} instances carry no rotation state and will have neither field set.
     *
     * Coordinate system:
     * - All vectors are expressed in right-handed y-up world space.
     * - When `scene.useRightHandedSystem` is false (BJS default), Z is negated on the way out.
     * - Quaternion LH→RH conversion: `(-qx, -qy, qz, qw)`.
     * - Euler LH→RH conversion: `(-rx, -ry, rz)`.
     *
     * Override this method in a subclass to extend or restrict the serialized state.
     */
    protected _getCameraState(_camera: Camera): ICameraState | undefined {
        return undefined;
    }
}
