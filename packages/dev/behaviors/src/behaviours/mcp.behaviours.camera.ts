import { IMcpBehaviorAdapter, JsonRpcMimeType, McpBehavior, McpBehaviorOptions, McpResource, McpResourceTemplate, McpTool, McpToolResult, McpToolResults } from "@dev/core";
import { isHasImageFiltering } from "@dev/filters";
import { coordinateSchema } from "@dev/geodesy";
import { McpCameraNamespace } from "../mcp.commons";

export class McpCameraBehavior extends McpBehavior {
    // -------------------------------------------------------------------------
    // Tool name constants
    // -------------------------------------------------------------------------

    /** Sets the look-at target of a TargetCamera. */
    public static readonly CameraSetTargetFn = "camera_set_target";

    /** Teleports the camera to an absolute world-space position. */
    public static readonly CameraSetPositionFn = "camera_set_position";

    /** Moves the camera to a position AND sets its look-at target in one call. */
    public static readonly CameraLookAtFn = "camera_look_at";

    /** Rotates the camera around its current target by incremental azimuth / elevation. */
    public static readonly CameraOrbitFn = "camera_orbit";

    /** Sets the vertical FOV on a perspective camera. */
    public static readonly CameraSetFovFn = "camera_set_fov";

    /** Applies a relative zoom by scaling FOV, ortho size, or ArcRotate radius. */
    public static readonly CameraZoomFn = "camera_zoom";

    /** Switches the camera between perspective and orthographic projection. */
    public static readonly CameraSetProjectionFn = "camera_set_projection";

    /** Physically moves the camera toward/away from its target along the view axis. */
    public static readonly CameraDollyFn = "camera_dolly";

    /** Slides the camera (and target together) perpendicular to the view axis. */
    public static readonly CameraPanFn = "camera_pan";

    /** Detaches user input — cinematic lock. */
    public static readonly CameraLockFn = "camera_lock";

    /** Re-attaches user input after a cinematic lock. */
    public static readonly CameraUnlockFn = "camera_unlock";

    /** Captures a screenshot from the camera's point of view and returns it as a base64 PNG. */
    public static readonly CameraSnapshotFn = "camera_snapshot";

    // -------------------------------------------------------------------------
    // Animation tools
    // -------------------------------------------------------------------------

    /** Smoothly animates position, look-at target and/or FOV to new values over time. */
    public static readonly CameraAnimateToFn = "camera_animate_to";

    /** Smoothly rotates the camera around its target by a delta angle, optionally looping forever. */
    public static readonly CameraAnimateOrbitFn = "camera_animate_orbit";

    /** Moves the camera through an ordered sequence of world-space waypoints over time. */
    public static readonly CameraFollowPathFn = "camera_follow_path";

    /** Applies a procedural camera shake for the given duration. */
    public static readonly CameraShakeFn = "camera_shake";

    /** Stops any currently running animation on the camera, leaving it at its current interpolated state. */
    public static readonly CameraStopAnimationFn = "camera_stop_animation";

    // -------------------------------------------------------------------------
    // Scene query tools
    // -------------------------------------------------------------------------

    /** Returns a structured description of all meshes visible from a camera — replaces screenshot for scene comprehension. */
    public static readonly SceneVisibleObjectsFn = "scene_visible_objects";

    /** Casts a ray from the camera through a screen point and returns the first mesh hit. */
    public static readonly ScenePickFromCenterFn = "scene_pick_from_center";

    /** Lists all registered snapshot filters with their descriptions. */
    public static readonly CameraListFiltersFn = "camera_list_filters";

    /** Captures a depth buffer from the camera and returns a compact lidar-style depth grid. */
    public static readonly CameraLidarFn = "camera_lidar";

    // -------------------------------------------------------------------------

    public constructor(adapter: IMcpBehaviorAdapter, options: McpBehaviorOptions = {}) {
        super(adapter, {
            ...options,
            domain: options.domain ?? adapter.domain,
            namespace: options.namespace ?? McpCameraNamespace,
        });
    }

    public override async executeToolAsync(uri: string, toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
        if (toolName === McpCameraBehavior.CameraListFiltersFn && isHasImageFiltering(this.adapter)) {
            const descriptions = this.adapter.imageFiltering.getFilterDescriptions();
            return McpToolResults.json({
                filters: descriptions.map((f) => ({
                    name: f.name,
                    description: this._resolvePropertyDescription(McpCameraBehavior.CameraListFiltersFn, f.name, f.description),
                })),
            });
        }
        return super.executeToolAsync(uri, toolName, args);
    }

    protected override _buildTools(): McpTool[] {
        // Reusable JSON-Schema fragment for a world-space XYZ vector (right-handed y-up).
        // Reusable easing parameter description shared by all animation tools.
        const easingParam = {
            type: "string",
            description:
                "Easing curve. Format '<type>' or '<type>.<mode>'. " +
                "Types: linear | sine | quad | cubic | circle | expo | back | bounce | elastic. " +
                "Modes: in | out | inout (default). " +
                "Examples: 'sine.inout', 'elastic.out', 'bounce.out', 'back.in'.",
        };

        // Coordinate schema accepting both Cartesian {x,y,z} and geographic {lat,lon,alt?}.
        const coord = coordinateSchema;

        return [
            // -----------------------------------------------------------------
            // camera.setTarget — aim
            // -----------------------------------------------------------------
            {
                name: McpCameraBehavior.CameraSetTargetFn,
                description: this._resolveToolDescription(
                    McpCameraBehavior.CameraSetTargetFn,
                    "Sets the camera look-at point by calling TargetCamera.setTarget(). Accepts Cartesian {x,y,z} (right-handed y-up) or geographic {lat,lon,alt?} (WGS84 degrees)."
                ),
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: {
                            type: "string",
                            description: this._resolvePropertyDescription(McpCameraBehavior.CameraSetTargetFn, "uri", "Camera URI, e.g. babylon://camera/MyCamera"),
                        },
                        target: {
                            ...coord,
                            description: this._resolvePropertyDescription(
                                McpCameraBehavior.CameraSetTargetFn,
                                "target",
                                "World-space look-at point. Cartesian {x,y,z} or geographic {lat,lon,alt?}."
                            ),
                        },
                    },
                    required: ["uri", "target"],
                    additionalProperties: false,
                },
            },

            // -----------------------------------------------------------------
            // camera.setPosition — teleport
            // -----------------------------------------------------------------
            {
                name: McpCameraBehavior.CameraSetPositionFn,
                description: this._resolveToolDescription(
                    McpCameraBehavior.CameraSetPositionFn,
                    "Teleports the camera to an absolute world-space position. " +
                        "Accepts Cartesian {x,y,z} or geographic {lat,lon,alt?}. " +
                        "For ArcRotateCamera this recalculates alpha, beta and radius automatically."
                ),
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: { type: "string", description: this._resolvePropertyDescription(McpCameraBehavior.CameraSetPositionFn, "uri", "Camera URI") },
                        position: {
                            ...coord,
                            description: this._resolvePropertyDescription(
                                McpCameraBehavior.CameraSetPositionFn,
                                "position",
                                "New camera position. Cartesian {x,y,z} or geographic {lat,lon,alt?}."
                            ),
                        },
                    },
                    required: ["uri", "position"],
                    additionalProperties: false,
                },
            },

            // -----------------------------------------------------------------
            // camera.lookAt — move + aim in one shot
            // -----------------------------------------------------------------
            {
                name: McpCameraBehavior.CameraLookAtFn,
                description: this._resolveToolDescription(
                    McpCameraBehavior.CameraLookAtFn,
                    "Moves the camera to a world-space position AND sets its look-at target in a single call. " +
                        "Accepts Cartesian {x,y,z} or geographic {lat,lon,alt?} for both position and target. " +
                        "The ideal 'place the camera here and frame that subject' director operation."
                ),
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: { type: "string", description: this._resolvePropertyDescription(McpCameraBehavior.CameraLookAtFn, "uri", "Camera URI") },
                        position: {
                            ...coord,
                            description: this._resolvePropertyDescription(
                                McpCameraBehavior.CameraLookAtFn,
                                "position",
                                "New camera position. Cartesian {x,y,z} or geographic {lat,lon,alt?}."
                            ),
                        },
                        target: {
                            ...coord,
                            description: this._resolvePropertyDescription(
                                McpCameraBehavior.CameraLookAtFn,
                                "target",
                                "World-space look-at point. Cartesian {x,y,z} or geographic {lat,lon,alt?}."
                            ),
                        },
                    },
                    required: ["uri", "position", "target"],
                    additionalProperties: false,
                },
            },

            // -----------------------------------------------------------------
            // camera.orbit — rotate around the current target
            // -----------------------------------------------------------------
            {
                name: McpCameraBehavior.CameraOrbitFn,
                description: this._resolveToolDescription(
                    McpCameraBehavior.CameraOrbitFn,
                    "Rotates the camera around its current look-at target by incremental angles. " +
                        "deltaAlpha spins horizontally (azimuth); deltaBeta tilts vertically (elevation). " +
                        "For ArcRotateCamera this directly adjusts alpha/beta; " +
                        "for other TargetCameras the position is rotated around the target point."
                ),
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: { type: "string", description: this._resolvePropertyDescription(McpCameraBehavior.CameraOrbitFn, "uri", "Camera URI") },
                        deltaAlpha: {
                            type: "number",
                            description: this._resolvePropertyDescription(
                                McpCameraBehavior.CameraOrbitFn,
                                "deltaAlpha",
                                "Horizontal rotation delta in degrees. Positive = counter-clockwise when viewed from above."
                            ),
                        },
                        deltaBeta: {
                            type: "number",
                            description: this._resolvePropertyDescription(
                                McpCameraBehavior.CameraOrbitFn,
                                "deltaBeta",
                                "Vertical rotation delta in degrees. Positive = tilt down (toward ground)."
                            ),
                        },
                    },
                    required: ["uri"],
                    additionalProperties: false,
                },
            },

            // -----------------------------------------------------------------
            // camera.setFov — field of view
            // -----------------------------------------------------------------
            {
                name: McpCameraBehavior.CameraSetFovFn,
                description: this._resolveToolDescription(
                    McpCameraBehavior.CameraSetFovFn,
                    "Sets the vertical field of view on a perspective camera. " +
                        "Low values (< 30°) give a telephoto / compressed look; " +
                        "high values (> 75°) give a wide-angle look. " +
                        "Returns an error if the camera is in orthographic mode."
                ),
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: { type: "string", description: this._resolvePropertyDescription(McpCameraBehavior.CameraSetFovFn, "uri", "Camera URI") },
                        fov: { type: "number", description: this._resolvePropertyDescription(McpCameraBehavior.CameraSetFovFn, "fov", "Field-of-view value.") },
                        unit: {
                            type: "string",
                            enum: ["deg", "rad"],
                            description: this._resolvePropertyDescription(McpCameraBehavior.CameraSetFovFn, "unit", "Unit of the fov value. Defaults to 'deg' if omitted."),
                        },
                    },
                    required: ["uri", "fov"],
                    additionalProperties: false,
                },
            },

            // -----------------------------------------------------------------
            // camera.zoom — relative zoom
            // -----------------------------------------------------------------
            {
                name: McpCameraBehavior.CameraZoomFn,
                description: this._resolveToolDescription(
                    McpCameraBehavior.CameraZoomFn,
                    "Applies a relative zoom. factor < 1 zooms in, factor > 1 zooms out. " +
                        "For perspective cameras this scales the FOV (lens zoom). " +
                        "For orthographic cameras it scales the frustum bounds. " +
                        "For ArcRotateCamera it scales the orbit radius (physical dolly)."
                ),
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: { type: "string", description: this._resolvePropertyDescription(McpCameraBehavior.CameraZoomFn, "uri", "Camera URI") },
                        factor: {
                            type: "number",
                            description: this._resolvePropertyDescription(
                                McpCameraBehavior.CameraZoomFn,
                                "factor",
                                "Zoom multiplier. Must be > 0. factor < 1 zooms in, factor > 1 zooms out."
                            ),
                        },
                    },
                    required: ["uri", "factor"],
                    additionalProperties: false,
                },
            },

            // -----------------------------------------------------------------
            // camera.setProjection — perspective ↔ orthographic
            // -----------------------------------------------------------------
            {
                name: McpCameraBehavior.CameraSetProjectionFn,
                description: this._resolveToolDescription(McpCameraBehavior.CameraSetProjectionFn, "Switches the camera between perspective and orthographic projection."),
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: { type: "string", description: this._resolvePropertyDescription(McpCameraBehavior.CameraSetProjectionFn, "uri", "Camera URI") },
                        mode: {
                            type: "string",
                            enum: ["perspective", "orthographic"],
                            description: this._resolvePropertyDescription(McpCameraBehavior.CameraSetProjectionFn, "mode", "Target projection mode."),
                        },
                        fov: {
                            type: "number",
                            description: this._resolvePropertyDescription(
                                McpCameraBehavior.CameraSetProjectionFn,
                                "fov",
                                "Vertical FOV in degrees to apply when switching to perspective (optional)."
                            ),
                        },
                        orthoSize: {
                            type: "number",
                            description: this._resolvePropertyDescription(
                                McpCameraBehavior.CameraSetProjectionFn,
                                "orthoSize",
                                "Frustum height in world units when switching to orthographic (optional). Left/right bounds are derived from the viewport aspect ratio."
                            ),
                        },
                    },
                    required: ["uri", "mode"],
                    additionalProperties: false,
                },
            },

            // -----------------------------------------------------------------
            // camera.dolly — push/pull along view axis
            // -----------------------------------------------------------------
            {
                name: McpCameraBehavior.CameraDollyFn,
                description: this._resolveToolDescription(
                    McpCameraBehavior.CameraDollyFn,
                    "Physically moves the camera toward (+) or away from (-) its look-at target along the view axis. " +
                        "Unlike zoom this actually moves the camera, affecting depth-of-field and parallax. " +
                        "For ArcRotateCamera it adjusts the orbit radius."
                ),
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: { type: "string", description: this._resolvePropertyDescription(McpCameraBehavior.CameraDollyFn, "uri", "Camera URI") },
                        distance: {
                            type: "number",
                            description: this._resolvePropertyDescription(
                                McpCameraBehavior.CameraDollyFn,
                                "distance",
                                "World-unit distance to move. Positive = closer to target, negative = further away."
                            ),
                        },
                    },
                    required: ["uri", "distance"],
                    additionalProperties: false,
                },
            },

            // -----------------------------------------------------------------
            // camera.pan — slide in the screen plane
            // -----------------------------------------------------------------
            {
                name: McpCameraBehavior.CameraPanFn,
                description: this._resolveToolDescription(
                    McpCameraBehavior.CameraPanFn,
                    "Slides the camera and its look-at target together perpendicular to the view axis. " +
                        "deltaX moves along the camera's right vector; deltaY along the camera's screen-up vector. " +
                        "This is a steady-cam pan: the subject stays framed at the same angle and distance."
                ),
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: { type: "string", description: this._resolvePropertyDescription(McpCameraBehavior.CameraPanFn, "uri", "Camera URI") },
                        deltaX: {
                            type: "number",
                            description: this._resolvePropertyDescription(
                                McpCameraBehavior.CameraPanFn,
                                "deltaX",
                                "World-units to slide horizontally along the camera right vector. Positive = slide right."
                            ),
                        },
                        deltaY: {
                            type: "number",
                            description: this._resolvePropertyDescription(
                                McpCameraBehavior.CameraPanFn,
                                "deltaY",
                                "World-units to slide vertically along the camera up vector. Positive = slide up."
                            ),
                        },
                    },
                    required: ["uri", "deltaX", "deltaY"],
                    additionalProperties: false,
                },
            },

            // -----------------------------------------------------------------
            // camera.lock — cinematic lock
            // -----------------------------------------------------------------
            {
                name: McpCameraBehavior.CameraLockFn,
                description: this._resolveToolDescription(
                    McpCameraBehavior.CameraLockFn,
                    "Detaches user input from the camera (cinematic lock). " + "Mouse, keyboard and touch events will no longer move the camera until camera.unlock is called."
                ),
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: { type: "string", description: this._resolvePropertyDescription(McpCameraBehavior.CameraLockFn, "uri", "Camera URI") },
                    },
                    required: ["uri"],
                    additionalProperties: false,
                },
            },

            // -----------------------------------------------------------------
            // camera.unlock — restore interactive control
            // -----------------------------------------------------------------
            {
                name: McpCameraBehavior.CameraUnlockFn,
                description: this._resolveToolDescription(
                    McpCameraBehavior.CameraUnlockFn,
                    "Re-attaches user input to the camera, restoring interactive control after a cinematic lock."
                ),
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: { type: "string", description: this._resolvePropertyDescription(McpCameraBehavior.CameraUnlockFn, "uri", "Camera URI") },
                    },
                    required: ["uri"],
                    additionalProperties: false,
                },
            },

            // -----------------------------------------------------------------
            // camera.snapshot — capture a frame
            // -----------------------------------------------------------------
            {
                name: McpCameraBehavior.CameraSnapshotFn,
                description: this._resolveToolDescription(
                    McpCameraBehavior.CameraSnapshotFn,
                    "Captures a screenshot from the camera's point of view and returns it as a base64-encoded PNG. " +
                        "Renders off-screen at any resolution, independent of the canvas size. " +
                        "Specify width + height for an explicit pixel resolution, or precision to scale relative to the current viewport (1.0 = native)."
                ),
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: { type: "string", description: this._resolvePropertyDescription(McpCameraBehavior.CameraSnapshotFn, "uri", "Camera URI") },
                        size: {
                            type: "object",
                            description: this._resolvePropertyDescription(
                                McpCameraBehavior.CameraSnapshotFn,
                                "size",
                                "Output image dimensions. Provide { width, height } for an explicit resolution (pixels), or { precision } to scale relative to the current viewport (1.0 = native resolution, 2.0 = double). Omit entirely to capture at native viewport resolution."
                            ),
                            properties: {
                                width: {
                                    type: "number",
                                    description: this._resolvePropertyDescription(
                                        McpCameraBehavior.CameraSnapshotFn,
                                        "size.width",
                                        "Output width in pixels. Must be accompanied by height."
                                    ),
                                },
                                height: {
                                    type: "number",
                                    description: this._resolvePropertyDescription(
                                        McpCameraBehavior.CameraSnapshotFn,
                                        "size.height",
                                        "Output height in pixels. Must be accompanied by width."
                                    ),
                                },
                                precision: {
                                    type: "number",
                                    description: this._resolvePropertyDescription(
                                        McpCameraBehavior.CameraSnapshotFn,
                                        "size.precision",
                                        "Scale factor relative to the current viewport size. Cannot be combined with width/height."
                                    ),
                                },
                            },
                            additionalProperties: false,
                        },
                        filters: {
                            type: "array",
                            items: { type: "string" },
                            description: this._resolvePropertyDescription(
                                McpCameraBehavior.CameraSnapshotFn,
                                "filters",
                                "Filter names to apply after capture. Omit to run all registered filters. " + "Pass an empty array to skip all filters (raw capture)."
                            ),
                        },
                        depth: {
                            type: "boolean",
                            description: this._resolvePropertyDescription(
                                McpCameraBehavior.CameraSnapshotFn,
                                "depth",
                                "If true, appends a companion lidar depth grid to the response (RGBD). " +
                                    "Configure resolution via 'lidarOptions'. Defaults to false."
                            ),
                        },
                        lidarOptions: {
                            type: "object",
                            description: this._resolvePropertyDescription(
                                McpCameraBehavior.CameraSnapshotFn,
                                "lidarOptions",
                                "Options for the companion depth grid when 'depth' is true. " +
                                    "All fields are optional and fall back to camera_lidar defaults."
                            ),
                            properties: {
                                beams: {
                                    type: "number",
                                    enum: [16, 32, 64, 128],
                                    description: "Number of vertical channels (rows). Defaults to 16.",
                                },
                                angularResolution: {
                                    type: "number",
                                    description: "Horizontal angular step in degrees. Defaults to 1.0.",
                                },
                                encoding: {
                                    type: "string",
                                    enum: ["uint16", "float32"],
                                    description: "Depth encoding: 'uint16' (mm) or 'float32' (m). Defaults to 'uint16'.",
                                },
                                maxRange: {
                                    type: "number",
                                    description: "Maximum lidar range in meters. Out-of-range = 0. Defaults to 100.",
                                },
                            },
                            additionalProperties: false,
                        },
                    },
                    required: ["uri"],
                    additionalProperties: false,
                },
            },

            // -----------------------------------------------------------------
            // camera.animateTo — smooth fly-to
            // -----------------------------------------------------------------
            {
                name: McpCameraBehavior.CameraAnimateToFn,
                description: this._resolveToolDescription(
                    McpCameraBehavior.CameraAnimateToFn,
                    "Smoothly animates the camera to a new position, look-at target and/or FOV over the given duration. " +
                        "All specified properties are interpolated simultaneously. " +
                        "Properties that are omitted remain unchanged."
                ),
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: { type: "string", description: this._resolvePropertyDescription(McpCameraBehavior.CameraAnimateToFn, "uri", "Camera URI") },
                        position: {
                            ...coord,
                            description: this._resolvePropertyDescription(
                                McpCameraBehavior.CameraAnimateToFn,
                                "position",
                                "Destination position. Cartesian {x,y,z} or geographic {lat,lon,alt?}. Omit to keep the current position."
                            ),
                        },
                        target: {
                            ...coord,
                            description: this._resolvePropertyDescription(
                                McpCameraBehavior.CameraAnimateToFn,
                                "target",
                                "Destination look-at point. Cartesian {x,y,z} or geographic {lat,lon,alt?}. Omit to keep the current target."
                            ),
                        },
                        fov: {
                            type: "number",
                            description: this._resolvePropertyDescription(
                                McpCameraBehavior.CameraAnimateToFn,
                                "fov",
                                "Destination vertical FOV in degrees. Only applies to perspective cameras. Omit to keep the current FOV."
                            ),
                        },
                        duration: {
                            type: "number",
                            description: this._resolvePropertyDescription(McpCameraBehavior.CameraAnimateToFn, "duration", "Animation duration in seconds. Defaults to 1."),
                        },
                        easing: {
                            ...easingParam,
                            description: this._resolvePropertyDescription(McpCameraBehavior.CameraAnimateToFn, "easing", easingParam.description as string),
                        },
                    },
                    required: ["uri"],
                    additionalProperties: false,
                },
            },

            // -----------------------------------------------------------------
            // camera.animateOrbit — smooth orbit / turntable
            // -----------------------------------------------------------------
            {
                name: McpCameraBehavior.CameraAnimateOrbitFn,
                description: this._resolveToolDescription(
                    McpCameraBehavior.CameraAnimateOrbitFn,
                    "Smoothly rotates the camera around its current look-at target. " +
                        "deltaAlpha sweeps the horizontal azimuth, deltaBeta tilts the elevation. " +
                        "Set loop:true for a continuous turntable at constant angular velocity " +
                        "(easing is ignored in loop mode to keep the motion smooth across cycles)."
                ),
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: { type: "string", description: this._resolvePropertyDescription(McpCameraBehavior.CameraAnimateOrbitFn, "uri", "Camera URI") },
                        deltaAlpha: {
                            type: "number",
                            description: this._resolvePropertyDescription(
                                McpCameraBehavior.CameraAnimateOrbitFn,
                                "deltaAlpha",
                                "Total horizontal rotation in degrees over one duration. Positive = counter-clockwise viewed from above."
                            ),
                        },
                        deltaBeta: {
                            type: "number",
                            description: this._resolvePropertyDescription(
                                McpCameraBehavior.CameraAnimateOrbitFn,
                                "deltaBeta",
                                "Total vertical rotation in degrees over one duration. Positive = tilt down toward ground."
                            ),
                        },
                        duration: {
                            type: "number",
                            description: this._resolvePropertyDescription(
                                McpCameraBehavior.CameraAnimateOrbitFn,
                                "duration",
                                "Duration in seconds for one full sweep. Defaults to 2."
                            ),
                        },
                        loop: {
                            type: "boolean",
                            description: this._resolvePropertyDescription(
                                McpCameraBehavior.CameraAnimateOrbitFn,
                                "loop",
                                "If true, rotates continuously at constant speed until camera.stopAnimation is called."
                            ),
                        },
                        easing: {
                            ...easingParam,
                            description: this._resolvePropertyDescription(McpCameraBehavior.CameraAnimateOrbitFn, "easing", easingParam.description as string),
                        },
                    },
                    required: ["uri"],
                    additionalProperties: false,
                },
            },

            // -----------------------------------------------------------------
            // camera.followPath — dolly along a waypoint path
            // -----------------------------------------------------------------
            {
                name: McpCameraBehavior.CameraFollowPathFn,
                description: this._resolveToolDescription(
                    McpCameraBehavior.CameraFollowPathFn,
                    "Moves the camera through an ordered sequence of world-space waypoints over the given duration. " +
                        "Position and look-at target are linearly interpolated between adjacent waypoints. " +
                        "If a waypoint omits position or target, that value carries forward from the previous waypoint."
                ),
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: { type: "string", description: this._resolvePropertyDescription(McpCameraBehavior.CameraFollowPathFn, "uri", "Camera URI") },
                        waypoints: {
                            type: "array",
                            description: this._resolvePropertyDescription(
                                McpCameraBehavior.CameraFollowPathFn,
                                "waypoints",
                                "Ordered list of camera waypoints. At least 2 required."
                            ),
                            minItems: 2,
                            items: {
                                type: "object",
                                properties: {
                                    position: {
                                        ...coord,
                                        description: this._resolvePropertyDescription(
                                            McpCameraBehavior.CameraFollowPathFn,
                                            "waypoints.position",
                                            "Camera position at this waypoint. Cartesian {x,y,z} or geographic {lat,lon,alt?}. Omit to carry forward from the previous waypoint."
                                        ),
                                    },
                                    target: {
                                        ...coord,
                                        description: this._resolvePropertyDescription(
                                            McpCameraBehavior.CameraFollowPathFn,
                                            "waypoints.target",
                                            "Look-at point at this waypoint. Cartesian {x,y,z} or geographic {lat,lon,alt?}. Omit to carry forward from the previous waypoint."
                                        ),
                                    },
                                },
                                additionalProperties: false,
                            },
                        },
                        duration: {
                            type: "number",
                            description: this._resolvePropertyDescription(McpCameraBehavior.CameraFollowPathFn, "duration", "Total flight duration in seconds. Defaults to 3."),
                        },
                        easing: {
                            ...easingParam,
                            description: this._resolvePropertyDescription(McpCameraBehavior.CameraFollowPathFn, "easing", easingParam.description as string),
                        },
                    },
                    required: ["uri", "waypoints"],
                    additionalProperties: false,
                },
            },

            // -----------------------------------------------------------------
            // camera.shake — procedural trauma shake
            // -----------------------------------------------------------------
            {
                name: McpCameraBehavior.CameraShakeFn,
                description: this._resolveToolDescription(
                    McpCameraBehavior.CameraShakeFn,
                    "Applies a procedural trauma shake to the camera for the given duration. " +
                        "The effect oscillates the look-at target with layered sinusoids whose amplitude decays to zero by the end. " +
                        "The camera automatically returns to its original look-at point when the shake completes."
                ),
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: { type: "string", description: this._resolvePropertyDescription(McpCameraBehavior.CameraShakeFn, "uri", "Camera URI") },
                        intensity: {
                            type: "number",
                            description: this._resolvePropertyDescription(McpCameraBehavior.CameraShakeFn, "intensity", "Peak shake amplitude in world units. Defaults to 0.5."),
                        },
                        duration: {
                            type: "number",
                            description: this._resolvePropertyDescription(McpCameraBehavior.CameraShakeFn, "duration", "Shake duration in seconds. Defaults to 1."),
                        },
                        frequency: {
                            type: "number",
                            description: this._resolvePropertyDescription(McpCameraBehavior.CameraShakeFn, "frequency", "Base oscillation frequency in Hz. Defaults to 12."),
                        },
                    },
                    required: ["uri"],
                    additionalProperties: false,
                },
            },

            // -----------------------------------------------------------------
            // camera.stopAnimation — cancel any running animation
            // -----------------------------------------------------------------
            {
                name: McpCameraBehavior.CameraStopAnimationFn,
                description: this._resolveToolDescription(
                    McpCameraBehavior.CameraStopAnimationFn,
                    "Stops any currently running animation on the camera (animateTo, animateOrbit, followPath, shake), leaving it at its current interpolated state."
                ),
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: { type: "string", description: this._resolvePropertyDescription(McpCameraBehavior.CameraStopAnimationFn, "uri", "Camera URI") },
                    },
                    required: ["uri"],
                    additionalProperties: false,
                },
            },

            // -----------------------------------------------------------------
            // scene.visibleObjects — structured scene description from camera POV
            // -----------------------------------------------------------------
            {
                name: McpCameraBehavior.SceneVisibleObjectsFn,
                description: this._resolveToolDescription(
                    McpCameraBehavior.SceneVisibleObjectsFn,
                    "Returns a structured list of all scene meshes currently visible from a camera. " +
                        "Use this instead of camera_snapshot to understand what the camera sees — no image required. " +
                        "Each entry includes position, bounding box, material color and flags, filtered to the frustum. " +
                        "Results are sorted by distance (closest first) unless sortBy overrides it."
                ),
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: {
                            type: "string",
                            description: this._resolvePropertyDescription(McpCameraBehavior.SceneVisibleObjectsFn, "uri", "Camera URI, e.g. babylon://camera/MyCamera"),
                        },
                        maxObjects: {
                            type: "number",
                            description: this._resolvePropertyDescription(
                                McpCameraBehavior.SceneVisibleObjectsFn,
                                "maxObjects",
                                "Maximum number of objects to return. Defaults to 50."
                            ),
                        },
                        include: {
                            type: "array",
                            description: this._resolvePropertyDescription(
                                McpCameraBehavior.SceneVisibleObjectsFn,
                                "include",
                                "Fields to include in each object entry. Omit or leave empty for all fields. Valid values: transform, bounds, material, color, visibility, tags."
                            ),
                            items: {
                                type: "string",
                                enum: ["transform", "bounds", "material", "color", "visibility", "tags"],
                            },
                        },
                        onlyPickable: {
                            type: "boolean",
                            description: this._resolvePropertyDescription(
                                McpCameraBehavior.SceneVisibleObjectsFn,
                                "onlyPickable",
                                "If true, only include meshes that are pickable. Defaults to false."
                            ),
                        },
                        minScreenCoverage: {
                            type: "number",
                            description: this._resolvePropertyDescription(
                                McpCameraBehavior.SceneVisibleObjectsFn,
                                "minScreenCoverage",
                                "Minimum fraction of screen area (0..1) the mesh bounding box must cover to be included. Defaults to 0.001."
                            ),
                        },
                        layerMask: {
                            type: "number",
                            description: this._resolvePropertyDescription(
                                McpCameraBehavior.SceneVisibleObjectsFn,
                                "layerMask",
                                "Optional layer mask filter. Only meshes whose layerMask shares at least one bit are included."
                            ),
                        },
                        sortBy: {
                            type: "string",
                            enum: ["distance", "screenCoverage", "name"],
                            description: this._resolvePropertyDescription(
                                McpCameraBehavior.SceneVisibleObjectsFn,
                                "sortBy",
                                "Sort order for the visible list. Defaults to 'distance' (closest first)."
                            ),
                        },
                    },
                    required: ["uri"],
                    additionalProperties: false,
                },
            },

            // -----------------------------------------------------------------
            // scene.pickFromCenter — raycast from camera screen point
            // -----------------------------------------------------------------
            {
                name: McpCameraBehavior.ScenePickFromCenterFn,
                description: this._resolveToolDescription(
                    McpCameraBehavior.ScenePickFromCenterFn,
                    "Casts a ray from the camera through a normalized screen point and returns the first mesh hit. " +
                        "Useful for answering 'what am I looking at?' — defaults to the screen center (crosshair pick). " +
                        "Returns the hit mesh, world-space impact point, surface normal, and distance."
                ),
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: {
                            type: "string",
                            description: this._resolvePropertyDescription(McpCameraBehavior.ScenePickFromCenterFn, "uri", "Camera URI, e.g. babylon://camera/MyCamera"),
                        },
                        screenPoint: {
                            type: "object",
                            description: this._resolvePropertyDescription(
                                McpCameraBehavior.ScenePickFromCenterFn,
                                "screenPoint",
                                "Normalized screen position to cast from. Defaults to center (0.5, 0.5)."
                            ),
                            properties: {
                                x: {
                                    type: "number",
                                    description: this._resolvePropertyDescription(
                                        McpCameraBehavior.ScenePickFromCenterFn,
                                        "screenPoint.x",
                                        "Horizontal position (0 = left edge, 1 = right edge)."
                                    ),
                                },
                                y: {
                                    type: "number",
                                    description: this._resolvePropertyDescription(
                                        McpCameraBehavior.ScenePickFromCenterFn,
                                        "screenPoint.y",
                                        "Vertical position (0 = top edge, 1 = bottom edge)."
                                    ),
                                },
                            },
                            required: ["x", "y"],
                            additionalProperties: false,
                        },
                        maxDistance: {
                            type: "number",
                            description: this._resolvePropertyDescription(
                                McpCameraBehavior.ScenePickFromCenterFn,
                                "maxDistance",
                                "Maximum ray distance in world units. Defaults to unlimited."
                            ),
                        },
                        allHits: {
                            type: "boolean",
                            description: this._resolvePropertyDescription(
                                McpCameraBehavior.ScenePickFromCenterFn,
                                "allHits",
                                "If true, returns all meshes intersected by the ray (including those behind the first hit), sorted by distance in the hits array. Useful when objects are stacked or partially occluded. Defaults to false (closest hit only)."
                            ),
                        },
                    },
                    required: ["uri"],
                    additionalProperties: false,
                },
            },

            // -----------------------------------------------------------------
            // camera.lidar — depth buffer as compact lidar grid
            // -----------------------------------------------------------------
            {
                name: McpCameraBehavior.CameraLidarFn,
                description: this._resolveToolDescription(
                    McpCameraBehavior.CameraLidarFn,
                    "Captures the depth buffer from the camera and returns a compact lidar-style depth grid. " +
                        "Resolution follows real lidar conventions: vertical 'beams' (16/32/64/128) and horizontal columns " +
                        "derived from the camera's horizontal FOV divided by 'angularResolution' (degrees per column). " +
                        "Returns base64-encoded depth values with metadata (near/far planes, FOV, encoding)."
                ),
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: {
                            type: "string",
                            description: this._resolvePropertyDescription(McpCameraBehavior.CameraLidarFn, "uri", "Camera URI"),
                        },
                        beams: {
                            type: "number",
                            enum: [16, 32, 64, 128],
                            description: this._resolvePropertyDescription(
                                McpCameraBehavior.CameraLidarFn,
                                "beams",
                                "Number of vertical channels (rows). Standard lidar tiers: 16, 32, 64, or 128. Defaults to 16."
                            ),
                        },
                        angularResolution: {
                            type: "number",
                            description: this._resolvePropertyDescription(
                                McpCameraBehavior.CameraLidarFn,
                                "angularResolution",
                                "Horizontal angular step in degrees. Columns = floor(hFov / angularResolution). " +
                                    "Smaller values produce denser horizontal sampling. Defaults to 1.0."
                            ),
                        },
                        encoding: {
                            type: "string",
                            enum: ["uint16", "float32"],
                            description: this._resolvePropertyDescription(
                                McpCameraBehavior.CameraLidarFn,
                                "encoding",
                                "Depth encoding: 'uint16' returns millimeters as Uint16Array (compact, 0–65535 mm range), " +
                                    "'float32' returns meters as Float32Array (full precision). Defaults to 'uint16'."
                            ),
                        },
                        maxRange: {
                            type: "number",
                            description: this._resolvePropertyDescription(
                                McpCameraBehavior.CameraLidarFn,
                                "maxRange",
                                "Maximum lidar range in meters. Depth values beyond this distance are reported as 0 (no return), " +
                                    "matching real lidar behavior for sky or out-of-range hits. Defaults to 100."
                            ),
                        },
                    },
                    required: ["uri"],
                    additionalProperties: false,
                },
            },

            // -----------------------------------------------------------------
            // camera.listFilters — discover available snapshot filters
            // -----------------------------------------------------------------
            ...(isHasImageFiltering(this.adapter)
                ? [
                      {
                          name: McpCameraBehavior.CameraListFiltersFn,
                          description: this._resolveToolDescription(
                              McpCameraBehavior.CameraListFiltersFn,
                              "Lists all snapshot filters registered on the camera adapter, with their names and descriptions. " +
                                  "Use the returned names in the 'filters' parameter of camera_snapshot to select which filters to apply."
                          ),
                          inputSchema: {
                              type: "object" as const,
                              properties: {
                                  uri: {
                                      type: "string",
                                      description: this._resolvePropertyDescription(McpCameraBehavior.CameraListFiltersFn, "uri", "Camera URI"),
                                  },
                              },
                              required: ["uri"] as string[],
                              additionalProperties: false,
                          },
                      },
                  ]
                : []),
        ];
    }

    protected override _buildResources(): McpResource[] {
        return [
            {
                uri: `${this.baseUri}`,
                name: "Cameras list.",
                description: "Cameras available in the scene.",
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
