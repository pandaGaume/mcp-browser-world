/**
 * @module McpCameraAdapter (CesiumJS)
 *
 * MCP adapter for CesiumJS cameras.
 *
 * ## CesiumJS Camera Overview
 *
 * CesiumJS has a **single camera per scene** (unlike Babylon.js which supports
 * multiple cameras). The camera lives at `viewer.camera` / `viewer.scene.camera`.
 *
 * ### Coordinate System
 *
 * CesiumJS uses an **ECEF** (Earth-Centered Earth-Fixed) right-handed coordinate
 * system. All positions are `Cartesian3` values expressed in **meters** from Earth's
 * centre. MCP `{x, y, z}` maps directly to `Cartesian3(x, y, z)` — no coordinate
 * conversion is needed since both are right-handed.
 *
 * ### Camera State
 *
 * The CesiumJS `Camera` object exposes:
 * - `position`  — `Cartesian3`, world-space position (ECEF metres)
 * - `direction` — `Cartesian3`, unit forward vector
 * - `up`        — `Cartesian3`, unit up vector
 * - `right`     — `Cartesian3`, unit right vector (computed: cross(direction, up))
 * - `heading`   — azimuth from North (radians)
 * - `pitch`     — elevation from horizon (radians, negative = looking down)
 * - `roll`      — twist around the view axis (radians)
 * - `frustum`   — `PerspectiveFrustum` or `OrthographicFrustum`
 *
 * **There is no `target` property.** This adapter manually tracks a look-at target
 * as `_target: Cartesian3`, computed from `position + direction * distance`.
 *
 * ### User Input
 *
 * `scene.screenSpaceCameraController.enableInputs` toggles all mouse/keyboard/touch
 * camera interaction. This is used for `camera_lock` / `camera_unlock`.
 *
 * ### Built-in Flight
 *
 * `camera.flyTo({ destination, orientation, duration, easingFunction, complete })`
 * provides smooth animated transitions with easing. This is used for `camera_animate_to`.
 *
 * ### Picking
 *
 * - `scene.pick(windowPosition)` — returns the first object at a screen pixel
 * - `scene.drillPick(windowPosition)` — returns all objects at a screen pixel
 * - `scene.pickPosition(windowPosition)` — returns the world-space Cartesian3 position
 *
 * ### Frame Callbacks
 *
 * `scene.preRender.addEventListener(callback)` registers a per-frame callback.
 * Returns a removal function. Used for orbit loops, path following, and shake.
 */

import {
    Cartesian2,
    Cartesian3,
    EasingFunction,
    Math as CesiumMath,
    Matrix3,
    Matrix4,
    OrthographicFrustum,
    PerspectiveFrustum,
    Quaternion,
    Scene,
    Transforms,
    Viewer,
} from "cesium";
import { JsonRpcMimeType, McpAdapterBase, McpResourceContent, McpToolResult, McpToolResults, ToolSupport } from "@dev/core";
import { IHasImageFiltering, IImageFilterSet, ImageFilterSet, isTextSnapshotFilter } from "@dev/filters";
import { ICameraState, IFrustum, IScenePickHit, IScenePickResult, ISceneVisibleObjectsState, IVisibleObjectState, McpCameraBehavior, downsampleDepthGrid, encodeDepthGrid } from "@dev/behaviors";
import { resolveToCartesian3 } from "@dev/geodesy";
import { McpCesiumDomain, McpCameraResourceUriPrefix } from "../mcp.commons";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/**
 * Default distance (in metres) from the camera to the synthetic look-at target
 * when no better estimate is available. 10 km is a reasonable default for globe
 * viewing; it will be refined by `flyTo`, `lookAt`, and `setTarget` operations.
 */
const DEFAULT_TARGET_DISTANCE = 10_000;

/** All tool names this adapter handles, used for the default error message. */
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
    McpCameraBehavior.CameraLidarFn,
].join('", "');

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * MCP adapter for CesiumJS cameras.
 *
 * Bridges the MCP protocol layer and the live CesiumJS scene:
 * - `readResourceAsync` exposes the single camera state as a JSON resource.
 * - `executeToolAsync` dispatches tool calls to the Cesium camera.
 *
 * Because CesiumJS has a single camera per scene, this adapter always uses
 * the URI `cesium://camera/default`.
 *
 * ### Target Tracking
 *
 * CesiumJS cameras do not expose a `target` property. This adapter maintains
 * a synthetic `_target` (Cartesian3) that represents the look-at point:
 * - Initialised as `position + direction * DEFAULT_TARGET_DISTANCE`
 * - Updated by `setTarget`, `lookAt`, `animateTo`, and `followPath`
 * - Read by `orbit`, `dolly`, `pan`, and `shake` to compute relative motions
 *
 * ### Animation
 *
 * - **`camera_animate_to`** uses CesiumJS's built-in `camera.flyTo()` which
 *   provides smooth transitions with configurable easing functions.
 * - **`camera_animate_orbit`**, **`camera_follow_path`**, and **`camera_shake`**
 *   use frame-based callbacks via `scene.preRender.addEventListener()`.
 * - **`camera_stop_animation`** calls `camera.cancelFlight()` and removes
 *   any active frame callback.
 *
 * All vectors are in the ECEF right-handed coordinate system (metres).
 */
export class McpCameraAdapter extends McpAdapterBase implements IHasImageFiltering {
    // ── State ────────────────────────────────────────────────────────────

    /** Composable filter manager for camera snapshots (lazy-initialized). */
    private _imageFiltering: IImageFilterSet | undefined;

    /** Composable filter manager for camera snapshots. Created on first access so the adapter works even when `@dev/filters` is not loaded. */
    public get imageFiltering(): IImageFilterSet {
        if (!this._imageFiltering) {
            this._imageFiltering = new ImageFilterSet();
        }
        return this._imageFiltering;
    }

    /** The CesiumJS Viewer instance that owns the scene and camera. */
    private _viewer: Viewer;
    /** Shorthand reference to `viewer.scene`. */
    private _scene: Scene;

    /**
     * Synthetic look-at target tracked manually.
     *
     * CesiumJS cameras have `position`, `direction`, `up`, `right` but no
     * explicit target. We maintain one so that orbit, pan, dolly, and shake
     * can operate relative to a meaningful focal point.
     *
     * Updated by: `setTarget`, `lookAt`, `animateTo`, `followPath`.
     * Read by: `orbit`, `dolly`, `pan`, `shake`, `getCameraState`.
     */
    private _target: Cartesian3;

    /** Logical camera name — always `"default"` since CesiumJS has one camera. */
    private readonly _cameraName: string = "default";

    /** Full MCP URI for this camera: `cesium://camera/default`. */
    private readonly _cameraUri: string;

    // ── Animation ────────────────────────────────────────────────────────

    /**
     * Cleanup function returned by `scene.preRender.addEventListener()`.
     * Called to remove the current frame-based animation callback.
     * `null` when no animation is active.
     */
    private _preRenderRemove: (() => void) | null = null;

    /** True while a frame-based animation (orbit, path, shake) is running. */
    private _isAnimating = false;

    // ── Constructor / Dispose ────────────────────────────────────────────

    /**
     * Creates a new CesiumJS camera adapter.
     *
     * @param viewer The CesiumJS `Viewer` instance. Provides access to:
     *   - `viewer.scene` — the 3D scene
     *   - `viewer.camera` — the scene's single camera
     *   - `viewer.canvas` — the rendering canvas (for snapshot)
     *   - `viewer.scene.screenSpaceCameraController` — user input control
     *
     * @throws If `viewer` is not provided.
     *
     * @example
     * ```typescript
     * const viewer = new Cesium.Viewer("cesiumContainer");
     * const adapter = new McpCameraAdapter(viewer);
     * const behavior = new McpCameraBehavior(adapter);
     * ```
     */
    public constructor(viewer: Viewer) {
        super(McpCesiumDomain);
        if (!viewer) {
            throw new Error("McpCameraAdapter requires a CesiumJS Viewer instance.");
        }
        this._viewer = viewer;
        this._scene = viewer.scene;
        this._cameraUri = `${McpCameraResourceUriPrefix}/${this._cameraName}`;

        // Compute an initial look-at target from the camera's current state.
        this._target = this._computeDefaultTarget();

    }

    /**
     * Returns the support level for a given tool.
     *
     * All camera tools are fully supported except `scene_visible_objects`
     * which is partial — CesiumJS does not have per-primitive frustum testing
     * like Babylon's `mesh.isInFrustum()`. The implementation iterates
     * entities and primitives but cannot guarantee precise frustum culling.
     */
    public override getToolSupport(toolName: string, _resourceType?: string): ToolSupport | undefined {
        if (toolName === McpCameraBehavior.SceneVisibleObjectsFn) {
            return ToolSupport.Partial;
        }
        return undefined; // all others: Full (default)
    }

    /** Stops any running animation and cleans up event emitters. */
    public override dispose(): void {
        this._stopAnimation();
        this._imageFiltering?.dispose();
        super.dispose();
    }

    // ── readResourceAsync ────────────────────────────────────────────────

    /**
     * Reads a camera resource by URI.
     *
     * Two URI patterns are handled:
     * - `cesium://camera`           → returns a JSON array with one camera entry
     *   `[{ uri, name: "default", type: "Camera" }]`
     * - `cesium://camera/default`   → returns the full {@link ICameraState}
     *
     * @returns `undefined` for any URI that does not match either pattern.
     */
    public async readResourceAsync(uri: string): Promise<McpResourceContent | undefined> {
        let text: string | undefined;

        if (uri === McpCameraResourceUriPrefix) {
            // List resource: single camera.
            text = JSON.stringify([
                {
                    uri: this._cameraUri,
                    name: this._cameraName,
                    type: "Camera",
                },
            ]);
        } else if (uri === this._cameraUri) {
            // Instance resource: full camera state.
            text = JSON.stringify(this._getCameraState());
        }

        return text ? { uri, text, mimeType: JsonRpcMimeType } : undefined;
    }

    // ── executeToolAsync ─────────────────────────────────────────────────

    /**
     * Dispatches a tool call to the CesiumJS camera.
     *
     * Returns a descriptive error result (never throws) if the URI is unknown
     * or the arguments are malformed.
     */
    public async executeToolAsync(uri: string, toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
        // CesiumJS has a single camera — validate the URI.
        if (uri !== this._cameraUri) {
            return McpToolResults.error(`No camera found for URI "${uri}". ` + `CesiumJS has a single camera at "${this._cameraUri}".`);
        }

        const camera = this._scene.camera;

        switch (toolName) {
            // -----------------------------------------------------------------
            // camera_set_target
            // -----------------------------------------------------------------
            case McpCameraBehavior.CameraSetTargetFn: {
                const target = this._resolveCoordinate(args["target"]);
                if (!target) {
                    return this._vec3Error(toolName, "target", args["target"]);
                }
                const cartTarget = this._toCartesian3(target);
                this._target = cartTarget;

                // Compute the direction from the current position to the new target.
                // CesiumJS camera.setView() accepts heading/pitch/roll which we derive
                // from the direction vector relative to the local East-North-Up frame.
                const direction = Cartesian3.subtract(cartTarget, camera.position, new Cartesian3());
                Cartesian3.normalize(direction, direction);
                camera.direction = direction;

                return McpToolResults.text(`Camera is now looking at (${target.x.toFixed(1)}, ${target.y.toFixed(1)}, ${target.z.toFixed(1)}).`);
            }

            // -----------------------------------------------------------------
            // camera_set_position
            // -----------------------------------------------------------------
            case McpCameraBehavior.CameraSetPositionFn: {
                const position = this._resolveCoordinate(args["position"]);
                if (!position) {
                    return this._vec3Error(toolName, "position", args["position"]);
                }
                camera.position = this._toCartesian3(position);
                return McpToolResults.text(`Camera moved to (${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}).`);
            }

            // -----------------------------------------------------------------
            // camera_look_at
            // -----------------------------------------------------------------
            case McpCameraBehavior.CameraLookAtFn: {
                const position = this._resolveCoordinate(args["position"]);
                const target = this._resolveCoordinate(args["target"]);
                if (!position) return this._vec3Error(toolName, "position", args["position"]);
                if (!target) return this._vec3Error(toolName, "target", args["target"]);

                const cartTarget = this._toCartesian3(target);
                const cartPosition = this._toCartesian3(position);
                this._target = cartTarget;

                // CesiumJS camera.lookAt(target, offset) sets the camera to look at
                // `target` from `target + offset`. We compute the offset as position - target.
                const offset = Cartesian3.subtract(cartPosition, cartTarget, new Cartesian3());
                camera.lookAt(cartTarget, offset);

                // lookAt locks the camera; unlock it so subsequent user interaction works.
                // We restore the position/direction manually and reset the transform.
                camera.lookAtTransform(Matrix4.IDENTITY);

                return McpToolResults.text(
                    `Camera placed at (${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}) ` +
                        `looking at (${target.x.toFixed(1)}, ${target.y.toFixed(1)}, ${target.z.toFixed(1)}).`
                );
            }

            // -----------------------------------------------------------------
            // camera_orbit
            // -----------------------------------------------------------------
            case McpCameraBehavior.CameraOrbitFn: {
                const deltaAlpha = ((args["deltaAlpha"] as number | undefined) ?? 0) * DEG_TO_RAD;
                const deltaBeta = ((args["deltaBeta"] as number | undefined) ?? 0) * DEG_TO_RAD;

                // Rotate the camera position around the tracked target.
                // deltaAlpha: horizontal (azimuth), deltaBeta: vertical (elevation).
                const target = this._target;
                let rel = Cartesian3.subtract(camera.position, target, new Cartesian3());

                if (deltaAlpha !== 0) {
                    // Rotate around the "up" axis at the target location.
                    // In ECEF, "up" at a point is the normalised position vector.
                    const up = Cartesian3.normalize(target, new Cartesian3());
                    const rotQuat = Quaternion.fromAxisAngle(up, -deltaAlpha, new Quaternion());
                    const rotMat = Matrix3.fromQuaternion(rotQuat, new Matrix3());
                    rel = Matrix3.multiplyByVector(rotMat, rel, rel);
                }

                if (deltaBeta !== 0) {
                    // Rotate around the camera's right vector.
                    const right = Cartesian3.normalize(camera.right, new Cartesian3());
                    const rotQuat = Quaternion.fromAxisAngle(right, -deltaBeta, new Quaternion());
                    const rotMat = Matrix3.fromQuaternion(rotQuat, new Matrix3());
                    rel = Matrix3.multiplyByVector(rotMat, rel, rel);
                }

                const newPos = Cartesian3.add(target, rel, new Cartesian3());
                camera.position = newPos;

                // Re-aim at target.
                const direction = Cartesian3.subtract(target, newPos, new Cartesian3());
                Cartesian3.normalize(direction, direction);
                camera.direction = direction;

                return McpToolResults.text(`Camera orbited Δα=${(deltaAlpha * RAD_TO_DEG).toFixed(1)}°, Δβ=${(deltaBeta * RAD_TO_DEG).toFixed(1)}°.`);
            }

            // -----------------------------------------------------------------
            // camera_set_fov
            // -----------------------------------------------------------------
            case McpCameraBehavior.CameraSetFovFn: {
                const fov = args["fov"] as number | undefined;
                const unit = (args["unit"] as string | undefined) ?? "deg";
                if (typeof fov !== "number" || !isFinite(fov) || fov <= 0) {
                    return McpToolResults.error(`Invalid "fov" for "${toolName}". Expected a positive number, got: ${JSON.stringify(args["fov"])}`);
                }
                if (!(camera.frustum instanceof PerspectiveFrustum)) {
                    return McpToolResults.error(
                        `Camera is in orthographic mode — setFov only applies to perspective cameras. ` + `Use "${McpCameraBehavior.CameraSetProjectionFn}" to switch modes first.`
                    );
                }
                const fovRad = unit === "rad" ? fov : fov * DEG_TO_RAD;
                camera.frustum.fov = fovRad;
                const label = unit === "rad" ? `${fov.toFixed(3)} rad` : `${fov}°`;
                return McpToolResults.text(`Camera FOV set to ${label}.`);
            }

            // -----------------------------------------------------------------
            // camera_zoom
            // -----------------------------------------------------------------
            case McpCameraBehavior.CameraZoomFn: {
                const factor = args["factor"] as number | undefined;
                if (typeof factor !== "number" || !isFinite(factor) || factor <= 0) {
                    return McpToolResults.error(`Invalid "factor" for "${toolName}". Expected a positive number, got: ${JSON.stringify(args["factor"])}`);
                }

                if (camera.frustum instanceof PerspectiveFrustum) {
                    // Lens zoom: scale the FOV, clamped to a reasonable range.
                    const currentFov = camera.frustum.fov ?? CesiumMath.toRadians(60);
                    camera.frustum.fov = Math.max(1 * DEG_TO_RAD, Math.min(170 * DEG_TO_RAD, currentFov * factor));
                    return McpToolResults.text(`Camera zoomed: FOV is now ${((camera.frustum.fov ?? currentFov) * RAD_TO_DEG).toFixed(1)}°.`);
                }

                if (camera.frustum instanceof OrthographicFrustum) {
                    // Orthographic zoom: scale the frustum width.
                    const currentWidth = camera.frustum.width ?? 1;
                    camera.frustum.width = currentWidth * factor;
                    return McpToolResults.text(`Camera zoomed: orthographic width scaled to ${(camera.frustum.width ?? currentWidth).toFixed(1)}.`);
                }

                return McpToolResults.error(`Unsupported frustum type for zoom.`);
            }

            // -----------------------------------------------------------------
            // camera_set_projection
            // -----------------------------------------------------------------
            case McpCameraBehavior.CameraSetProjectionFn: {
                const mode = args["mode"] as string | undefined;
                const fov = args["fov"] as number | undefined;
                const orthoSize = args["orthoSize"] as number | undefined;

                if (mode === "perspective") {
                    // switchToPerspectiveFrustum() is available on the Scene,
                    // but we can also directly assign a new PerspectiveFrustum.
                    camera.switchToPerspectiveFrustum();
                    if (typeof fov === "number" && fov > 0 && camera.frustum instanceof PerspectiveFrustum) {
                        camera.frustum.fov = fov * DEG_TO_RAD;
                    }
                    const fovLabel = typeof fov === "number" ? ` with FOV ${fov}°` : "";
                    return McpToolResults.text(`Camera switched to perspective projection${fovLabel}.`);
                }

                if (mode === "orthographic") {
                    camera.switchToOrthographicFrustum();
                    if (typeof orthoSize === "number" && orthoSize > 0 && camera.frustum instanceof OrthographicFrustum) {
                        camera.frustum.width = orthoSize;
                    }
                    const sizeLabel = typeof orthoSize === "number" ? ` with width ${orthoSize}` : "";
                    return McpToolResults.text(`Camera switched to orthographic projection${sizeLabel}.`);
                }

                return McpToolResults.error(`Invalid "mode" for "${toolName}". Expected "perspective" or "orthographic", got: ${JSON.stringify(mode)}`);
            }

            // -----------------------------------------------------------------
            // camera_dolly
            // -----------------------------------------------------------------
            case McpCameraBehavior.CameraDollyFn: {
                const distance = args["distance"] as number | undefined;
                if (typeof distance !== "number" || !isFinite(distance)) {
                    return McpToolResults.error(`Invalid "distance" for "${toolName}". Expected a finite number, got: ${JSON.stringify(args["distance"])}`);
                }

                // Move along the camera's direction vector (forward = positive).
                // CesiumJS camera.direction is a unit vector.
                const moveVector = Cartesian3.multiplyByScalar(camera.direction, distance, new Cartesian3());
                camera.position = Cartesian3.add(camera.position, moveVector, new Cartesian3());

                return McpToolResults.text(`Camera dollied ${distance > 0 ? "in" : "out"} by ${Math.abs(distance).toFixed(3)} metres.`);
            }

            // -----------------------------------------------------------------
            // camera_pan
            // -----------------------------------------------------------------
            case McpCameraBehavior.CameraPanFn: {
                const deltaX = args["deltaX"] as number | undefined;
                const deltaY = args["deltaY"] as number | undefined;
                if (typeof deltaX !== "number" || !isFinite(deltaX) || typeof deltaY !== "number" || !isFinite(deltaY)) {
                    return McpToolResults.error(
                        `Invalid "deltaX" or "deltaY" for "${toolName}". ` +
                            `Expected finite numbers, got: deltaX=${JSON.stringify(args["deltaX"])}, deltaY=${JSON.stringify(args["deltaY"])}`
                    );
                }

                // Pan along the camera's right and up vectors.
                // This slides both the camera position and the tracked target.
                const panOffset = new Cartesian3();
                Cartesian3.add(panOffset, Cartesian3.multiplyByScalar(camera.right, deltaX, new Cartesian3()), panOffset);
                Cartesian3.add(panOffset, Cartesian3.multiplyByScalar(camera.up, deltaY, new Cartesian3()), panOffset);

                camera.position = Cartesian3.add(camera.position, panOffset, new Cartesian3());
                this._target = Cartesian3.add(this._target, panOffset, new Cartesian3());

                return McpToolResults.text(`Camera panned (Δright=${deltaX}, Δup=${deltaY}).`);
            }

            // -----------------------------------------------------------------
            // camera_lock
            // -----------------------------------------------------------------
            case McpCameraBehavior.CameraLockFn: {
                // Disable all user camera interaction (mouse, keyboard, touch).
                this._scene.screenSpaceCameraController.enableInputs = false;
                return McpToolResults.text(`Camera locked — user input detached.`);
            }

            // -----------------------------------------------------------------
            // camera_unlock
            // -----------------------------------------------------------------
            case McpCameraBehavior.CameraUnlockFn: {
                this._scene.screenSpaceCameraController.enableInputs = true;
                return McpToolResults.text(`Camera unlocked — user input restored.`);
            }

            // -----------------------------------------------------------------
            // camera_snapshot
            // -----------------------------------------------------------------
            case McpCameraBehavior.CameraSnapshotFn: {
                const rawFilters = args["filters"];
                // Omitted → empty array (raw capture, no filters).
                // Callers must explicitly name the filters they want.
                const filterNames: string[] = rawFilters === undefined
                    ? []
                    : Array.isArray(rawFilters)
                        ? rawFilters as string[]
                        : typeof rawFilters === "string"
                            ? [rawFilters]
                            : [];

                try {
                    // Force a render so the canvas has the latest frame.
                    this._viewer.render();

                    const canvas = this._viewer.canvas as HTMLCanvasElement;
                    const w = canvas.width;
                    const h = canvas.height;

                    // Read raw RGBA pixels directly from the WebGL framebuffer.
                    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
                    if (!gl) {
                        return McpToolResults.error("Snapshot failed: unable to obtain WebGL context.");
                    }
                    const pixels = new Uint8Array(w * h * 4);
                    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

                    // WebGL readPixels returns rows bottom-to-top; flip vertically.
                    const flipped = new Uint8ClampedArray(w * h * 4);
                    const rowBytes = w * 4;
                    for (let y = 0; y < h; y++) {
                        flipped.set(pixels.subarray((h - 1 - y) * rowBytes, (h - y) * rowBytes), y * rowBytes);
                    }
                    const imageData = new ImageData(flipped, w, h);

                    const ctx = { viewer: this._viewer, scene: this._scene };

                    // Check if any requested filter is a text filter (e.g. ASCII).
                    const textFilterEntry = filterNames
                        .map((n) => this.imageFiltering.getFilter(n))
                        .find((f) => f !== undefined && isTextSnapshotFilter(f));

                    if (textFilterEntry) {
                        // Run any non-text image filters first, then produce text.
                        const imageFilterNames = filterNames.filter((n) => {
                            const f = this.imageFiltering.getFilter(n);
                            return f !== undefined && !isTextSnapshotFilter(f);
                        });
                        const filtered = imageFilterNames.length > 0
                            ? await this.imageFiltering.applyFiltersAsync(imageData, imageFilterNames, ctx)
                            : imageData;
                        const text = await this.imageFiltering.applyAsTextAsync(filtered, textFilterEntry.name, ctx);
                        return McpToolResults.text(text);
                    }

                    // Run the snapshot filter pipeline on raw pixels.
                    const filtered = await this.imageFiltering.applyFiltersAsync(imageData, filterNames, ctx);

                    // Single base64 encode at the very end.
                    const base64 = await this.imageFiltering.imageDataToBase64(filtered);
                    return McpToolResults.image(base64, "image/png");
                } catch (err) {
                    return McpToolResults.error(`Snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
                }
            }

            // -----------------------------------------------------------------
            // camera_lidar — depth buffer as compact lidar grid
            // -----------------------------------------------------------------
            case McpCameraBehavior.CameraLidarFn: {
                const beams = (args["beams"] as number | undefined) ?? 16;
                const angularResolution = (args["angularResolution"] as number | undefined) ?? 1.0;
                const encoding = (args["encoding"] as "uint16" | "float32" | undefined) ?? "uint16";

                try {
                    // Ensure fresh render.
                    this._viewer.render();

                    const canvas = this._viewer.canvas as HTMLCanvasElement;
                    const w = canvas.width;
                    const h = canvas.height;

                    // Compute horizontal FOV in degrees.
                    const frustum = this._scene.camera.frustum;
                    let hFovDeg: number;
                    if (frustum instanceof PerspectiveFrustum && frustum.fov !== undefined && frustum.aspectRatio !== undefined) {
                        // PerspectiveFrustum.fov is the vertical FOV; compute hFov from aspect.
                        hFovDeg = 2 * Math.atan(Math.tan(frustum.fov / 2) * frustum.aspectRatio) * RAD_TO_DEG;
                    } else {
                        // Orthographic — use a sensible default angular span.
                        hFovDeg = 60;
                    }

                    const cols = Math.max(1, Math.floor(hFovDeg / angularResolution));
                    const rows = beams;

                    // Read depth buffer via WebGL.
                    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
                    if (!gl) {
                        return McpToolResults.error("Lidar failed: unable to obtain WebGL context.");
                    }

                    const depthPixels = new Float32Array(w * h);
                    // gl.DEPTH_COMPONENT = 0x1902
                    gl.readPixels(0, 0, w, h, 0x1902, gl.FLOAT, depthPixels);

                    // Linearize depth.  Cesium uses logarithmic depth by default.
                    // depth_buffer values are in [0, 1] non-linear.
                    // Linear depth = (near * far) / (far - depth * (far - near))
                    const near = frustum instanceof PerspectiveFrustum ? frustum.near : 0.1;
                    const far = frustum instanceof PerspectiveFrustum ? frustum.far : 100000;
                    const range = far - near;
                    for (let i = 0; i < depthPixels.length; i++) {
                        const zNdc = depthPixels[i];
                        const linearZ = (near * far) / (far - zNdc * range);
                        depthPixels[i] = Math.min(Math.max((linearZ - near) / range, 0), 1);
                    }

                    // Flip vertically (WebGL reads bottom-to-top).
                    const flipped = new Float32Array(w * h);
                    for (let y = 0; y < h; y++) {
                        flipped.set(depthPixels.subarray((h - 1 - y) * w, (h - y) * w), y * w);
                    }

                    // Downsample and encode.
                    const grid = downsampleDepthGrid(flipped, w, h, cols, rows, near, far);
                    const result = encodeDepthGrid(grid, cols, rows, near, far, hFovDeg, angularResolution, encoding);

                    return McpToolResults.json(result);
                } catch (err) {
                    return McpToolResults.error(`Lidar failed: ${err instanceof Error ? err.message : String(err)}`);
                }
            }

            // -----------------------------------------------------------------
            // camera_animate_to
            // -----------------------------------------------------------------
            case McpCameraBehavior.CameraAnimateToFn: {
                const posArg = args["position"] !== undefined ? this._resolveCoordinate(args["position"]) : undefined;
                const tgtArg = args["target"] !== undefined ? this._resolveCoordinate(args["target"]) : undefined;
                const fovArg = args["fov"] as number | undefined;
                const duration = typeof args["duration"] === "number" && args["duration"] > 0 ? args["duration"] : 1;
                const easingStr = args["easing"] as string | undefined;

                if (args["position"] !== undefined && !posArg) return this._vec3Error(toolName, "position", args["position"]);
                if (args["target"] !== undefined && !tgtArg) return this._vec3Error(toolName, "target", args["target"]);

                const endPos = posArg ? this._toCartesian3(posArg) : undefined;
                const endTarget = tgtArg ? this._toCartesian3(tgtArg) : undefined;

                if (!endPos && !endTarget && fovArg === undefined) {
                    return McpToolResults.text(`Camera: nothing to animate (specify at least one of position, target, or fov).`);
                }

                // Determine the destination for camera.flyTo().
                // flyTo needs a `destination` (position) and an optional `orientation`.
                const destination = endPos ?? Cartesian3.clone(camera.position, new Cartesian3());

                // If a target is specified, compute heading/pitch/roll toward it
                // from the destination position. Otherwise keep the current orientation.
                let orientation: { heading: number; pitch: number; roll: number } | undefined;
                if (endTarget) {
                    this._target = endTarget;
                    const dir = Cartesian3.subtract(endTarget, destination, new Cartesian3());
                    Cartesian3.normalize(dir, dir);
                    // Compute heading, pitch from the direction in the local ENU frame
                    // at the destination point.
                    const hpr = this._directionToHeadingPitchRoll(destination, dir);
                    orientation = { heading: hpr.heading, pitch: hpr.pitch, roll: 0 };
                }

                // Handle FOV change — apply it at the end since flyTo doesn't animate FOV.
                const endFov = typeof fovArg === "number" && isFinite(fovArg) && camera.frustum instanceof PerspectiveFrustum ? fovArg * DEG_TO_RAD : undefined;

                return await new Promise<McpToolResult>((resolve) => {
                    camera.flyTo({
                        destination,
                        orientation,
                        duration,
                        easingFunction: this._mapEasingFunction(easingStr),
                        complete: () => {
                            if (endFov !== undefined && camera.frustum instanceof PerspectiveFrustum) {
                                camera.frustum.fov = endFov;
                            }
                            resolve(McpToolResults.text(`Camera animation complete.`));
                        },
                        cancel: () => {
                            resolve(McpToolResults.text(`Camera animation cancelled.`));
                        },
                    });
                });
            }

            // -----------------------------------------------------------------
            // camera_animate_orbit
            // -----------------------------------------------------------------
            case McpCameraBehavior.CameraAnimateOrbitFn: {
                const deltaAlpha = ((args["deltaAlpha"] as number | undefined) ?? 0) * DEG_TO_RAD;
                const deltaBeta = ((args["deltaBeta"] as number | undefined) ?? 0) * DEG_TO_RAD;
                const duration = typeof args["duration"] === "number" && args["duration"] > 0 ? args["duration"] : 2;
                const loop = args["loop"] === true;
                const easingStr = loop ? undefined : (args["easing"] as string | undefined);

                const target = Cartesian3.clone(this._target, new Cartesian3());

                if (loop) {
                    // Continuous turntable: constant angular velocity per frame.
                    this._animateLoop((dt) => {
                        const frac = dt / duration;
                        this._orbitStep(target, deltaAlpha * frac, deltaBeta * frac);
                    });
                    return McpToolResults.text(`Camera turntable started. Call camera_stop_animation to stop.`);
                }

                // Non-looping: animate from current angles to current + delta.
                const startPos = Cartesian3.clone(camera.position, new Cartesian3());
                const startDir = Cartesian3.clone(camera.direction, new Cartesian3());

                return await new Promise<McpToolResult>((resolve) => {
                    this._animate(
                        duration,
                        easingStr,
                        (t) => {
                            // Reset to start position, then apply partial rotation.
                            camera.position = Cartesian3.clone(startPos, new Cartesian3());
                            camera.direction = Cartesian3.clone(startDir, new Cartesian3());
                            this._orbitStep(target, deltaAlpha * t, deltaBeta * t);
                        },
                        () => {
                            resolve(McpToolResults.text(`Camera orbit animation complete.`));
                        }
                    );
                });
            }

            // -----------------------------------------------------------------
            // camera_follow_path
            // -----------------------------------------------------------------
            case McpCameraBehavior.CameraFollowPathFn: {
                const waypointsArg = args["waypoints"] as
                    | Array<{
                          position?: { x: number; y: number; z: number };
                          target?: { x: number; y: number; z: number };
                      }>
                    | undefined;
                const duration = typeof args["duration"] === "number" && args["duration"] > 0 ? args["duration"] : 3;
                const easingStr = args["easing"] as string | undefined;

                if (!Array.isArray(waypointsArg) || waypointsArg.length < 2) {
                    return McpToolResults.error(`"waypoints" must be an array of at least 2 items for "${toolName}".`);
                }

                // Pre-process waypoints: carry forward missing position/target.
                const positions: Cartesian3[] = [];
                const targets: Cartesian3[] = [];
                let lastPos = Cartesian3.clone(camera.position, new Cartesian3());
                let lastTgt = Cartesian3.clone(this._target, new Cartesian3());

                for (let i = 0; i < waypointsArg.length; i++) {
                    const wp = waypointsArg[i];
                    if (wp.position !== undefined) {
                        const resolved = this._resolveCoordinate(wp.position);
                        if (!resolved) return this._vec3Error(toolName, `waypoints[${i}].position`, wp.position);
                        lastPos = this._toCartesian3(resolved);
                    }
                    if (wp.target !== undefined) {
                        const resolved = this._resolveCoordinate(wp.target);
                        if (!resolved) return this._vec3Error(toolName, `waypoints[${i}].target`, wp.target);
                        lastTgt = this._toCartesian3(resolved);
                    }
                    positions.push(Cartesian3.clone(lastPos, new Cartesian3()));
                    targets.push(Cartesian3.clone(lastTgt, new Cartesian3()));
                }

                const N = positions.length; // >= 2

                return await new Promise<McpToolResult>((resolve) => {
                    this._animate(
                        duration,
                        easingStr,
                        (t) => {
                            // Map t -> segment index + local t within that segment.
                            const segPos = t * (N - 1);
                            const idx = Math.min(Math.floor(segPos), N - 2);
                            const localT = segPos - idx;

                            const lerpedPos = Cartesian3.lerp(positions[idx], positions[idx + 1], localT, new Cartesian3());
                            const lerpedTgt = Cartesian3.lerp(targets[idx], targets[idx + 1], localT, new Cartesian3());

                            camera.position = lerpedPos;
                            const dir = Cartesian3.subtract(lerpedTgt, lerpedPos, new Cartesian3());
                            Cartesian3.normalize(dir, dir);
                            camera.direction = dir;
                            this._target = lerpedTgt;
                        },
                        () => {
                            resolve(McpToolResults.text(`Camera path complete.`));
                        }
                    );
                });
            }

            // -----------------------------------------------------------------
            // camera_shake
            // -----------------------------------------------------------------
            case McpCameraBehavior.CameraShakeFn: {
                const intensity = typeof args["intensity"] === "number" && args["intensity"] > 0 ? args["intensity"] : 0.5;
                const duration = typeof args["duration"] === "number" && args["duration"] > 0 ? args["duration"] : 1;
                const frequency = typeof args["frequency"] === "number" && args["frequency"] > 0 ? args["frequency"] : 12;

                const baseDir = Cartesian3.clone(camera.direction, new Cartesian3());
                const TAU = 2 * Math.PI;

                return await new Promise<McpToolResult>((resolve) => {
                    this._animate(
                        duration,
                        undefined, // no easing for shake — linear decay
                        (t) => {
                            const elapsed = t * duration;
                            const amplitude = intensity * (1 - t); // linear decay

                            // Three-layer sinusoids at different frequencies and phases
                            // for an organic feel.
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

                            // Apply the shake offset along the camera's right and up vectors.
                            const offset = new Cartesian3();
                            Cartesian3.add(offset, Cartesian3.multiplyByScalar(camera.right, dx, new Cartesian3()), offset);
                            Cartesian3.add(offset, Cartesian3.multiplyByScalar(camera.up, dy, new Cartesian3()), offset);

                            const shakenDir = Cartesian3.add(baseDir, offset, new Cartesian3());
                            Cartesian3.normalize(shakenDir, shakenDir);
                            camera.direction = shakenDir;
                        },
                        () => {
                            // Restore the original look direction on completion.
                            camera.direction = Cartesian3.clone(baseDir, new Cartesian3());
                            resolve(McpToolResults.text(`Camera shake complete.`));
                        }
                    );
                });
            }

            // -----------------------------------------------------------------
            // camera_stop_animation
            // -----------------------------------------------------------------
            case McpCameraBehavior.CameraStopAnimationFn: {
                const wasRunning = this._isAnimating;
                this._stopAnimation();
                // Also cancel any CesiumJS built-in flight (from camera.flyTo).
                camera.cancelFlight();
                return McpToolResults.text(wasRunning ? `Camera animation stopped.` : `Camera had no active animation.`);
            }

            // -----------------------------------------------------------------
            // scene_visible_objects
            // -----------------------------------------------------------------
            case McpCameraBehavior.SceneVisibleObjectsFn: {
                return McpToolResults.json(this._handleSceneVisibleObjects(args));
            }

            // -----------------------------------------------------------------
            // scene_pick_from_center
            // -----------------------------------------------------------------
            case McpCameraBehavior.ScenePickFromCenterFn: {
                return McpToolResults.json(this._handleScenePickFromCenter(args));
            }

            // -----------------------------------------------------------------
            // Unknown
            // -----------------------------------------------------------------
            default: {
                return McpToolResults.error(`Unknown tool "${toolName}" for Cesium camera adapter. Available tools: "${ALL_TOOLS}".`);
            }
        }
    }

    // =====================================================================
    // PRIVATE HELPERS
    // =====================================================================

    // ── Vector helpers ───────────────────────────────────────────────────

    /**
     * Converts an MCP `{x, y, z}` object to a CesiumJS `Cartesian3`.
     *
     * No coordinate conversion is needed: MCP coordinates and CesiumJS ECEF
     * are both right-handed. The consumer provides positions in metres from
     * Earth's centre.
     */
    /**
     * Resolves an MCP coordinate argument to `{x, y, z}`.
     * Accepts either Cartesian `{x,y,z}` or geographic `{lat,lon,alt?}` (WGS84 → ECEF).
     */
    private _resolveCoordinate(v: unknown): { x: number; y: number; z: number } | undefined {
        if (!v || typeof v !== "object") return undefined;
        const resolved = resolveToCartesian3(v as Record<string, unknown>);
        if (!resolved || !isFinite(resolved.x) || !isFinite(resolved.y) || !isFinite(resolved.z)) return undefined;
        return resolved;
    }

    private _toCartesian3(v: { x: number; y: number; z: number }): Cartesian3 {
        return new Cartesian3(v.x, v.y, v.z);
    }

    /** Converts a CesiumJS `Cartesian3` to an MCP-compatible `{x, y, z}` plain object. */
    private _fromCartesian3(c: Cartesian3): { x: number; y: number; z: number } {
        return { x: c.x, y: c.y, z: c.z };
    }

    /** Builds a standardised argument-validation error for coordinate parameters. */
    private _vec3Error(toolName: string, paramName: string, received: unknown): McpToolResult {
        return McpToolResults.error(
            `Invalid "${paramName}" argument for "${toolName}". ` +
                `Expected { x, y, z } (ECEF metres) or { lat, lon, alt? } (WGS84 degrees). ` +
                `Received: ${JSON.stringify(received)}`
        );
    }

    // ── Camera state ─────────────────────────────────────────────────────

    /**
     * Serializes the current state of the CesiumJS camera into an {@link ICameraState}.
     *
     * Returns position, direction, up, frustum info, and the synthetic target.
     * All values are in ECEF metres (right-handed).
     */
    private _getCameraState(): ICameraState {
        const camera = this._scene.camera;

        // Frustum
        let frustum: IFrustum;
        if (camera.frustum instanceof PerspectiveFrustum) {
            frustum = {
                kind: "perspective",
                fov: camera.frustum.fov ?? CesiumMath.toRadians(60),
                near: camera.frustum.near,
                far: camera.frustum.far,
            };
        } else if (camera.frustum instanceof OrthographicFrustum) {
            const width = camera.frustum.width ?? 1;
            const aspectRatio = camera.frustum.aspectRatio ?? 1;
            const halfW = width / 2;
            const halfH = halfW / aspectRatio;
            frustum = {
                kind: "orthographic",
                near: camera.frustum.near,
                far: camera.frustum.far,
                size: width,
                left: -halfW,
                right: halfW,
                top: halfH,
                bottom: -halfH,
            };
        } else {
            // Fallback
            frustum = { kind: "perspective", fov: CesiumMath.toRadians(60) };
        }

        const state: ICameraState = {
            name: this._cameraName,
            position: this._fromCartesian3(camera.position),
            target: this._fromCartesian3(this._target),
            up: this._fromCartesian3(camera.up),
            frustum,
            viewport: {
                x: 0,
                y: 0,
                width: this._viewer.canvas.clientWidth,
                height: this._viewer.canvas.clientHeight,
            },
            isEnabled: true,
        };

        // Heading/Pitch/Roll as rotation
        state.rotationEuler = {
            x: camera.pitch,
            y: camera.heading,
            z: camera.roll,
        };

        return state;
    }

    /**
     * Computes a default look-at target from the camera's current position
     * and direction.
     *
     * Since CesiumJS cameras have no explicit target, we project a point
     * along the camera's direction vector at {@link DEFAULT_TARGET_DISTANCE}.
     */
    private _computeDefaultTarget(): Cartesian3 {
        const camera = this._scene.camera;
        return Cartesian3.add(camera.position, Cartesian3.multiplyByScalar(camera.direction, DEFAULT_TARGET_DISTANCE, new Cartesian3()), new Cartesian3());
    }

    // ── Orbit helper ─────────────────────────────────────────────────────

    /**
     * Performs a single orbit step: rotates the camera position around
     * `target` by `dAlpha` (azimuth) and `dBeta` (elevation) radians.
     *
     * After moving the position, re-aims the camera direction at the target.
     */
    private _orbitStep(target: Cartesian3, dAlpha: number, dBeta: number): void {
        const camera = this._scene.camera;
        let rel = Cartesian3.subtract(camera.position, target, new Cartesian3());

        if (dAlpha !== 0) {
            const up = Cartesian3.normalize(target, new Cartesian3());
            const rotQuat = Quaternion.fromAxisAngle(up, -dAlpha, new Quaternion());
            const rotMat = Matrix3.fromQuaternion(rotQuat, new Matrix3());
            rel = Matrix3.multiplyByVector(rotMat, rel, rel);
        }

        if (dBeta !== 0) {
            const right = Cartesian3.normalize(camera.right, new Cartesian3());
            const rotQuat = Quaternion.fromAxisAngle(right, -dBeta, new Quaternion());
            const rotMat = Matrix3.fromQuaternion(rotQuat, new Matrix3());
            rel = Matrix3.multiplyByVector(rotMat, rel, rel);
        }

        const newPos = Cartesian3.add(target, rel, new Cartesian3());
        camera.position = newPos;
        const direction = Cartesian3.subtract(target, newPos, new Cartesian3());
        Cartesian3.normalize(direction, direction);
        camera.direction = direction;
    }

    // ── Direction to Heading/Pitch/Roll ──────────────────────────────────

    /**
     * Converts a direction vector to heading/pitch/roll in the local ENU
     * (East-North-Up) frame at a given position.
     *
     * This is used by `camera_animate_to` to construct the orientation
     * parameter for `camera.flyTo()`.
     *
     * @param position   The camera position (ECEF Cartesian3).
     * @param direction  The desired forward direction (unit vector).
     * @returns Heading, pitch, roll in radians.
     */
    private _directionToHeadingPitchRoll(position: Cartesian3, direction: Cartesian3): { heading: number; pitch: number; roll: number } {
        // Build the local East-North-Up frame at the given position.
        const transform = Transforms.eastNorthUpToFixedFrame(position);
        const invTransform = Matrix4.inverse(transform, new Matrix4());

        // Transform the direction into the local frame.
        const localDir = Matrix4.multiplyByPointAsVector(invTransform, direction, new Cartesian3());

        // In the ENU frame:
        // East  = +X, North = +Y, Up = +Z
        // heading = angle from North (Y) toward East (X), measured clockwise
        // pitch   = elevation from the horizontal plane
        const heading = Math.atan2(localDir.x, localDir.y);
        const horizontal = Math.sqrt(localDir.x * localDir.x + localDir.y * localDir.y);
        const pitch = Math.atan2(localDir.z, horizontal);

        return {
            heading: CesiumMath.zeroToTwoPi(heading),
            pitch,
            roll: 0,
        };
    }

    // ── Easing ───────────────────────────────────────────────────────────

    /**
     * Maps an MCP easing string to a CesiumJS `EasingFunction` constant.
     *
     * CesiumJS easing functions are static constants on the `EasingFunction`
     * object. The string format is `"<type>"` or `"<type>.<mode>"`:
     *
     * | MCP String      | CesiumJS Constant                           |
     * |-----------------|---------------------------------------------|
     * | `"linear"`      | `EasingFunction.LINEAR_NONE`                |
     * | `"sine.in"`     | `EasingFunction.SINUSOIDAL_IN`              |
     * | `"sine.out"`    | `EasingFunction.SINUSOIDAL_OUT`             |
     * | `"sine.inout"`  | `EasingFunction.SINUSOIDAL_IN_OUT`          |
     * | `"quad.in"`     | `EasingFunction.QUADRATIC_IN`               |
     * | `"quad.out"`    | `EasingFunction.QUADRATIC_OUT`              |
     * | `"quad.inout"`  | `EasingFunction.QUADRATIC_IN_OUT`           |
     * | `"cubic.in"`    | `EasingFunction.CUBIC_IN`                   |
     * | `"cubic.out"`   | `EasingFunction.CUBIC_OUT`                  |
     * | `"cubic.inout"` | `EasingFunction.CUBIC_IN_OUT`               |
     * | `"expo.in"`     | `EasingFunction.EXPONENTIAL_IN`             |
     * | `"expo.out"`    | `EasingFunction.EXPONENTIAL_OUT`            |
     * | `"expo.inout"`  | `EasingFunction.EXPONENTIAL_IN_OUT`         |
     * | `"back.in"`     | `EasingFunction.BACK_IN`                    |
     * | `"back.out"`    | `EasingFunction.BACK_OUT`                   |
     * | `"back.inout"`  | `EasingFunction.BACK_IN_OUT`                |
     * | `"bounce.in"`   | `EasingFunction.BOUNCE_IN`                  |
     * | `"bounce.out"`  | `EasingFunction.BOUNCE_OUT`                 |
     * | `"bounce.inout"`| `EasingFunction.BOUNCE_IN_OUT`              |
     * | `"elastic.in"`  | `EasingFunction.ELASTIC_IN`                 |
     * | `"elastic.out"` | `EasingFunction.ELASTIC_OUT`                |
     * | `"elastic.inout"`| `EasingFunction.ELASTIC_IN_OUT`            |
     * | `"circle.in"`   | `EasingFunction.CIRCULAR_IN`                |
     * | `"circle.out"`  | `EasingFunction.CIRCULAR_OUT`               |
     * | `"circle.inout"`| `EasingFunction.CIRCULAR_IN_OUT`            |
     *
     * @param easingStr MCP easing string, e.g. `"sine.inout"`. Defaults to undefined.
     * @returns A CesiumJS `EasingFunction.*` callback, or `undefined` for default easing.
     */
    private _mapEasingFunction(easingStr?: string): EasingFunction.Callback | undefined {
        if (!easingStr) return undefined;
        const parts = easingStr.toLowerCase().split(".");
        const type = parts[0];
        const mode = parts[1] ?? "inout";

        if (type === "linear") return EasingFunction.LINEAR_NONE;

        // Build a lookup key like "SINUSOIDAL_IN_OUT"
        const typeMap: Record<string, string> = {
            sine: "SINUSOIDAL",
            quad: "QUADRATIC",
            cubic: "CUBIC",
            expo: "EXPONENTIAL",
            back: "BACK",
            bounce: "BOUNCE",
            elastic: "ELASTIC",
            circle: "CIRCULAR",
        };
        const modeMap: Record<string, string> = {
            in: "IN",
            out: "OUT",
            inout: "IN_OUT",
        };

        const cesiumType = typeMap[type];
        const cesiumMode = modeMap[mode] ?? "IN_OUT";

        if (cesiumType) {
            const key = `${cesiumType}_${cesiumMode}` as keyof typeof EasingFunction;
            const fn = EasingFunction[key] as EasingFunction.Callback | undefined;
            if (fn) return fn;
        }

        // Fallback: default CesiumJS easing
        return undefined;
    }

    // ── Animation helpers ────────────────────────────────────────────────

    /**
     * Registers a one-shot per-frame animation that runs for `durationSecs`.
     *
     * Uses `scene.preRender.addEventListener()` for per-frame callbacks.
     * CesiumJS returns a removal function from `addEventListener`.
     *
     * Each frame `onFrame(easedT)` is called with `easedT` in [0, 1].
     * `onComplete()` is called when `rawT` reaches 1.
     *
     * Any existing frame-based animation is cancelled first.
     *
     * @param durationSecs Total animation duration in seconds.
     * @param easingStr    Optional MCP easing string.
     * @param onFrame      Called each frame with the eased normalised time.
     * @param onComplete   Called once when the animation finishes.
     */
    private _animate(durationSecs: number, easingStr: string | undefined, onFrame: (easedT: number) => void, onComplete?: () => void): void {
        this._stopAnimation();
        const easingFn = this._mapEasingFunction(easingStr);
        let lastTime: number | null = null;
        let elapsed = 0;

        const callback = () => {
            const now = Date.now() / 1000;
            if (lastTime === null) {
                lastTime = now;
                return;
            }
            const dt = now - lastTime;
            lastTime = now;
            elapsed += dt;

            const rawT = Math.min(elapsed / durationSecs, 1);
            const easedT = easingFn ? easingFn(rawT) : rawT;
            onFrame(easedT);

            if (rawT >= 1) {
                this._stopAnimation();
                onComplete?.();
            }
        };

        this._preRenderRemove = this._scene.preRender.addEventListener(callback);
        this._isAnimating = true;
    }

    /**
     * Registers a looping per-frame animation that runs indefinitely.
     *
     * Each frame `onFrame(dtSecs)` is called with the delta time since the
     * last frame. Stop with {@link _stopAnimation}.
     */
    private _animateLoop(onFrame: (dtSecs: number) => void): void {
        this._stopAnimation();
        let lastTime: number | null = null;

        const callback = () => {
            const now = Date.now() / 1000;
            if (lastTime === null) {
                lastTime = now;
                return;
            }
            const dt = now - lastTime;
            lastTime = now;
            onFrame(dt);
        };

        this._preRenderRemove = this._scene.preRender.addEventListener(callback);
        this._isAnimating = true;
    }

    /** Cancels any active frame-based animation. */
    private _stopAnimation(): void {
        if (this._preRenderRemove) {
            this._preRenderRemove();
            this._preRenderRemove = null;
        }
        this._isAnimating = false;
    }

    // ── Scene query helpers ──────────────────────────────────────────────

    /**
     * Returns a structured description of objects visible in the scene.
     *
     * **Partial support**: CesiumJS does not provide per-primitive frustum
     * testing like Babylon's `mesh.isInFrustum()`. This implementation
     * iterates `scene.primitives` and data sources to build a list, but
     * cannot guarantee precise frustum culling for all primitive types.
     *
     * Entities with positions are included. Primitives without easily
     * queryable positions are listed by type.
     */
    private _handleSceneVisibleObjects(args: Record<string, unknown>): ISceneVisibleObjectsState {
        const camera = this._scene.camera;
        const maxObjects = typeof args["maxObjects"] === "number" && args["maxObjects"] > 0 ? Math.floor(args["maxObjects"]) : 50;

        const visible: IVisibleObjectState[] = [];
        let filteredOut = 0;

        // Iterate entities from all data sources.
        // CesiumJS entities have optional position properties.
        const allEntities = this._viewer.entities.values;
        for (const entity of allEntities) {
            if (visible.length >= maxObjects) {
                filteredOut++;
                continue;
            }

            const name = entity.name ?? entity.id;
            const positionProp = entity.position;
            let worldPos: Cartesian3 | undefined;
            let distance = 0;

            if (positionProp) {
                try {
                    worldPos = positionProp.getValue(this._viewer.clock.currentTime);
                    if (worldPos) {
                        distance = Cartesian3.distance(camera.position, worldPos);
                    }
                } catch {
                    // Position not available at current time
                }
            }

            const entry: IVisibleObjectState = {
                id: entity.id,
                name: name ?? "unnamed",
                type: "mesh",
                distance,
                screenCoverage: 0, // Not computable for CesiumJS entities without projection
            };

            if (worldPos) {
                entry.position = this._fromCartesian3(worldPos);
            }

            visible.push(entry);
        }

        // Sort by distance (closest first).
        visible.sort((a, b) => a.distance - b.distance);

        // Truncate to maxObjects.
        if (visible.length > maxObjects) {
            const excess = visible.splice(maxObjects);
            filteredOut += excess.length;
        }

        // Camera summary.
        const cameraInfo = {
            name: this._cameraName,
            position: this._fromCartesian3(camera.position),
            forward: this._fromCartesian3(camera.direction),
            ...(camera.frustum instanceof PerspectiveFrustum ? { fov: camera.frustum.fov } : {}),
        };

        return {
            camera: cameraInfo,
            visible,
            stats: { count: visible.length, filteredOut },
        };
    }

    /**
     * Casts a picking ray from the camera through a normalized screen point.
     *
     * Uses CesiumJS picking:
     * - `scene.pick(windowPosition)` → first object at pixel
     * - `scene.drillPick(windowPosition)` → all objects at pixel (when `allHits` is true)
     * - `scene.pickPosition(windowPosition)` → world-space Cartesian3 of the hit point
     *
     * The screen point is normalised: (0,0) = top-left, (1,1) = bottom-right.
     * Default is (0.5, 0.5) = screen centre.
     */
    private _handleScenePickFromCenter(args: Record<string, unknown>): IScenePickResult {
        const canvas = this._viewer.canvas;
        const spArg = args["screenPoint"] as { x?: number; y?: number } | undefined;
        const normX = typeof spArg?.x === "number" ? spArg.x : 0.5;
        const normY = typeof spArg?.y === "number" ? spArg.y : 0.5;
        const allHits = args["allHits"] === true;

        const windowPosition = new Cartesian2(normX * canvas.clientWidth, normY * canvas.clientHeight);

        if (allHits) {
            // drillPick returns all objects at the screen position.
            const picks = this._scene.drillPick(windowPosition) ?? [];

            if (picks.length === 0) {
                return { hit: false, hits: [] };
            }

            const hits: IScenePickHit[] = [];
            for (const pick of picks) {
                if (!pick || !pick.id) continue;
                const entity = pick.id;
                const hitEntry: IScenePickHit = {
                    meshId: typeof entity === "object" && entity.id ? entity.id : String(entity),
                    meshName: typeof entity === "object" && entity.name ? entity.name : "unknown",
                    distance: 0,
                };

                // Try to get the world position of the pick.
                const worldPos = this._scene.pickPosition(windowPosition);
                if (worldPos) {
                    hitEntry.pickedPoint = this._fromCartesian3(worldPos);
                    hitEntry.distance = Cartesian3.distance(this._scene.camera.position, worldPos);
                }

                hits.push(hitEntry);
            }

            return { hit: hits.length > 0, hits };
        }

        // Single pick (default).
        const pick = this._scene.pick(windowPosition);
        if (!pick || !pick.id) {
            return { hit: false };
        }

        const entity = pick.id;
        const result: IScenePickResult = {
            hit: true,
            meshId: typeof entity === "object" && entity.id ? entity.id : String(entity),
            meshName: typeof entity === "object" && entity.name ? entity.name : "unknown",
        };

        // World-space hit point.
        const worldPos = this._scene.pickPosition(windowPosition);
        if (worldPos) {
            result.pickedPoint = this._fromCartesian3(worldPos);
            result.distance = Cartesian3.distance(this._scene.camera.position, worldPos);
        }

        return result;
    }
}
