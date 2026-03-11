# Light Behavior

The light behavior (`McpLightBehavior`) exposes 17 tools for creating, removing,
and configuring lights in a 3D scene, plus 3 tools for scene ambient lighting.

**Package:** `@dev/behaviors`
**Namespace:** `light`
**Adapter:** `@dev/babylon` (Babylon.js)

---

## Resources

| URI pattern | Description |
|-------------|-------------|
| `{scheme}://light` | List of all lights in the scene (id, name, type, URI, enabled state) |
| `{scheme}://light/{lightId}` | Full state of a single light |

### Light state

Reading a light resource returns one of four state shapes depending on the light
type. All share a common base:

```jsonc
// Common fields
{
    "id": "light0",
    "name": "Sun",
    "type": "directional",       // "point" | "directional" | "spot" | "hemispheric"
    "enabled": true,
    "intensity": 1.0,
    "diffuseColor": { "r": 1, "g": 1, "b": 1 },
    "specularColor": { "r": 1, "g": 1, "b": 1 }
}
```

Type-specific fields:

| Type | Additional fields |
|------|-------------------|
| **point** | `position`, `range?` |
| **directional** | `direction`, `position?` (shadow frustum only) |
| **spot** | `position`, `direction`, `angle` (degrees), `exponent?`, `range?` |
| **hemispheric** | `direction` (sky direction), `groundColor?` |

All colours use `{ r, g, b }` with channels in `[0, 1]`.
All positions/directions use `{ x, y, z }` in right-handed Y-up world space.

---

## Tools — Creation & Removal

### light_create

Creates a new light in the scene. Required fields vary by type.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | yes | Namespace URI (e.g. `babylon://light`) |
| `type` | `"point"` \| `"directional"` \| `"spot"` \| `"hemispheric"` | yes | Light type |
| `name` | string | yes | Unique name in the scene |
| `position` | `{x,y,z}` | point, spot | World-space origin |
| `direction` | `{x,y,z}` | directional, spot, hemispheric | Direction vector |
| `angle` | number | spot | Cone half-angle in degrees (0, 90) |
| `exponent` | number | no | Falloff exponent (spot only, default 2) |
| `intensity` | number | no | Initial intensity (default 1) |
| `diffuseColor` | `{r,g,b}` | no | Initial diffuse colour (default white) |
| `specularColor` | `{r,g,b}` | no | Initial specular colour (default white) |
| `groundColor` | `{r,g,b}` | no | Ground colour (hemispheric only) |
| `range` | number | no | Effective range (point and spot only) |

Returns the URI of the newly created light.

### light_remove

Removes and disposes a light from the scene.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | yes | Light URI |

> **Protected lights:** Only lights created via `light_create` can be removed.
> Pre-existing scene lights are protected and cannot be disposed.

---

## Tools — Common Properties

These tools apply to all light types.

### light_set_enabled

Enables or disables a light without removing it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | yes | Light URI |
| `enabled` | boolean | yes | `true` to enable, `false` to disable |

### light_set_intensity

Sets the brightness multiplier. Default is 1; values above 1 overbrighten.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | yes | Light URI |
| `intensity` | number | yes | Intensity (>= 0) |

### light_set_diffuse_color

Sets the main emitted colour.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | yes | Light URI |
| `color` | `{r,g,b}` | yes | Colour channels in [0, 1] |

### light_set_specular_color

Sets the highlight (specular) colour.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | yes | Light URI |
| `color` | `{r,g,b}` | yes | Colour channels in [0, 1] |

---

## Tools — Position & Direction

### light_set_position

Sets the world-space position. For point and spot lights this is the emission
origin. For directional lights it only moves the shadow-frustum origin.
Not applicable to hemispheric lights.

| Parameter | Type | Required | Applies to |
|-----------|------|----------|------------|
| `uri` | string | yes | |
| `position` | `{x,y,z}` | yes | point, spot, directional |

### light_set_direction

Sets the direction vector (normalised internally). For hemispheric lights, the
direction points toward the sky (bright hemisphere).
Not applicable to point lights.

| Parameter | Type | Required | Applies to |
|-----------|------|----------|------------|
| `uri` | string | yes | |
| `direction` | `{x,y,z}` | yes | directional, spot, hemispheric |

### light_set_target

Aims a light at a world-space point. Computes `direction = normalize(target - position)`.
Requires a position to be set.

| Parameter | Type | Required | Applies to |
|-----------|------|----------|------------|
| `uri` | string | yes | |
| `target` | `{x,y,z}` | yes | spot, directional |

### light_set_range

Sets the effective range in world units. Beyond this distance the light
contributes nothing.

| Parameter | Type | Required | Applies to |
|-----------|------|----------|------------|
| `uri` | string | yes | |
| `range` | number | yes | point, spot |

---

## Tools — Type-Specific

### light_spot_set_angle

Sets the cone half-angle of a spot light.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | yes | Light URI |
| `angle` | number | yes | Half-angle in degrees (0, 90). Smaller = tighter beam |

### light_spot_set_exponent

Sets the falloff exponent of a spot light. Higher values concentrate the light
toward the cone axis.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | yes | Light URI |
| `exponent` | number | yes | Exponent (>= 0) |

### light_hemi_set_ground_color

Sets the bottom-hemisphere (ground) colour of a hemispheric light.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | yes | Light URI |
| `color` | `{r,g,b}` | yes | Colour channels in [0, 1] |

---

## Tools — Batch Update

### light_update

Applies a partial patch to an existing light in one call. Fields that are not
applicable to the light type are silently ignored (reported in the response).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | yes | Light URI |
| `patch` | object | yes | Partial state (see below) |

**Patch fields** (all optional):

| Field | Type | Applies to |
|-------|------|------------|
| `enabled` | boolean | all |
| `intensity` | number | all |
| `diffuseColor` | `{r,g,b}` | all |
| `specularColor` | `{r,g,b}` | all |
| `position` | `{x,y,z}` | point, spot, directional |
| `direction` | `{x,y,z}` | directional, spot, hemispheric |
| `range` | number | point, spot |
| `angle` | number | spot (degrees) |
| `exponent` | number | spot |
| `groundColor` | `{r,g,b}` | hemispheric |

---

## Tools — Scene Ambient

These tools operate at the scene level (use the namespace URI, not a light URI).

### scene_get_ambient

Returns the current ambient colour and enabled state.

| Parameter | Type | Required |
|-----------|------|----------|
| `uri` | string | yes (namespace URI) |

Returns: `{ enabled: boolean, color: { r, g, b } }`

### scene_set_ambient_color

Sets the scene ambient colour. Affects all materials that use ambient.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | yes | Namespace URI |
| `color` | `{r,g,b}` | yes | Colour channels in [0, 1] |

### scene_set_ambient_enabled

Enables or disables scene ambient lighting. When disabled, `scene.ambientColor`
is set to black; the previous colour is restored when re-enabled.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | yes | Namespace URI |
| `enabled` | boolean | yes | `true` to enable, `false` to disable |

---

## Babylon.js adapter notes

- Maintains an internal `Map<string, Light>` indexed by URI, synchronised via
  scene observables (`onNewLightAddedObservable`, `onLightRemovedObservable`)
- Coordinate system: right-handed Y-up. When the scene uses left-handed mode,
  Z is negated on I/O
- Ambient state is tracked independently (`_ambientColor`, `_ambientEnabled`)
  so it survives enable/disable cycles
- Validation: colour channels checked for finite values in [0, 1]; vectors
  checked for finite x, y, z; type-specific applicability enforced per tool
