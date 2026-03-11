# Mesh Behavior

The mesh behavior (`McpMeshBehavior`) exposes 13 tools for managing meshes in a
3D scene — visibility, transforms, materials, tags, and animation.

**Package:** `@dev/behaviors`
**Namespace:** `mesh`
**Adapter:** `@dev/babylon` (Babylon.js)

---

## Resources

| URI pattern | Description |
|-------------|-------------|
| `{scheme}://mesh` | List of all meshes in the scene (id, name, URI, type, tags) |
| `{scheme}://mesh/{meshId}` | Full state of a single mesh |

### Mesh state

Reading a mesh resource returns an `IMeshState` object:

```jsonc
{
    "id": "box0",
    "name": "BoxMesh",
    "type": "mesh",               // "mesh" or "instancedMesh"
    "enabled": true,
    "visible": true,
    "visibility": 1.0,            // per-mesh alpha [0..1]
    "pickable": true,
    "receiveShadows": false,
    "castsShadows": true,
    "transform": {
        "position": { "x": 0, "y": 1, "z": 0 },
        "rotationEuler": { "x": 0, "y": 0, "z": 0 },
        "scaling": { "x": 1, "y": 1, "z": 1 }
    },
    "material": {
        "name": "boxMat",
        "type": "standard",        // "standard" | "pbr" | "node" | "other"
        "baseColor": { "r": 0.8, "g": 0.2, "b": 0.2 },
        "hasTexture": false,
        "alpha": 1.0
    },
    "tags": ["interactive", "movable"],
    "parentId": null,
    "childIds": []
}
```

---

## Tools — Visibility

### mesh_set_enabled

Enables or disables a mesh. A disabled mesh is not rendered, not pickable, and
propagates the disabled state to its children.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | yes | Mesh URI |
| `enabled` | boolean | yes | `true` to enable, `false` to disable |

### mesh_set_visible

Shows or hides a mesh without affecting its children or pickability. Prefer this
over `mesh_set_enabled` for simple show/hide operations.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | yes | Mesh URI |
| `visible` | boolean | yes | `true` to show, `false` to hide |

### mesh_set_visibility

Sets the per-mesh alpha. Independent of the material alpha.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | yes | Mesh URI |
| `visibility` | number | yes | Alpha value in [0..1]. 0 = transparent, 1 = opaque |

---

## Tools — Transform

All positions are in right-handed Y-up world space.
Rotations are in degrees (Euler angles): x = pitch, y = yaw, z = roll.

### mesh_set_position

Teleports the mesh to an absolute world-space position.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | yes | Mesh URI |
| `position` | `{x,y,z}` | yes | Target position |

### mesh_set_rotation

Sets the local Euler rotation in degrees. Clears any existing `rotationQuaternion`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | yes | Mesh URI |
| `rotation` | `{x,y,z}` | yes | Euler angles in degrees. x = pitch, y = yaw, z = roll |

### mesh_set_scaling

Sets the local scale. Use `{1,1,1}` to reset to original size. Negative values
mirror the mesh along that axis.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | yes | Mesh URI |
| `scaling` | `{x,y,z}` | yes | Scale factors per axis |

### mesh_animate_to

Smoothly animates a mesh toward target position, rotation, and/or scaling values.
Only the provided fields are animated; omitted fields remain unchanged.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `uri` | string | yes | | Mesh URI |
| `position` | `{x,y,z}` | no | | Target position |
| `rotation` | `{x,y,z}` | no | | Target rotation in degrees |
| `scaling` | `{x,y,z}` | no | | Target scale |
| `duration` | number | no | 1 | Duration in seconds |
| `easing` | string | no | | Easing curve (see below) |

**Easing format:** `'<type>'` or `'<type>.<mode>'`

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

**Modes:** `in` (start slow), `out` (end slow), `inout` (default).

---

## Tools — Material

### mesh_set_color

Sets the base colour of the mesh's material (diffuse for `StandardMaterial`,
albedo for `PBRMaterial`). If the mesh has no material, a new `StandardMaterial`
is created.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | yes | Mesh URI |
| `color` | `{r,g,b}` | yes | Colour channels in [0..1] |

### mesh_set_material_alpha

Sets the material-level alpha. This is distinct from the per-mesh visibility alpha.
If the mesh has no material, a new `StandardMaterial` is created.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | yes | Mesh URI |
| `alpha` | number | yes | Alpha in [0..1]. 0 = transparent, 1 = opaque |

---

## Tools — Tags

Babylon.js tags are space-separated string identifiers attached to scene nodes.
They support boolean query expressions for searching.

### mesh_tag_add

Adds one or more tags to a mesh.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | yes | Mesh URI |
| `tags` | string | yes | Space-separated tags to add (e.g. `"enemy destructible"`) |

### mesh_tag_remove

Removes one or more tags from a mesh.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | yes | Mesh URI |
| `tags` | string | yes | Space-separated tags to remove |

### mesh_tag_set

Replaces ALL existing tags with the provided set. Pass an empty string to clear.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | yes | Mesh URI |
| `tags` | string | yes | Space-separated tags (replaces existing) |

### mesh_find_by_tag

Finds all meshes matching a tag query expression. This is a namespace-level tool
(use the mesh list URI, not an instance URI).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | string | yes | Namespace URI (e.g. `babylon://mesh`) |
| `query` | string | yes | Tag query expression |

**Query syntax:**

| Operator | Meaning | Example |
|----------|---------|---------|
| (none) | Match tag | `"enemy"` |
| `&&` | AND | `"enemy && destructible"` |
| `\|\|` | OR | `"enemy \|\| ally"` |
| `!` | NOT | `"!static"` |

Returns an array of matching mesh URIs and names.

---

## Babylon.js adapter notes

- Maintains a `Map<string, AbstractMesh>` indexed by URI, synchronised via
  `onNewMeshAddedObservable` and `onMeshRemovedObservable`
- Coordinate system: right-handed Y-up. When the scene uses left-handed mode,
  Z coordinates and rotation x/y components are negated on I/O
- `mesh_set_rotation` clears `rotationQuaternion` (forces Euler mode)
- Animation uses `onBeforeRenderObservable` for frame-based interpolation;
  if the mesh had a quaternion rotation, it is converted to Euler before animation
- Material creation: `mesh_set_color` and `mesh_set_material_alpha` auto-create
  a `StandardMaterial` if the mesh has none
- Shadow casting detection: no built-in flag in Babylon.js; the adapter iterates
  all lights' `ShadowGenerator` render lists to determine if a mesh casts shadows
- Tag operations delegate to Babylon.js `Tags` utility class
