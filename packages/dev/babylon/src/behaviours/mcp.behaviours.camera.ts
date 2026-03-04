import { IMcpBehaviorAdapter, JsonRpcMimeType, McpBehavior, McpBehaviorOptions, McpResource, McpResourceTemplate, McpTool } from "@dev/core";
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

    // -------------------------------------------------------------------------

    public constructor(adapter: IMcpBehaviorAdapter, options: McpBehaviorOptions = {}) {
        super(adapter, {
            ...options,
            domain: options.domain ?? adapter.domain,
            namespace: options.namespace ?? McpCameraNamespace,
        });
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

        const vec3 = {
            type: "object",
            properties: {
                x: { type: "number" },
                y: { type: "number" },
                z: { type: "number" },
            },
            required: ["x", "y", "z"],
            additionalProperties: false,
        };

        return [
            // -----------------------------------------------------------------
            // camera.setTarget — aim
            // -----------------------------------------------------------------
            {
                name: McpCameraBehavior.CameraSetTargetFn,
                description: "Sets the camera look-at point by calling TargetCamera.setTarget(). " + "Coordinates are world-space, right-handed system, y-axis up.",
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: { type: "string", description: "Camera URI, e.g. babylon://camera/MyCamera" },
                        target: { ...vec3, description: "World-space look-at point (right-handed y-up)." },
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
                description: "Teleports the camera to an absolute world-space position. " + "For ArcRotateCamera this recalculates alpha, beta and radius automatically.",
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: { type: "string", description: "Camera URI" },
                        position: { ...vec3, description: "New camera world-space position (right-handed y-up)." },
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
                description:
                    "Moves the camera to a world-space position AND sets its look-at target in a single call. " +
                    "The ideal 'place the camera here and frame that subject' director operation.",
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: { type: "string", description: "Camera URI" },
                        position: { ...vec3, description: "New camera world-space position (right-handed y-up)." },
                        target: { ...vec3, description: "World-space look-at point (right-handed y-up)." },
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
                description:
                    "Rotates the camera around its current look-at target by incremental angles. " +
                    "deltaAlpha spins horizontally (azimuth); deltaBeta tilts vertically (elevation). " +
                    "For ArcRotateCamera this directly adjusts alpha/beta; " +
                    "for other TargetCameras the position is rotated around the target point.",
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: { type: "string", description: "Camera URI" },
                        deltaAlpha: {
                            type: "number",
                            description: "Horizontal rotation delta in degrees. Positive = counter-clockwise when viewed from above.",
                        },
                        deltaBeta: {
                            type: "number",
                            description: "Vertical rotation delta in degrees. Positive = tilt down (toward ground).",
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
                description:
                    "Sets the vertical field of view on a perspective camera. " +
                    "Low values (< 30°) give a telephoto / compressed look; " +
                    "high values (> 75°) give a wide-angle look. " +
                    "Returns an error if the camera is in orthographic mode.",
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: { type: "string", description: "Camera URI" },
                        fov: { type: "number", description: "Field-of-view value." },
                        unit: {
                            type: "string",
                            enum: ["deg", "rad"],
                            description: "Unit of the fov value. Defaults to 'deg' if omitted.",
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
                description:
                    "Applies a relative zoom. factor < 1 zooms in, factor > 1 zooms out. " +
                    "For perspective cameras this scales the FOV (lens zoom). " +
                    "For orthographic cameras it scales the frustum bounds. " +
                    "For ArcRotateCamera it scales the orbit radius (physical dolly).",
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: { type: "string", description: "Camera URI" },
                        factor: {
                            type: "number",
                            description: "Zoom multiplier. Must be > 0. factor < 1 zooms in, factor > 1 zooms out.",
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
                description: "Switches the camera between perspective and orthographic projection.",
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: { type: "string", description: "Camera URI" },
                        mode: {
                            type: "string",
                            enum: ["perspective", "orthographic"],
                            description: "Target projection mode.",
                        },
                        fov: {
                            type: "number",
                            description: "Vertical FOV in degrees to apply when switching to perspective (optional).",
                        },
                        orthoSize: {
                            type: "number",
                            description:
                                "Frustum height in world units when switching to orthographic (optional). " + "Left/right bounds are derived from the viewport aspect ratio.",
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
                description:
                    "Physically moves the camera toward (+) or away from (-) its look-at target along the view axis. " +
                    "Unlike zoom this actually moves the camera, affecting depth-of-field and parallax. " +
                    "For ArcRotateCamera it adjusts the orbit radius.",
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: { type: "string", description: "Camera URI" },
                        distance: {
                            type: "number",
                            description: "World-unit distance to move. Positive = closer to target, negative = further away.",
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
                description:
                    "Slides the camera and its look-at target together perpendicular to the view axis. " +
                    "deltaX moves along the camera's right vector; deltaY along the camera's screen-up vector. " +
                    "This is a steady-cam pan: the subject stays framed at the same angle and distance.",
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: { type: "string", description: "Camera URI" },
                        deltaX: {
                            type: "number",
                            description: "World-units to slide horizontally along the camera right vector. Positive = slide right.",
                        },
                        deltaY: {
                            type: "number",
                            description: "World-units to slide vertically along the camera up vector. Positive = slide up.",
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
                description:
                    "Detaches user input from the camera (cinematic lock). " + "Mouse, keyboard and touch events will no longer move the camera until camera.unlock is called.",
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: { type: "string", description: "Camera URI" },
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
                description: "Re-attaches user input to the camera, restoring interactive control after a cinematic lock.",
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: { type: "string", description: "Camera URI" },
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
                description:
                    "Captures a screenshot from the camera's point of view and returns it as a base64-encoded PNG. " +
                    "Renders off-screen at any resolution, independent of the canvas size. " +
                    "Specify width + height for an explicit pixel resolution, or precision to scale relative to the current viewport (1.0 = native).",
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: { type: "string", description: "Camera URI" },
                        size: {
                            type: "object",
                            description:
                                "Output image dimensions. " +
                                "Provide { width, height } for an explicit resolution (pixels), " +
                                "or { precision } to scale relative to the current viewport (1.0 = native resolution, 2.0 = double). " +
                                "Omit entirely to capture at native viewport resolution.",
                            properties: {
                                width: { type: "number", description: "Output width in pixels. Must be accompanied by height." },
                                height: { type: "number", description: "Output height in pixels. Must be accompanied by width." },
                                precision: {
                                    type: "number",
                                    description: "Scale factor relative to the current viewport size. Cannot be combined with width/height.",
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
                description:
                    "Smoothly animates the camera to a new position, look-at target and/or FOV over the given duration. " +
                    "All specified properties are interpolated simultaneously. " +
                    "Properties that are omitted remain unchanged.",
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: { type: "string", description: "Camera URI" },
                        position: { ...vec3, description: "Destination world-space position (right-handed y-up). Omit to keep the current position." },
                        target: { ...vec3, description: "Destination world-space look-at point (right-handed y-up). Omit to keep the current look-at target." },
                        fov: {
                            type: "number",
                            description: "Destination vertical FOV in degrees. Only applies to perspective cameras. Omit to keep the current FOV.",
                        },
                        duration: { type: "number", description: "Animation duration in seconds. Defaults to 1." },
                        easing: easingParam,
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
                description:
                    "Smoothly rotates the camera around its current look-at target. " +
                    "deltaAlpha sweeps the horizontal azimuth, deltaBeta tilts the elevation. " +
                    "Set loop:true for a continuous turntable at constant angular velocity " +
                    "(easing is ignored in loop mode to keep the motion smooth across cycles).",
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: { type: "string", description: "Camera URI" },
                        deltaAlpha: {
                            type: "number",
                            description: "Total horizontal rotation in degrees over one duration. Positive = counter-clockwise viewed from above.",
                        },
                        deltaBeta: {
                            type: "number",
                            description: "Total vertical rotation in degrees over one duration. Positive = tilt down toward ground.",
                        },
                        duration: { type: "number", description: "Duration in seconds for one full sweep. Defaults to 2." },
                        loop: {
                            type: "boolean",
                            description: "If true, rotates continuously at constant speed until camera.stopAnimation is called.",
                        },
                        easing: easingParam,
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
                description:
                    "Moves the camera through an ordered sequence of world-space waypoints over the given duration. " +
                    "Position and look-at target are linearly interpolated between adjacent waypoints. " +
                    "If a waypoint omits position or target, that value carries forward from the previous waypoint.",
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: { type: "string", description: "Camera URI" },
                        waypoints: {
                            type: "array",
                            description: "Ordered list of camera waypoints. At least 2 required.",
                            minItems: 2,
                            items: {
                                type: "object",
                                properties: {
                                    position: {
                                        ...vec3,
                                        description:
                                            "World-space camera position at this waypoint (right-handed y-up). " +
                                            "Omit to carry forward from the previous waypoint.",
                                    },
                                    target: {
                                        ...vec3,
                                        description:
                                            "World-space look-at point at this waypoint (right-handed y-up). " +
                                            "Omit to carry forward from the previous waypoint.",
                                    },
                                },
                                additionalProperties: false,
                            },
                        },
                        duration: { type: "number", description: "Total flight duration in seconds. Defaults to 3." },
                        easing: easingParam,
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
                description:
                    "Applies a procedural trauma shake to the camera for the given duration. " +
                    "The effect oscillates the look-at target with layered sinusoids whose amplitude decays to zero by the end. " +
                    "The camera automatically returns to its original look-at point when the shake completes.",
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: { type: "string", description: "Camera URI" },
                        intensity: { type: "number", description: "Peak shake amplitude in world units. Defaults to 0.5." },
                        duration: { type: "number", description: "Shake duration in seconds. Defaults to 1." },
                        frequency: { type: "number", description: "Base oscillation frequency in Hz. Defaults to 12." },
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
                description: "Stops any currently running animation on the camera (animateTo, animateOrbit, followPath, shake), leaving it at its current interpolated state.",
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: { type: "string", description: "Camera URI" },
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
                description:
                    "Returns a structured list of all scene meshes currently visible from a camera. " +
                    "Use this instead of camera_snapshot to understand what the camera sees — no image required. " +
                    "Each entry includes position, bounding box, material color and flags, filtered to the frustum. " +
                    "Results are sorted by distance (closest first) unless sortBy overrides it.",
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: { type: "string", description: "Camera URI, e.g. babylon://camera/MyCamera" },
                        maxObjects: {
                            type: "number",
                            description: "Maximum number of objects to return. Defaults to 50.",
                        },
                        include: {
                            type: "array",
                            description:
                                "Fields to include in each object entry. Omit or leave empty for all fields. " +
                                "Valid values: transform, bounds, material, color, visibility, tags.",
                            items: {
                                type: "string",
                                enum: ["transform", "bounds", "material", "color", "visibility", "tags"],
                            },
                        },
                        onlyPickable: {
                            type: "boolean",
                            description: "If true, only include meshes that are pickable. Defaults to false.",
                        },
                        minScreenCoverage: {
                            type: "number",
                            description: "Minimum fraction of screen area (0..1) the mesh bounding box must cover to be included. Defaults to 0.001.",
                        },
                        layerMask: {
                            type: "number",
                            description: "Optional layer mask filter. Only meshes whose layerMask shares at least one bit are included.",
                        },
                        sortBy: {
                            type: "string",
                            enum: ["distance", "screenCoverage", "name"],
                            description: "Sort order for the visible list. Defaults to 'distance' (closest first).",
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
                description:
                    "Casts a ray from the camera through a normalized screen point and returns the first mesh hit. " +
                    "Useful for answering 'what am I looking at?' — defaults to the screen center (crosshair pick). " +
                    "Returns the hit mesh, world-space impact point, surface normal, and distance.",
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: { type: "string", description: "Camera URI, e.g. babylon://camera/MyCamera" },
                        screenPoint: {
                            type: "object",
                            description: "Normalized screen position to cast from. Defaults to center (0.5, 0.5).",
                            properties: {
                                x: { type: "number", description: "Horizontal position (0 = left edge, 1 = right edge)." },
                                y: { type: "number", description: "Vertical position (0 = top edge, 1 = bottom edge)." },
                            },
                            required: ["x", "y"],
                            additionalProperties: false,
                        },
                        maxDistance: {
                            type: "number",
                            description: "Maximum ray distance in world units. Defaults to unlimited.",
                        },
                        allHits: {
                            type: "boolean",
                            description:
                                "If true, returns all meshes intersected by the ray (including those behind the first hit), " +
                                "sorted by distance in the hits array. Useful when objects are stacked or partially occluded. " +
                                "Defaults to false (closest hit only).",
                        },
                    },
                    required: ["uri"],
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
