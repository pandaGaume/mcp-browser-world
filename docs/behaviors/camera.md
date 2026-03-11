# Camera Behavior

The camera behavior (`McpCameraBehavior`) exposes 19 tools for controlling cameras
in a 3D scene — positioning, projection, animation, and scene queries.

**Package:** `@dev/behaviors`
**Namespace:** `camera`
**Adapters:** `@dev/babylon` (Babylon.js), `@dev/cesium` (CesiumJS)

---

## Resources

| URI pattern | Description |
|-------------|-------------|
| `{scheme}://camera` | List of all cameras in the scene |
| `{scheme}://camera/{cameraId}` | Full state of a single camera (position, target, frustum, etc.) |

The scheme depends on the adapter: `babylon` or `cesium`.

### Camera state

Reading a camera resource returns an `ICameraState` object:

```jsonc
{
    "id": "camera0",
    "name": "Main Camera",
    "position": { "x": 10, "y": 5, "z": -3 },
    "target": { "x": 0, "y": 0, "z": 0 },
    "up": { "x": 0, "y": 1, "z": 0 },
    "frustum": {
        "kind": "perspective",
        "fov": 0.8,        // vertical FOV in radians
        "near": 0.1,
        "far": 1000
    },
    "isEnabled": true
}
```

Orthographic cameras return a different frustum shape:

```jsonc
{
    "kind": "orthographic",
    "size": 10,       // frustum height in world units
    "near": 0.1,
    "far": 1000
}
```

---

## Tools — Movement & Position

### camera_set_target

Sets the camera look-at point.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | yes | Camera URI |
| `target` | coordinate | yes | Look-at point. Cartesian `{x,y,z}` or geographic `{lat,lon,alt?}` |

### camera_set_position

Teleports the camera to a world-space position. For `ArcRotateCamera` this
recalculates alpha, beta, and radius automatically.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | yes | Camera URI |
| `position` | coordinate | yes | Target position |

### camera_look_at

Moves the camera AND sets its look-at target in one call. The ideal
"place the camera here and frame that subject" operation.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | yes | Camera URI |
| `position` | coordinate | yes | Camera position |
| `target` | coordinate | yes | Look-at point |

### camera_orbit

Rotates the camera around its current look-at target by incremental angles.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | yes | Camera URI |
| `deltaAlpha` | number | no | Horizontal rotation in degrees (azimuth) |
| `deltaBeta` | number | no | Vertical rotation in degrees (elevation) |

For `ArcRotateCamera`, this directly adjusts alpha/beta. For other `TargetCamera`
types, the position is rotated around the target point.

### camera_dolly

Physically moves the camera toward/away from its look-at target along the view
axis. Unlike zoom, this affects depth-of-field and parallax.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | yes | Camera URI |
| `distance` | number | yes | Distance to move (positive = closer, negative = farther) |

### camera_pan

Slides the camera and its look-at target together perpendicular to the view axis.
This is a steady-cam pan: the subject stays framed at the same angle and distance.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | yes | Camera URI |
| `deltaX` | number | yes | Movement along the camera's right vector |
| `deltaY` | number | yes | Movement along the camera's screen-up vector |

---

## Tools — Projection & Optics

### camera_set_fov

Sets the vertical field of view on a perspective camera. Returns an error if the
camera is in orthographic mode.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | yes | Camera URI |
| `fov` | number | yes | Field of view value |
| `unit` | `"deg"` \| `"rad"` | no | Unit (default: degrees) |

Low values (< 30 deg) give a telephoto look; high values (> 75 deg) give wide-angle.

### camera_zoom

Applies a relative zoom. Behaviour depends on camera type:
- **Perspective**: scales the FOV (lens zoom)
- **Orthographic**: scales the frustum bounds
- **ArcRotateCamera**: scales the orbit radius (physical dolly)

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | yes | Camera URI |
| `factor` | number | yes | Zoom factor (> 0). `< 1` zooms in, `> 1` zooms out |

### camera_set_projection

Switches between perspective and orthographic projection.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | yes | Camera URI |
| `mode` | `"perspective"` \| `"orthographic"` | yes | Projection mode |
| `fov` | number | no | Initial FOV for perspective mode |
| `orthoSize` | number | no | Frustum height for orthographic mode |

---

## Tools — Control State

### camera_lock

Detaches user input from the camera (cinematic lock). Mouse, keyboard, and touch
events will no longer move the camera.

| Parameter | Type | Required |
|-----------|------|----------|
| `uri` | string | yes |

### camera_unlock

Re-attaches user input to the camera, restoring interactive control.

| Parameter | Type | Required |
|-----------|------|----------|
| `uri` | string | yes |

---

## Tools — Capture

### camera_snapshot

Captures a screenshot from the camera's point of view and returns it as a
base64-encoded PNG. Renders off-screen at any resolution, independent of the
canvas size.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | yes | Camera URI |
| `size` | object | no | `{ width?, height?, precision? }` |

Specify `width` + `height` for explicit pixel resolution, or `precision` to scale
relative to the current viewport (1.0 = native).

---

## Tools — Animation

All animation tools accept an optional `easing` parameter.

**Format:** `'<type>'` or `'<type>.<mode>'`

| Type | Effect |
|------|--------|
| `linear` | Constant speed |
| `sine` | Smooth acceleration |
| `quad` / `cubic` | Polynomial curves |
| `circle` | Circular arc |
| `expo` | Exponential |
| `back` | Overshoot |
| `bounce` | Bouncing |
| `elastic` | Spring-like |

**Modes:** `in` (start slow), `out` (end slow), `inout` (default, slow at both ends).

### camera_animate_to

Smoothly animates the camera to a new position, look-at target, and/or FOV.
All specified properties are interpolated simultaneously. Omitted properties
remain unchanged.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `uri` | string | yes | | Camera URI |
| `position` | coordinate | no | | Target position |
| `target` | coordinate | no | | Target look-at point |
| `fov` | number | no | | Target FOV |
| `duration` | number | no | 1 | Duration in seconds |
| `easing` | string | no | | Easing curve |

### camera_animate_orbit

Smoothly rotates the camera around its look-at target. Set `loop: true` for a
continuous turntable (easing is ignored in loop mode).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `uri` | string | yes | | Camera URI |
| `deltaAlpha` | number | no | | Horizontal sweep in degrees |
| `deltaBeta` | number | no | | Vertical tilt in degrees |
| `duration` | number | no | 2 | Duration in seconds |
| `loop` | boolean | no | false | Continuous rotation |
| `easing` | string | no | | Easing curve |

### camera_follow_path

Moves the camera through an ordered sequence of waypoints. Position and look-at
target are linearly interpolated between adjacent waypoints. If a waypoint omits
`position` or `target`, that value carries forward from the previous waypoint.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `uri` | string | yes | | Camera URI |
| `waypoints` | array | yes | | At least 2 waypoints, each with optional `position` and `target` |
| `duration` | number | no | 3 | Total duration in seconds |
| `easing` | string | no | | Easing curve |

### camera_shake

Applies a procedural trauma shake. The effect oscillates the look-at target with
layered sinusoids whose amplitude decays to zero. The camera returns to its
original look-at point when the shake completes.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `uri` | string | yes | | Camera URI |
| `intensity` | number | no | 0.5 | Shake amplitude |
| `duration` | number | no | 1 | Duration in seconds |
| `frequency` | number | no | 12 | Oscillation frequency |

### camera_stop_animation

Stops any currently running animation, leaving the camera at its current
interpolated state.

| Parameter | Type | Required |
|-----------|------|----------|
| `uri` | string | yes |

---

## Tools — Scene Queries

### scene_visible_objects

Returns a structured list of all scene meshes currently visible from the camera.
Use this instead of `camera_snapshot` to understand what the camera sees — no
image required.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `uri` | string | yes | | Camera URI |
| `maxObjects` | number | no | 50 | Maximum objects to return |
| `include` | string[] | no | | Data to include: `"transform"`, `"bounds"`, `"material"`, `"color"`, `"visibility"`, `"tags"` |
| `onlyPickable` | boolean | no | | Filter to pickable meshes only |
| `minScreenCoverage` | number | no | 0.001 | Minimum screen coverage to include |
| `layerMask` | number | no | | Layer mask filter |
| `sortBy` | string | no | `"distance"` | Sort order: `"distance"`, `"screenCoverage"`, or `"name"` |

> **Cesium note:** This tool is marked as `ToolSupport.Partial` in the Cesium adapter
> (no per-primitive frustum testing).

### scene_pick_from_center

Casts a ray from the camera through a normalised screen point and returns the
first mesh hit. Defaults to the screen center (crosshair pick).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `uri` | string | yes | | Camera URI |
| `screenPoint` | object | no | `{x:0.5, y:0.5}` | Normalised screen point `{x: 0-1, y: 0-1}` |
| `maxDistance` | number | no | | Maximum ray distance |
| `allHits` | boolean | no | false | Return all hits, not just the first |

Returns hit mesh, world-space impact point, surface normal, and distance.

---

## Coordinate system

All coordinates are right-handed, Y-axis up.

Camera tools accept both coordinate formats via implicit detection:

```jsonc
// Cartesian
{ "x": 10, "y": 5, "z": -3 }

// Geographic (WGS84)
{ "lat": 48.8566, "lon": 2.3522, "alt": 300 }
```

### Babylon.js adapter

- Supports `TargetCamera` and `ArcRotateCamera`
- `ArcRotateCamera` receives special handling (direct alpha/beta/radius for orbit)
- When scene uses left-handed coordinates, Z is negated on I/O
- Geographic support via optional `geodeticSystem` property on the adapter

### CesiumJS adapter

- Single camera per scene (URI: `cesium://camera/default`)
- ECEF coordinate system (metres)
- Geographic inputs automatically converted to ECEF via `resolveToCartesian3()` (WGS84)
- Synthetic target tracking (Cesium has no built-in target property)
- `flyTo()` for smooth transitions, frame-based callbacks for orbit/path/shake
