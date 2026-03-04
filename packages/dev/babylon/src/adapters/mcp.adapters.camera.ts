import {
    AbstractMesh,
    ArcRotateCamera,
    BackEase,
    BounceEase,
    Camera,
    CircleEase,
    Color3,
    CubicEase,
    EasingFunction,
    ElasticEase,
    Engine,
    EventState,
    ExponentialEase,
    Frustum,
    InstancedMesh,
    Matrix,
    Nullable,
    Observer,
    PBRMaterial,
    QuadraticEase,
    Scene,
    SineEase,
    StandardMaterial,
    Tags,
    TargetCamera,
    Tools,
    Vector3,
} from "@babylonjs/core";
import { JsonRpcMimeType, McpAdapterBase, McpResourceContent, McpToolResult, McpToolResults } from "@dev/core";
import { McpCameraBehavior } from "../behaviours";
import { McpBabylonDomain, McpCameraResourceUriPrefix } from "../mcp.commons";
import { ICameraState, IFrustum, IScenePickHit, IScenePickResult, ISceneVisibleObjectsState, IVisibleObjectMaterialState, IVisibleObjectState, MaterialType, MeshShapeHint, VisibleObjectIncludeField, VisibleObjectSortBy } from "../states";

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/** All tool names exposed by this adapter, used in the default error message. */
const ALL_TOOLS = [
    McpCameraBehavior.CameraSetTargetFn,
    McpCameraBehavior.CameraSetPositionFn,
    McpCameraBehavior.CameraLookAtFn,
    McpCameraBehavior.CameraOrbitFn,
    McpCameraBehavior.CameraSetFovFn,
    McpCameraBehavior.CameraZoomFn,
    McpCameraBehavior.CameraSetProjectionFn,
    McpCameraBehavior.CameraDollyFn,
    McpCameraBehavior.CameraPanFn,
    McpCameraBehavior.CameraLockFn,
    McpCameraBehavior.CameraUnlockFn,
    McpCameraBehavior.CameraSnapshotFn,
    McpCameraBehavior.CameraAnimateToFn,
    McpCameraBehavior.CameraAnimateOrbitFn,
    McpCameraBehavior.CameraFollowPathFn,
    McpCameraBehavior.CameraShakeFn,
    McpCameraBehavior.CameraStopAnimationFn,
    McpCameraBehavior.SceneVisibleObjectsFn,
    McpCameraBehavior.ScenePickFromCenterFn,
].join('", "');

/**
 * MCP adapter for Babylon.js cameras.
 *
 * Bridges the MCP protocol layer and the live Babylon.js scene:
 * - `readResourceAsync` exposes the camera list and individual camera states as JSON resources.
 * - `executeToolAsync` dispatches tool calls to the matching camera.
 *
 * The adapter maintains an internal URI→Camera index, kept in sync with the scene
 * via `onNewCameraAddedObservable` / `onCameraRemovedObservable`.
 * Subscribers are notified of structural changes via `onResourcesChanged`.
 *
 * All vectors are returned in the right-handed y-up coordinate system.
 * When the scene's `useRightHandedSystem` flag is false (BJS default, left-handed),
 * Z coordinates are negated on the way out and restored on the way in.
 *
 * Angular deltas (orbit), scale factors (zoom), and screen-plane offsets (pan, dolly)
 * are coordinate-system-agnostic scalar values and require no conversion.
 */
export class McpCameraAdapter extends McpAdapterBase {
    private _scene: Scene;
    private _indexedCameras = new Map<string, Camera>();
    private _observers: Nullable<Observer<Camera>>[] = [];

    /** Tracks per-camera active animation observers so they can be cancelled on demand. */
    private _activeAnimations = new Map<string, Observer<Scene>>();

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
        let text: string | undefined = undefined;
        if (uri === `${McpCameraResourceUriPrefix}`) {
            // List resource: enumerate all cameras currently in the scene.
            const cameras = this._scene.cameras.map((camera) => ({
                uri: this._buildUriForCamera(camera),
                name: camera.name,
                type: camera.getClassName(),
            }));
            text = JSON.stringify(cameras);
        }
        if (uri.startsWith(`${McpCameraResourceUriPrefix}/`)) {
            // Instance resource: return the state of a specific camera.
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

    /**
     * Dispatches a tool call to the camera identified by {@link uri}.
     *
     * Returns a descriptive error result (never throws) if the URI is unknown,
     * the camera type is incompatible with the requested tool, or the arguments are malformed.
     */
    public async executeToolAsync(uri: string, toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
        const camera = this._indexedCameras.get(uri);
        if (!camera) {
            return McpToolResults.error(`No camera found for URI "${uri}". ` + `Read the resource "${McpCameraResourceUriPrefix}" to get the list of available camera URIs.`);
        }

        switch (toolName) {
            // -----------------------------------------------------------------
            // camera.setTarget
            // -----------------------------------------------------------------
            case McpCameraBehavior.CameraSetTargetFn: {
                if (!(camera instanceof TargetCamera)) {
                    return McpToolResults.error(
                        `Camera "${camera.name}" (${camera.getClassName()}) does not support setTarget. ` +
                            `Only TargetCamera subclasses (FreeCamera, ArcRotateCamera, etc.) expose a look-at point.`
                    );
                }
                const target = args["target"] as { x: number; y: number; z: number } | undefined;
                if (!this._isVec3(target)) {
                    return this._vec3Error(toolName, "target", args["target"]);
                }
                camera.setTarget(this._tobjsVec3(target));
                return McpToolResults.text(`Camera "${camera.name}" is now looking at (${target.x}, ${target.y}, ${target.z}).`);
            }

            // -----------------------------------------------------------------
            // camera.setPosition
            // -----------------------------------------------------------------
            case McpCameraBehavior.CameraSetPositionFn: {
                const position = args["position"] as { x: number; y: number; z: number } | undefined;
                if (!this._isVec3(position)) {
                    return this._vec3Error(toolName, "position", args["position"]);
                }
                const bjsPos = this._tobjsVec3(position);
                if (camera instanceof ArcRotateCamera) {
                    // setPosition recalculates alpha/beta/radius from the new world position.
                    camera.setPosition(bjsPos);
                } else {
                    camera.position.copyFrom(bjsPos);
                }
                return McpToolResults.text(`Camera "${camera.name}" moved to (${position.x}, ${position.y}, ${position.z}).`);
            }

            // -----------------------------------------------------------------
            // camera.lookAt
            // -----------------------------------------------------------------
            case McpCameraBehavior.CameraLookAtFn: {
                const position = args["position"] as { x: number; y: number; z: number } | undefined;
                const target = args["target"] as { x: number; y: number; z: number } | undefined;
                if (!this._isVec3(position)) return this._vec3Error(toolName, "position", args["position"]);
                if (!this._isVec3(target)) return this._vec3Error(toolName, "target", args["target"]);

                const bjsPos = this._tobjsVec3(position);
                const bjsTarget = this._tobjsVec3(target);

                if (camera instanceof ArcRotateCamera) {
                    // Set target first so setPosition recalculates alpha/beta/radius
                    // relative to the new orbit centre.
                    camera.setTarget(bjsTarget);
                    camera.setPosition(bjsPos);
                } else if (camera instanceof TargetCamera) {
                    camera.position.copyFrom(bjsPos);
                    camera.setTarget(bjsTarget);
                } else {
                    camera.position.copyFrom(bjsPos);
                }
                return McpToolResults.text(
                    `Camera "${camera.name}" placed at (${position.x}, ${position.y}, ${position.z}) ` + `looking at (${target.x}, ${target.y}, ${target.z}).`
                );
            }

            // -----------------------------------------------------------------
            // camera.orbit
            // -----------------------------------------------------------------
            case McpCameraBehavior.CameraOrbitFn: {
                const deltaAlpha = (args["deltaAlpha"] as number | undefined) ?? 0;
                const deltaBeta = (args["deltaBeta"] as number | undefined) ?? 0;

                if (camera instanceof ArcRotateCamera) {
                    // Direct alpha/beta manipulation — the cleanest path for orbit rigs.
                    camera.alpha += deltaAlpha * DEG_TO_RAD;
                    camera.beta += deltaBeta * DEG_TO_RAD;
                    return McpToolResults.text(
                        `Camera "${camera.name}" orbited Δα=${deltaAlpha}°, Δβ=${deltaBeta}°. ` +
                            `New α=${(camera.alpha * RAD_TO_DEG).toFixed(1)}°, β=${(camera.beta * RAD_TO_DEG).toFixed(1)}°.`
                    );
                }

                if (camera instanceof TargetCamera) {
                    // Rotate the camera position around its target using rotation matrices.
                    const tgt = camera.target.clone();
                    let rel = camera.position.subtract(tgt); // vector from target to camera

                    if (deltaAlpha !== 0) {
                        rel = Vector3.TransformCoordinates(rel, Matrix.RotationY(deltaAlpha * DEG_TO_RAD));
                    }
                    if (deltaBeta !== 0) {
                        // Rotate around the camera's current right vector (perpendicular to view and world-up).
                        const backward = rel.clone().normalize();
                        let right = Vector3.Cross(Vector3.Up(), backward);
                        if (right.lengthSquared() < 0.0001) {
                            // Camera is nearly vertical — fall back to world right.
                            right = Vector3.Right();
                        } else {
                            right.normalize();
                        }
                        rel = Vector3.TransformCoordinates(rel, Matrix.RotationAxis(right, deltaBeta * DEG_TO_RAD));
                    }

                    camera.position.copyFrom(tgt.add(rel));
                    camera.setTarget(tgt);
                    return McpToolResults.text(`Camera "${camera.name}" orbited Δα=${deltaAlpha}°, Δβ=${deltaBeta}°.`);
                }

                return McpToolResults.error(`Camera "${camera.name}" (${camera.getClassName()}) does not support orbit. Use a TargetCamera subclass.`);
            }

            // -----------------------------------------------------------------
            // camera.setFov
            // -----------------------------------------------------------------
            case McpCameraBehavior.CameraSetFovFn: {
                const fov = args["fov"] as number | undefined;
                const unit = (args["unit"] as string | undefined) ?? "deg";
                if (typeof fov !== "number" || !isFinite(fov) || fov <= 0) {
                    return McpToolResults.error(`Invalid "fov" for "${toolName}". Expected a positive number, got: ${JSON.stringify(args["fov"])}`);
                }
                if (camera.mode !== Camera.PERSPECTIVE_CAMERA) {
                    return McpToolResults.error(
                        `Camera "${camera.name}" is in orthographic mode — setFov only applies to perspective cameras. ` +
                            `Use "${McpCameraBehavior.CameraSetProjectionFn}" to switch modes first.`
                    );
                }
                const fovRad = unit === "rad" ? fov : fov * DEG_TO_RAD;
                camera.fov = fovRad;
                const label = unit === "rad" ? `${fov.toFixed(3)} rad` : `${fov}°`;
                return McpToolResults.text(`Camera "${camera.name}" FOV set to ${label}.`);
            }

            // -----------------------------------------------------------------
            // camera.zoom
            // -----------------------------------------------------------------
            case McpCameraBehavior.CameraZoomFn: {
                const factor = args["factor"] as number | undefined;
                if (typeof factor !== "number" || !isFinite(factor) || factor <= 0) {
                    return McpToolResults.error(`Invalid "factor" for "${toolName}". Expected a positive number, got: ${JSON.stringify(args["factor"])}`);
                }

                if (camera instanceof ArcRotateCamera) {
                    // Physical dolly: scale orbit radius.
                    camera.radius = Math.max(0.01, camera.radius * factor);
                    return McpToolResults.text(`Camera "${camera.name}" zoomed: radius is now ${camera.radius.toFixed(3)}.`);
                }

                if (camera.mode === Camera.PERSPECTIVE_CAMERA) {
                    // Lens zoom: scale the FOV, clamped to a reasonable range.
                    camera.fov = Math.max(1 * DEG_TO_RAD, Math.min(170 * DEG_TO_RAD, camera.fov * factor));
                    return McpToolResults.text(`Camera "${camera.name}" zoomed: FOV is now ${(camera.fov * RAD_TO_DEG).toFixed(1)}°.`);
                }

                // Orthographic: scale all four bounds proportionally.
                if (camera.orthoLeft !== null) camera.orthoLeft *= factor;
                if (camera.orthoRight !== null) camera.orthoRight *= factor;
                if (camera.orthoTop !== null) camera.orthoTop *= factor;
                if (camera.orthoBottom !== null) camera.orthoBottom *= factor;
                return McpToolResults.text(`Camera "${camera.name}" zoomed: orthographic bounds scaled by ×${factor}.`);
            }

            // -----------------------------------------------------------------
            // camera.setProjection
            // -----------------------------------------------------------------
            case McpCameraBehavior.CameraSetProjectionFn: {
                const mode = args["mode"] as string | undefined;
                const fov = args["fov"] as number | undefined;
                const orthoSize = args["orthoSize"] as number | undefined;

                if (mode === "perspective") {
                    camera.mode = Camera.PERSPECTIVE_CAMERA;
                    if (typeof fov === "number" && fov > 0) {
                        camera.fov = fov * DEG_TO_RAD;
                    }
                    const fovLabel = typeof fov === "number" ? ` with FOV ${fov}°` : "";
                    return McpToolResults.text(`Camera "${camera.name}" switched to perspective projection${fovLabel}.`);
                }

                if (mode === "orthographic") {
                    camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
                    if (typeof orthoSize === "number" && orthoSize > 0) {
                        const half = orthoSize / 2;
                        const aspect = this._scene.getEngine().getAspectRatio(camera);
                        camera.orthoTop = half;
                        camera.orthoBottom = -half;
                        camera.orthoLeft = -half * aspect;
                        camera.orthoRight = half * aspect;
                    }
                    const sizeLabel = typeof orthoSize === "number" ? ` with size ${orthoSize}` : "";
                    return McpToolResults.text(`Camera "${camera.name}" switched to orthographic projection${sizeLabel}.`);
                }

                return McpToolResults.error(`Invalid "mode" for "${toolName}". Expected "perspective" or "orthographic", got: ${JSON.stringify(mode)}`);
            }

            // -----------------------------------------------------------------
            // camera.dolly
            // -----------------------------------------------------------------
            case McpCameraBehavior.CameraDollyFn: {
                const distance = args["distance"] as number | undefined;
                if (typeof distance !== "number" || !isFinite(distance)) {
                    return McpToolResults.error(`Invalid "distance" for "${toolName}". Expected a finite number, got: ${JSON.stringify(args["distance"])}`);
                }

                if (camera instanceof ArcRotateCamera) {
                    // Reduce radius to move closer; clamp above near-plane minimum.
                    camera.radius = Math.max(0.01, camera.radius - distance);
                    return McpToolResults.text(`Camera "${camera.name}" dollied: radius is now ${camera.radius.toFixed(3)}.`);
                }

                if (camera instanceof TargetCamera) {
                    const toTarget = camera.target.subtract(camera.position);
                    const currentDist = toTarget.length();
                    const dir = toTarget.normalize();
                    // Clamp so the camera never shoots past the target.
                    const move = Math.min(distance, currentDist - 0.01);
                    camera.position.addInPlace(dir.scale(move));
                    return McpToolResults.text(`Camera "${camera.name}" dollied ${distance > 0 ? "in" : "out"} by ${Math.abs(distance).toFixed(3)} units.`);
                }

                return McpToolResults.error(`Camera "${camera.name}" (${camera.getClassName()}) does not support dolly. Use a TargetCamera subclass.`);
            }

            // -----------------------------------------------------------------
            // camera.pan
            // -----------------------------------------------------------------
            case McpCameraBehavior.CameraPanFn: {
                const deltaX = args["deltaX"] as number | undefined;
                const deltaY = args["deltaY"] as number | undefined;
                if (typeof deltaX !== "number" || !isFinite(deltaX) || typeof deltaY !== "number" || !isFinite(deltaY)) {
                    return McpToolResults.error(
                        `Invalid "deltaX" or "deltaY" for "${toolName}". Expected finite numbers, got: deltaX=${JSON.stringify(args["deltaX"])}, deltaY=${JSON.stringify(args["deltaY"])}`
                    );
                }

                if (!(camera instanceof TargetCamera)) {
                    return McpToolResults.error(`Camera "${camera.name}" (${camera.getClassName()}) does not support pan. Use a TargetCamera subclass.`);
                }

                // Build camera-space basis vectors.
                // forward: from camera toward target
                const forward = camera.target.subtract(camera.position).normalize();

                // right: perpendicular to forward in the horizontal plane (Cross(worldUp, forward)).
                // If the camera is pointing nearly straight up/down, fall back to Cross(upVector, forward).
                let right = Vector3.Cross(Vector3.Up(), forward);
                if (right.lengthSquared() < 0.0001) {
                    right = Vector3.Cross(camera.upVector, forward);
                }
                right.normalize();

                // screenUp: perpendicular to both forward and right — the screen's up direction.
                const screenUp = Vector3.Cross(forward, right).normalize();

                const panOffset = right.scale(deltaX).add(screenUp.scale(deltaY));

                if (camera instanceof ArcRotateCamera) {
                    // For ArcRotateCamera, translating the orbit target slides the whole rig.
                    // We save/restore alpha/beta/radius because setTarget() calls rebuildAnglesAndRadius()
                    // using the current (stale) camera position, which would corrupt the orbit angles.
                    const savedAlpha = camera.alpha;
                    const savedBeta = camera.beta;
                    const savedRadius = camera.radius;
                    camera.setTarget(camera.target.add(panOffset));
                    camera.alpha = savedAlpha;
                    camera.beta = savedBeta;
                    camera.radius = savedRadius;
                } else {
                    // For TargetCamera: translate position and target together.
                    const newTarget = camera.target.add(panOffset);
                    camera.position.addInPlace(panOffset);
                    camera.setTarget(newTarget);
                }

                return McpToolResults.text(`Camera "${camera.name}" panned (Δright=${deltaX}, Δup=${deltaY}).`);
            }

            // -----------------------------------------------------------------
            // camera.lock
            // -----------------------------------------------------------------
            case McpCameraBehavior.CameraLockFn: {
                camera.detachControl();
                return McpToolResults.text(`Camera "${camera.name}" locked — user input detached.`);
            }

            // -----------------------------------------------------------------
            // camera.unlock
            // -----------------------------------------------------------------
            case McpCameraBehavior.CameraUnlockFn: {
                camera.attachControl(true);
                return McpToolResults.text(`Camera "${camera.name}" unlocked — user input restored.`);
            }

            // -----------------------------------------------------------------
            // camera.snapshot
            // -----------------------------------------------------------------
            case McpCameraBehavior.CameraSnapshotFn: {
                const sizeArg = args["size"] as { width?: number; height?: number; precision?: number } | undefined;

                // Build the Babylon.js size parameter from the optional size argument.
                // Priority: explicit width+height → precision → default native resolution (precision 1).
                let bjsSize: number | { width: number; height: number } | { precision: number };
                if (sizeArg?.width && sizeArg?.height) {
                    bjsSize = { width: Math.round(sizeArg.width), height: Math.round(sizeArg.height) };
                } else if (sizeArg?.precision) {
                    bjsSize = { precision: sizeArg.precision };
                } else {
                    bjsSize = { precision: 1 }; // native viewport resolution
                }

                try {
                    const engine = this._scene.getEngine();
                    // Render off-screen from the specified camera, regardless of which camera is active.
                    const dataUrl = await Tools.CreateScreenshotUsingRenderTargetAsync(
                        engine,
                        camera,
                        bjsSize,
                        "image/png",
                        1, // MSAA samples
                        false, // antialiasing (handled by MSAA)
                        undefined, // fileName — not used in async path
                        false, // renderSprites
                        true // dumpEvenIfNotActive — capture even if camera is not the scene's active camera
                    );
                    // Strip the "data:image/png;base64," prefix — MCP image content expects raw base64.
                    const comma = dataUrl.indexOf(",");
                    const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
                    return McpToolResults.image(base64, "image/png");
                } catch (err) {
                    return McpToolResults.error(`Snapshot failed for camera "${camera.name}": ${err instanceof Error ? err.message : String(err)}`);
                }
            }

            // -----------------------------------------------------------------
            // camera.animateTo
            // -----------------------------------------------------------------
            case McpCameraBehavior.CameraAnimateToFn: {
                if (!(camera instanceof TargetCamera)) {
                    return McpToolResults.error(`Camera "${camera.name}" (${camera.getClassName()}) does not support animateTo. Only TargetCamera subclasses are supported.`);
                }
                // Capture as a const TargetCamera so TypeScript preserves the narrowed type in closures.
                const cam = camera;

                const posArg = args["position"] as { x: number; y: number; z: number } | undefined;
                const tgtArg = args["target"] as { x: number; y: number; z: number } | undefined;
                const fovArg = args["fov"] as number | undefined;
                const duration = typeof args["duration"] === "number" && args["duration"] > 0 ? args["duration"] : 1;
                const easingStr = args["easing"] as string | undefined;

                if (posArg !== undefined && !this._isVec3(posArg)) return this._vec3Error(toolName, "position", posArg);
                if (tgtArg !== undefined && !this._isVec3(tgtArg)) return this._vec3Error(toolName, "target", tgtArg);

                const endPos = posArg ? this._tobjsVec3(posArg) : null;
                const endTgt = tgtArg ? this._tobjsVec3(tgtArg) : null;
                const endFov = typeof fovArg === "number" && isFinite(fovArg) && cam.mode === Camera.PERSPECTIVE_CAMERA ? fovArg * DEG_TO_RAD : null;

                if (!endPos && !endTgt && endFov === null) {
                    return McpToolResults.text(`Camera "${cam.name}": nothing to animate (specify at least one of position, target, or fov).`);
                }

                // Capture start state before the first frame fires.
                const startPos = cam.position.clone();
                const startTgt = cam.target.clone();
                const startFov = cam.fov;

                return await new Promise<McpToolResult>((resolve) => {
                    this._animate(
                        uri,
                        duration,
                        easingStr,
                        (t) => {
                            if (cam instanceof ArcRotateCamera) {
                                if (endPos && endTgt) {
                                    // Combined: setTarget first, then setPosition.
                                    // setPosition will recompute alpha/beta/radius relative to the new target.
                                    cam.setTarget(Vector3.Lerp(startTgt, endTgt, t));
                                    cam.setPosition(Vector3.Lerp(startPos, endPos, t));
                                } else if (endTgt) {
                                    // Target-only: slide the orbit centre while preserving orbital angles.
                                    // Save/restore prevents rebuildAnglesAndRadius() from drifting alpha/beta.
                                    const savedAlpha = cam.alpha;
                                    const savedBeta = cam.beta;
                                    const savedRadius = cam.radius;
                                    cam.setTarget(Vector3.Lerp(startTgt, endTgt, t));
                                    cam.alpha = savedAlpha;
                                    cam.beta = savedBeta;
                                    cam.radius = savedRadius;
                                } else if (endPos) {
                                    cam.setPosition(Vector3.Lerp(startPos, endPos, t));
                                }
                            } else {
                                // Generic TargetCamera: update fields independently.
                                if (endPos) cam.position.copyFrom(Vector3.Lerp(startPos, endPos, t));
                                if (endTgt) cam.setTarget(Vector3.Lerp(startTgt, endTgt, t));
                            }
                            if (endFov !== null) {
                                cam.fov = startFov + (endFov - startFov) * t;
                            }
                        },
                        () => {
                            resolve(McpToolResults.text(`Camera "${cam.name}" animation complete.`));
                        }
                    );
                });
            }

            // -----------------------------------------------------------------
            // camera.animateOrbit
            // -----------------------------------------------------------------
            case McpCameraBehavior.CameraAnimateOrbitFn: {
                if (!(camera instanceof TargetCamera)) {
                    return McpToolResults.error(`Camera "${camera.name}" (${camera.getClassName()}) does not support animateOrbit. Only TargetCamera subclasses are supported.`);
                }
                const cam = camera;

                const deltaAlpha = (args["deltaAlpha"] as number | undefined) ?? 0;
                const deltaBeta = (args["deltaBeta"] as number | undefined) ?? 0;
                const duration = typeof args["duration"] === "number" && args["duration"] > 0 ? args["duration"] : 2;
                const loop = args["loop"] === true;
                // Easing is intentionally ignored in loop mode to prevent per-cycle acceleration artefacts.
                const easingStr = loop ? undefined : (args["easing"] as string | undefined);

                const dAlphaRad = deltaAlpha * DEG_TO_RAD;
                const dBetaRad = deltaBeta * DEG_TO_RAD;

                if (loop) {
                    // Continuous turntable: constant angular velocity.
                    // Each frame callback receives dt (seconds); we integrate the angle ourselves.
                    if (cam instanceof ArcRotateCamera) {
                        this._animateLoop(uri, (dt) => {
                            cam.alpha += dAlphaRad * (dt / duration);
                            cam.beta += dBetaRad * (dt / duration);
                        });
                    } else {
                        // Generic TargetCamera: rotate position around the current target.
                        const tgt = cam.target.clone();
                        this._animateLoop(uri, (dt) => {
                            const frac = dt / duration;
                            let rel = cam.position.subtract(tgt);
                            if (dAlphaRad !== 0) {
                                rel = Vector3.TransformCoordinates(rel, Matrix.RotationY(dAlphaRad * frac));
                            }
                            if (dBetaRad !== 0) {
                                const backward = rel.clone().normalize();
                                let right = Vector3.Cross(Vector3.Up(), backward);
                                if (right.lengthSquared() < 0.0001) right = Vector3.Right();
                                else right.normalize();
                                rel = Vector3.TransformCoordinates(rel, Matrix.RotationAxis(right, dBetaRad * frac));
                            }
                            cam.position.copyFrom(tgt.add(rel));
                            cam.setTarget(tgt);
                        });
                    }
                    return McpToolResults.text(`Camera "${cam.name}" turntable started. Call camera.stopAnimation to stop.`);
                }

                // Non-looping: animate from current angles to current + delta.
                if (cam instanceof ArcRotateCamera) {
                    const startAlpha = cam.alpha;
                    const startBeta = cam.beta;
                    return await new Promise<McpToolResult>((resolve) => {
                        this._animate(
                            uri,
                            duration,
                            easingStr,
                            (t) => {
                                cam.alpha = startAlpha + dAlphaRad * t;
                                cam.beta = startBeta + dBetaRad * t;
                            },
                            () => {
                                resolve(McpToolResults.text(`Camera "${cam.name}" orbit animation complete.`));
                            }
                        );
                    });
                }

                // Generic TargetCamera: interpolate position around the target.
                const tgt = cam.target.clone();
                const startRel = cam.position.subtract(tgt);
                return await new Promise<McpToolResult>((resolve) => {
                    this._animate(
                        uri,
                        duration,
                        easingStr,
                        (t) => {
                            let rel = startRel.clone();
                            if (dAlphaRad !== 0) {
                                rel = Vector3.TransformCoordinates(rel, Matrix.RotationY(dAlphaRad * t));
                            }
                            if (dBetaRad !== 0) {
                                const backward = rel.clone().normalize();
                                let right = Vector3.Cross(Vector3.Up(), backward);
                                if (right.lengthSquared() < 0.0001) right = Vector3.Right();
                                else right.normalize();
                                rel = Vector3.TransformCoordinates(rel, Matrix.RotationAxis(right, dBetaRad * t));
                            }
                            cam.position.copyFrom(tgt.add(rel));
                            cam.setTarget(tgt);
                        },
                        () => {
                            resolve(McpToolResults.text(`Camera "${cam.name}" orbit animation complete.`));
                        }
                    );
                });
            }

            // -----------------------------------------------------------------
            // camera.followPath
            // -----------------------------------------------------------------
            case McpCameraBehavior.CameraFollowPathFn: {
                if (!(camera instanceof TargetCamera)) {
                    return McpToolResults.error(`Camera "${camera.name}" (${camera.getClassName()}) does not support followPath. Only TargetCamera subclasses are supported.`);
                }
                const cam = camera;

                const waypointsArg = args["waypoints"] as Array<{ position?: { x: number; y: number; z: number }; target?: { x: number; y: number; z: number } }> | undefined;
                const duration = typeof args["duration"] === "number" && args["duration"] > 0 ? args["duration"] : 3;
                const easingStr = args["easing"] as string | undefined;

                if (!Array.isArray(waypointsArg) || waypointsArg.length < 2) {
                    return McpToolResults.error(`"waypoints" must be an array of at least 2 items for "${toolName}".`);
                }

                // Pre-process waypoints: resolve missing position/target by carrying forward from
                // the previous entry (or the camera's current state for index 0).
                const positions: Vector3[] = [];
                const targets: Vector3[] = [];
                let lastPos = cam.position.clone();
                let lastTgt = cam.target.clone();

                for (let i = 0; i < waypointsArg.length; i++) {
                    const wp = waypointsArg[i];
                    if (wp.position !== undefined) {
                        if (!this._isVec3(wp.position)) return this._vec3Error(toolName, `waypoints[${i}].position`, wp.position);
                        lastPos = this._tobjsVec3(wp.position);
                    }
                    if (wp.target !== undefined) {
                        if (!this._isVec3(wp.target)) return this._vec3Error(toolName, `waypoints[${i}].target`, wp.target);
                        lastTgt = this._tobjsVec3(wp.target);
                    }
                    positions.push(lastPos.clone());
                    targets.push(lastTgt.clone());
                }

                const N = positions.length; // ≥ 2

                return await new Promise<McpToolResult>((resolve) => {
                    this._animate(
                        uri,
                        duration,
                        easingStr,
                        (t) => {
                            // Map t → segment index + local t within that segment.
                            const segPos = t * (N - 1);
                            const idx = Math.min(Math.floor(segPos), N - 2);
                            const localT = segPos - idx;

                            const lerpedPos = Vector3.Lerp(positions[idx], positions[idx + 1], localT);
                            const lerpedTgt = Vector3.Lerp(targets[idx], targets[idx + 1], localT);

                            if (cam instanceof ArcRotateCamera) {
                                // setTarget first, then setPosition to get correct alpha/beta/radius.
                                cam.setTarget(lerpedTgt);
                                cam.setPosition(lerpedPos);
                            } else {
                                cam.position.copyFrom(lerpedPos);
                                cam.setTarget(lerpedTgt);
                            }
                        },
                        () => {
                            resolve(McpToolResults.text(`Camera "${cam.name}" path complete.`));
                        }
                    );
                });
            }

            // -----------------------------------------------------------------
            // camera.shake
            // -----------------------------------------------------------------
            case McpCameraBehavior.CameraShakeFn: {
                if (!(camera instanceof TargetCamera)) {
                    return McpToolResults.error(`Camera "${camera.name}" (${camera.getClassName()}) does not support shake. Only TargetCamera subclasses are supported.`);
                }
                const cam = camera;

                const intensity = typeof args["intensity"] === "number" && args["intensity"] > 0 ? args["intensity"] : 0.5;
                const duration = typeof args["duration"] === "number" && args["duration"] > 0 ? args["duration"] : 1;
                const frequency = typeof args["frequency"] === "number" && args["frequency"] > 0 ? args["frequency"] : 12;

                const baseTarget = cam.target.clone();
                const TAU = 2 * Math.PI;

                return await new Promise<McpToolResult>((resolve) => {
                    // No easing (t === rawT), so elapsed = t * duration gives true wall-clock seconds
                    // for the sine frequency calculation. Amplitude decays linearly from intensity → 0.
                    this._animate(
                        uri,
                        duration,
                        undefined,
                        (t) => {
                            const elapsed = t * duration;
                            const amplitude = intensity * (1 - t); // linear decay

                            // Three-layer sinusoids at different frequencies and phases for an organic feel.
                            const dx =
                                amplitude *
                                (Math.sin(elapsed * frequency * TAU) * 0.6 +
                                    Math.sin(elapsed * frequency * 2.7 * TAU + 1.23) * 0.3 +
                                    Math.sin(elapsed * frequency * 5.1 * TAU + 2.45) * 0.1);
                            const dy =
                                amplitude *
                                (Math.sin(elapsed * frequency * 0.9 * TAU + 0.5) * 0.5 +
                                    Math.sin(elapsed * frequency * 2.1 * TAU + 1.87) * 0.35 +
                                    Math.sin(elapsed * frequency * 4.3 * TAU + 3.14) * 0.15);

                            const shakeTarget = new Vector3(baseTarget.x + dx, baseTarget.y + dy, baseTarget.z);

                            if (cam instanceof ArcRotateCamera) {
                                // Direct modification to avoid rebuildAnglesAndRadius().
                                // This oscillates the orbit centre, producing physical camera movement.
                                cam.target.copyFrom(shakeTarget);
                            } else {
                                cam.setTarget(shakeTarget);
                            }
                        },
                        () => {
                            // Restore the original look-at point on completion.
                            if (cam instanceof ArcRotateCamera) {
                                cam.target.copyFrom(baseTarget);
                            } else {
                                cam.setTarget(baseTarget);
                            }
                            resolve(McpToolResults.text(`Camera "${cam.name}" shake complete.`));
                        }
                    );
                });
            }

            // -----------------------------------------------------------------
            // camera.stopAnimation
            // -----------------------------------------------------------------
            case McpCameraBehavior.CameraStopAnimationFn: {
                const wasRunning = this._activeAnimations.has(uri);
                this._stopAnimation(uri);
                return McpToolResults.text(wasRunning ? `Camera "${camera.name}" animation stopped.` : `Camera "${camera.name}" had no active animation.`);
            }

            // -----------------------------------------------------------------
            // scene.visibleObjects
            // -----------------------------------------------------------------
            case McpCameraBehavior.SceneVisibleObjectsFn: {
                return McpToolResults.json(this._handleSceneVisibleObjects(camera, args));
            }

            // -----------------------------------------------------------------
            // scene.pickFromCenter
            // -----------------------------------------------------------------
            case McpCameraBehavior.ScenePickFromCenterFn: {
                return McpToolResults.json(this._handleScenePickFromCenter(camera, args));
            }

            // -----------------------------------------------------------------
            // Unknown
            // -----------------------------------------------------------------
            default: {
                return McpToolResults.error(`Unknown tool "${toolName}" for camera adapter. Available tools: "${ALL_TOOLS}".`);
            }
        }
    }

    /** Removes all BJS observables and clears the event emitters inherited from {@link McpAdapterBase}. */
    public override dispose(): void {
        this._stopAllAnimations();
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

    /** Returns the MCP resource URI for a given camera, e.g. `babylon://camera/MyCam`. */
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
     * Converts a right-handed y-up input vector to a Babylon.js internal Vector3.
     * When the scene uses the default left-handed system, Z is negated.
     */
    private _tobjsVec3(v: { x: number; y: number; z: number }): Vector3 {
        return new Vector3(v.x, v.y, this._scene.useRightHandedSystem ? v.z : -v.z);
    }

    /** Returns true when `v` is a non-null object with finite numeric x, y, z fields. */
    private _isVec3(v: unknown): v is { x: number; y: number; z: number } {
        if (!v || typeof v !== "object") return false;
        const o = v as Record<string, unknown>;
        return typeof o["x"] === "number" && typeof o["y"] === "number" && typeof o["z"] === "number" && isFinite(o["x"]) && isFinite(o["y"]) && isFinite(o["z"]);
    }

    /** Builds a standardised argument-validation error for vec3 parameters. */
    private _vec3Error(toolName: string, paramName: string, received: unknown): McpToolResult {
        return McpToolResults.error(
            `Invalid "${paramName}" argument for "${toolName}". ` +
                `Expected an object with finite numeric fields x, y, z (right-handed y-up). ` +
                `Received: ${JSON.stringify(received)}`
        );
    }

    // -------------------------------------------------------------------------
    // Animation helpers
    // -------------------------------------------------------------------------

    /**
     * Registers a one-shot per-frame observer that runs for `durationSecs` seconds.
     *
     * Each frame `onFrame(easedT)` is called, where `easedT` ∈ [0, 1] is the eased
     * normalised time. `onComplete()` is called once when `rawT` reaches 1 and the
     * observer is automatically removed.
     *
     * Any existing animation registered for `uri` is cancelled first.
     */
    private _animate(uri: string, durationSecs: number, easingStr: string | undefined, onFrame: (easedT: number) => void, onComplete?: () => void): void {
        this._stopAnimation(uri);
        const easingFn = this._createEasingFunction(easingStr);
        let elapsed = 0;

        const observer = this._scene.onBeforeRenderObservable.add(() => {
            const dt = this._scene.getEngine().getDeltaTime() / 1000; // ms → s
            elapsed += dt;
            const rawT = Math.min(elapsed / durationSecs, 1);
            const easedT = easingFn ? easingFn.ease(rawT) : rawT;
            onFrame(easedT);
            if (rawT >= 1) {
                this._stopAnimation(uri);
                onComplete?.();
            }
        });

        if (observer) {
            this._activeAnimations.set(uri, observer);
        }
    }

    /**
     * Registers a looping per-frame observer that runs indefinitely.
     *
     * Each frame `onFrame(dtSecs)` is called with the delta time since the last frame,
     * letting the caller integrate the motion at a constant velocity independent of frame rate.
     *
     * Any existing animation registered for `uri` is cancelled first.
     * Stop with {@link _stopAnimation}.
     */
    private _animateLoop(uri: string, onFrame: (dtSecs: number) => void): void {
        this._stopAnimation(uri);

        const observer = this._scene.onBeforeRenderObservable.add(() => {
            const dt = this._scene.getEngine().getDeltaTime() / 1000;
            onFrame(dt);
        });

        if (observer) {
            this._activeAnimations.set(uri, observer);
        }
    }

    /** Cancels and removes any active animation registered for `uri`. */
    private _stopAnimation(uri: string): void {
        const observer = this._activeAnimations.get(uri);
        if (observer) {
            this._scene.onBeforeRenderObservable.remove(observer);
            this._activeAnimations.delete(uri);
        }
    }

    /** Cancels all active animations across all cameras. Called from {@link dispose}. */
    private _stopAllAnimations(): void {
        for (const [uri] of this._activeAnimations) {
            this._stopAnimation(uri);
        }
    }

    /**
     * Parses an easing string of the form `"<type>"` or `"<type>.<mode>"` and returns
     * the corresponding Babylon.js {@link EasingFunction}, or `null` for `"linear"` /
     * when the string is omitted (the caller should then use `easedT = rawT` directly).
     *
     * Supported types: `linear | sine | quad | cubic | circle | expo | back | bounce | elastic`
     * Supported modes: `in | out | inout` (default: `inout`)
     */
    private _createEasingFunction(easingStr?: string): EasingFunction | null {
        if (!easingStr) return null;
        const parts = easingStr.toLowerCase().split(".");
        const type = parts[0];
        const mode = parts[1] ?? "inout";

        if (type === "linear") return null;

        let easing: EasingFunction;
        switch (type) {
            case "sine":
                easing = new SineEase();
                break;
            case "quad":
                easing = new QuadraticEase();
                break;
            case "cubic":
                easing = new CubicEase();
                break;
            case "circle":
                easing = new CircleEase();
                break;
            case "expo":
                easing = new ExponentialEase();
                break;
            case "back":
                easing = new BackEase();
                break;
            case "bounce":
                easing = new BounceEase();
                break;
            case "elastic":
                easing = new ElasticEase();
                break;
            default:
                easing = new SineEase();
                break;
        }

        switch (mode) {
            case "in":
                easing.setEasingMode(EasingFunction.EASINGMODE_EASEIN);
                break;
            case "out":
                easing.setEasingMode(EasingFunction.EASINGMODE_EASEOUT);
                break;
            default:
                easing.setEasingMode(EasingFunction.EASINGMODE_EASEINOUT);
                break;
        }

        return easing;
    }

    // -------------------------------------------------------------------------
    // Scene query helpers
    // -------------------------------------------------------------------------

    /**
     * Returns a structured description of all meshes visible from {@link camera}.
     *
     * Filtering pipeline:
     *  1. Skip disabled / invisible meshes with no geometry.
     *  2. Skip meshes not in the camera frustum.
     *  3. Apply optional layerMask, onlyPickable and minScreenCoverage filters.
     *  4. Sort by distance | screenCoverage | name.
     *  5. Truncate to maxObjects.
     */
    private _handleSceneVisibleObjects(camera: Camera, args: Record<string, unknown>): ISceneVisibleObjectsState {
        const maxObjects = typeof args["maxObjects"] === "number" && args["maxObjects"] > 0 ? Math.floor(args["maxObjects"]) : 50;
        const include = Array.isArray(args["include"]) ? (args["include"] as VisibleObjectIncludeField[]) : [];
        const onlyPickable = args["onlyPickable"] === true;
        const minScreenCoverage = typeof args["minScreenCoverage"] === "number" ? args["minScreenCoverage"] : 0.001;
        const layerMask = typeof args["layerMask"] === "number" ? args["layerMask"] : undefined;
        const sortBy: VisibleObjectSortBy = (args["sortBy"] as VisibleObjectSortBy) ?? "distance";

        const includeAll = include.length === 0;
        const wants = (field: VisibleObjectIncludeField) => includeAll || include.includes(field);

        const zSign = this._scene.useRightHandedSystem ? 1 : -1;
        const engine = this._scene.getEngine();
        const renderWidth = engine.getRenderWidth();
        const renderHeight = engine.getRenderHeight();
        const transformMatrix = camera.getTransformationMatrix();
        const viewport = camera.viewport.toGlobal(renderWidth, renderHeight);
        const frustumPlanes = Frustum.GetPlanes(transformMatrix);
        const camPos = camera.position;

        const visible: IVisibleObjectState[] = [];
        let filteredOut = 0;

        for (const mesh of this._scene.meshes) {
            // Basic eligibility: must be enabled, visible and have geometry.
            if (!mesh.isEnabled() || !mesh.isVisible || mesh.getTotalVertices() === 0) {
                filteredOut++;
                continue;
            }
            // Frustum test.
            if (!mesh.isInFrustum(frustumPlanes)) {
                filteredOut++;
                continue;
            }
            // Optional layer mask filter.
            if (layerMask !== undefined && (mesh.layerMask & layerMask) === 0) {
                filteredOut++;
                continue;
            }
            // Optional pickable filter.
            if (onlyPickable && !mesh.isPickable) {
                filteredOut++;
                continue;
            }

            const bi = mesh.getBoundingInfo();
            const center = bi.boundingSphere.centerWorld;
            const distance = Vector3.Distance(camPos, center);

            // Screen-space bounding box via projection of world-space corners.
            let screenX: number | undefined;
            let screenY: number | undefined;
            let screenW: number | undefined;
            let screenH: number | undefined;
            let screenCoverage: number | undefined;

            const corners = bi.boundingBox.vectorsWorld;
            if (corners.length > 0) {
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                const identity = Matrix.Identity();
                for (const corner of corners) {
                    const proj = Vector3.Project(corner, identity, transformMatrix, viewport);
                    if (proj.x < minX) minX = proj.x;
                    if (proj.y < minY) minY = proj.y;
                    if (proj.x > maxX) maxX = proj.x;
                    if (proj.y > maxY) maxY = proj.y;
                }
                screenX = minX / renderWidth;
                screenY = minY / renderHeight;
                screenW = (maxX - minX) / renderWidth;
                screenH = (maxY - minY) / renderHeight;
                screenCoverage = screenW * screenH;
            }

            // Screen coverage filter.
            if (screenCoverage !== undefined && screenCoverage < minScreenCoverage) {
                filteredOut++;
                continue;
            }

            const entry: IVisibleObjectState = {
                id: mesh.id,
                name: mesh.name,
                type: mesh instanceof InstancedMesh ? "instancedMesh" : "mesh",
                shapeHint: this._getShapeHint(mesh),
                distance,
            };

            if (wants("transform")) {
                entry.position = { x: center.x, y: center.y, z: center.z * zSign };
            }

            if (wants("bounds")) {
                const bbMin = bi.boundingBox.minimumWorld;
                const bbMax = bi.boundingBox.maximumWorld;
                entry.bounds = {
                    worldMin: { x: bbMin.x, y: bbMin.y, z: bbMin.z * zSign },
                    worldMax: { x: bbMax.x, y: bbMax.y, z: bbMax.z * zSign },
                    screenX,
                    screenY,
                    screenW,
                    screenH,
                    screenCoverage,
                };
            }

            if (wants("material") || wants("color")) {
                entry.material = this._getMaterialState(mesh);
            }

            if (wants("visibility")) {
                entry.visibility = {
                    isEnabled: mesh.isEnabled(),
                    isVisible: mesh.isVisible,
                    isInFrustum: true, // already tested above
                    visibility: mesh.visibility,
                };
                entry.flags = {
                    pickable: mesh.isPickable,
                    castsShadows: mesh.receiveShadows, // no direct cast getter; use what's available
                    receivesShadows: mesh.receiveShadows,
                };
            }

            if (wants("tags")) {
                const tagStr = Tags.GetTags(mesh, true);
                entry.tags = tagStr ? (tagStr as string).split(" ").filter(Boolean) : [];
            }

            visible.push(entry);
        }

        // Sort.
        visible.sort((a, b) => {
            if (sortBy === "screenCoverage") {
                const ca = a.bounds?.screenCoverage ?? 0;
                const cb = b.bounds?.screenCoverage ?? 0;
                return cb - ca; // largest first
            }
            if (sortBy === "name") return a.name.localeCompare(b.name);
            return a.distance - b.distance; // closest first (default)
        });

        // Truncate.
        const truncated = visible.splice(maxObjects);
        filteredOut += truncated.length;

        // Camera summary.
        let bjsFwd: Vector3;
        if (camera instanceof TargetCamera) {
            bjsFwd = camera.target.subtract(camPos);
        } else {
            bjsFwd = Vector3.TransformNormal(new Vector3(0, 0, 1), camera.getWorldMatrix());
        }
        bjsFwd.normalize();

        const cameraInfo = {
            name: camera.name,
            position: { x: camPos.x, y: camPos.y, z: camPos.z * zSign },
            forward: { x: bjsFwd.x, y: bjsFwd.y, z: bjsFwd.z * zSign },
            ...(camera.mode === Camera.PERSPECTIVE_CAMERA ? { fov: camera.fov } : {}),
        };

        return {
            camera: cameraInfo,
            visible,
            stats: { count: visible.length, filteredOut },
        };
    }

    /**
     * Casts a picking ray from {@link camera} through a normalized screen point.
     *
     * - Default: returns the closest hit only (scene.pick).
     * - allHits: true — returns every mesh intersected by the ray, sorted by
     *   distance (scene.multiPick). Useful when objects are stacked or when the
     *   first hit is the ground / a transparent surface.
     */
    private _handleScenePickFromCenter(camera: Camera, args: Record<string, unknown>): IScenePickResult {
        const zSign = this._scene.useRightHandedSystem ? 1 : -1;
        const engine = this._scene.getEngine();
        const renderWidth = engine.getRenderWidth();
        const renderHeight = engine.getRenderHeight();

        const spArg = args["screenPoint"] as { x?: number; y?: number } | undefined;
        const normX = typeof spArg?.x === "number" ? spArg.x : 0.5;
        const normY = typeof spArg?.y === "number" ? spArg.y : 0.5;
        const maxDist = typeof args["maxDistance"] === "number" && args["maxDistance"] > 0 ? args["maxDistance"] : undefined;
        const allHits = args["allHits"] === true;

        const pxX = normX * renderWidth;
        const pxY = normY * renderHeight;

        const predicate = maxDist
            ? (mesh: AbstractMesh) => mesh.isPickable && Vector3.Distance(camera.position, mesh.getBoundingInfo().boundingSphere.centerWorld) <= maxDist
            : undefined;

        // ---- allHits: use multiPick to collect every intersection ----
        if (allHits) {
            const picks = this._scene.multiPick(pxX, pxY, predicate, camera) ?? [];
            // multiPick order is not guaranteed — sort by distance ascending.
            picks.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));

            if (picks.length === 0 || !picks[0].hit || !picks[0].pickedMesh) {
                return { hit: false, hits: [] };
            }

            const hits: IScenePickHit[] = picks
                .filter((p) => p.hit && p.pickedMesh)
                .map((p) => {
                    const hit: IScenePickHit = {
                        meshId: p.pickedMesh!.id,
                        meshName: p.pickedMesh!.name,
                        distance: p.distance ?? 0,
                    };
                    if (p.pickedPoint) {
                        hit.pickedPoint = { x: p.pickedPoint.x, y: p.pickedPoint.y, z: p.pickedPoint.z * zSign };
                    }
                    const n = p.getNormal(true, true);
                    if (n) hit.normal = { x: n.x, y: n.y, z: n.z * zSign };
                    if (p.faceId >= 0) hit.faceId = p.faceId;
                    return hit;
                });

            // When allHits is true, only the hits array is returned — no top-level duplication.
            return { hit: true, hits };
        }

        // ---- default: single closest hit ----
        const pickInfo = this._scene.pick(pxX, pxY, predicate, false, camera);

        if (!pickInfo?.hit || !pickInfo.pickedMesh) {
            return { hit: false };
        }

        const result: IScenePickResult = {
            hit: true,
            meshId: pickInfo.pickedMesh.id,
            meshName: pickInfo.pickedMesh.name,
        };

        if (pickInfo.pickedPoint) {
            const pt = pickInfo.pickedPoint;
            result.pickedPoint = { x: pt.x, y: pt.y, z: pt.z * zSign };
            result.distance = pickInfo.distance ?? Vector3.Distance(camera.position, pickInfo.pickedPoint);
        }

        const normal = pickInfo.getNormal(true, true);
        if (normal) {
            result.normal = { x: normal.x, y: normal.y, z: normal.z * zSign };
        }

        if (pickInfo.faceId >= 0) {
            result.faceId = pickInfo.faceId;
        }

        return result;
    }

    /** Best-effort shape classification: checks mesh metadata first, then falls back to name keywords. */
    private _getShapeHint(mesh: AbstractMesh): MeshShapeHint {
        if (mesh.metadata?.shapeHint) return mesh.metadata.shapeHint as MeshShapeHint;
        const lower = mesh.name.toLowerCase();
        if (/sphere|ball/.test(lower)) return "sphere";
        if (/box|cube/.test(lower)) return "box";
        if (/plane|ground|floor/.test(lower)) return "plane";
        if (/cylinder|tube|pipe/.test(lower)) return "cylinder";
        if (/torus|ring/.test(lower)) return "torus";
        return "unknown";
    }

    /**
     * Extracts a material description from the mesh.
     * Handles {@link StandardMaterial} (diffuseColor) and {@link PBRMaterial} (albedoColor).
     */
    private _getMaterialState(mesh: AbstractMesh): IVisibleObjectMaterialState | undefined {
        const mat = mesh.material;
        if (!mat) return undefined;

        let type: MaterialType = "other";
        let baseColor: { r: number; g: number; b: number } | undefined;
        let hasTexture: boolean | undefined;

        if (mat instanceof StandardMaterial) {
            type = "standard";
            const c = mat.diffuseColor ?? Color3.White();
            baseColor = { r: c.r, g: c.g, b: c.b };
            hasTexture = mat.diffuseTexture !== null;
        } else if (mat instanceof PBRMaterial) {
            type = "pbr";
            const c = mat.albedoColor ?? Color3.White();
            baseColor = { r: c.r, g: c.g, b: c.b };
            hasTexture = mat.albedoTexture !== null;
        } else {
            const className = mat.getClassName();
            if (className === "NodeMaterial") type = "node";
        }

        return { name: mat.name, type, baseColor, hasTexture };
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
     * - Both are only available on {@link TargetCamera} subclasses (FreeCamera, ArcRotateCamera, etc.).
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
