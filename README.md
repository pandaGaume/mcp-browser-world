# MCP Browser World

A **Model Context Protocol (MCP)** framework that bridges LLM agents to browser-based
3D engines. It exposes scene objects (cameras, lights, meshes, sensors,..) as MCP resources and
tools, letting clients like **Claude Code** or **MCP Inspector** inspect and
manipulate a live 3D scene through a standard JSON-RPC interface.

The framework is engine-agnostic at its core and ships with adapters for
**Babylon.js** and **CesiumJS**.

> **Vue Spatiale** — this project is part of a broader initiative documented in the
> [Vue Spatiale book](https://github.com/pandaGaume/vue-spatiale), which covers the
> vision, concepts, and roadmap behind spatial MCP tooling.

---

## Quick start

```bash
# 1. Clone & install
git clone https://github.com/pandaGaume/mcp-browser-world.git
cd mcp-browser-world
npm install

# 2. Build everything (TypeScript → UMD bundles → deploy)
npm run build:all:dev

# 3. Start the tunnel server (opens browser automatically)
npm run server:start
```

The dev harness opens at `http://localhost:3000/`. Click **Start** to connect
the browser-side MCP server to the tunnel, then point your MCP client at the
displayed endpoint.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                        MCP Clients                                   │
│   Claude Code  ·  MCP Inspector  ·  any MCP-compatible agent         │
└──────────┬───────────────────────────────────────────────────────────┘
           │  POST /mcp   (Streamable HTTP, MCP 2025-03-26)
           │  GET  /sse   (SSE stream,      MCP 2024-11-05)
           ▼
┌──────────────────────────────────────────────────────────────────────┐
│                     WsTunnel  (Node.js)                 @dev/tunnel  │
│            HTTP / HTTPS relay  ←→  WebSocket bridge                  │
└──────────┬───────────────────────────────────────────────────────────┘
           │  ws://localhost:3000/provider  (wss:// with TLS)
           ▼
┌──────────────────────────────────────────────────────────────────────┐
│                  McpServer  (browser page)                           │
│                                                                      │
│  ┌──────────┐  ┌───────────┐  ┌───────────┐                          │
│  │  Camera  │  │   Light   │  │   Mesh    │   ← Behaviors            │
│  │ Behavior │  │ Behavior  │  │ Behavior  │     (@dev/behaviors)     │
│  └────┬─────┘  └─────┬─────┘  └─────┬─────┘                          │
│       │              │              │                                │
│  ┌────┴─────┐  ┌─────┴─────┐  ┌─────┴─────┐  ┌───────────┐          │
│  │ Babylon  │  │  Babylon  │  │  Babylon  │  │  Filters  │ optional │
│  │ Adapter  │  │  Adapter  │  │  Adapter  │  │ Pipeline  │ @dev/    │
│  └──────────┘  └───────────┘  └───────────┘  │ (Workers) │ filters  │
│       │              │              │         └─────┬─────┘          │
│       └──────────────┴──────────────┴───────────────┘                │
│                      │                                               │
│              ┌───────┴────────┐                                      │
│              │  Babylon.js /  │   ← 3D Engine                        │
│              │   CesiumJS     │                                      │
│              └────────────────┘                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### Layered design

| Layer               | Package          | Role                                                                                                                       |
| ------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Core**            | `@dev/core`      | Transport-agnostic MCP server SDK: interfaces, base classes, `McpServer`, `McpServerBuilder`, `McpGrammar`                 |
| **Geodesy**         | `@dev/geodesy`   | Coordinate systems (WGS84, ECEF, ENU), ellipsoids, geographic ↔ Cartesian conversions. Self-contained, no MCP dependency   |
| **Behaviors**       | `@dev/behaviors` | Engine-agnostic scene behaviors: `McpCameraBehavior`, `McpLightBehavior`, `McpMeshBehavior` with tool/resource definitions |
| **Babylon adapter** | `@dev/babylon`   | Babylon.js-specific adapters mapping behaviors to `@babylonjs/core` scene objects                                          |
| **Cesium adapter**  | `@dev/cesium`    | CesiumJS-specific adapters mapping behaviors to the Cesium viewer (ECEF coordinates, `flyTo` animations)                   |
| **Filters**         | `@dev/filters`   | Post-capture image filters for snapshots (grayscale, retinex, …). Worker-eligible filters run off-thread automatically     |
| **Tunnel**          | `@dev/tunnel`    | Node.js WebSocket/HTTP relay bridging MCP clients to the browser-based `McpServer`                                         |

### Key concepts

| Term                                | Description                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Behavior** (`IMcpBehavior`)       | Capability template for a type of object (camera, light, mesh). Defines tools, resources, and URI templates. Registered once per type |
| **Adapter** (`IMcpBehaviorAdapter`) | Engine-specific implementation that reads scene state and dispatches tool calls                                                       |
| **Grammar**                         | Serialisable tool descriptions resolved per-session. See [docs/grammar.md](docs/grammar.md)                                           |
| **Namespace**                       | Short identifier (e.g. `"camera"`) grouping tools and URI templates per behavior type                                                 |
| **URI template**                    | RFC 6570 pattern (e.g. `babylon://camera/{cameraId}`) advertised via `resources/templates/list`                                       |

### Coordinate system

Coordinates use implicit detection — `{x,y,z}` is Cartesian, `{lat,lon}` is geographic.
Camera tools accept both formats via `coordinateSchema` (from `@dev/geodesy`).
The Cesium adapter converts geographic inputs to ECEF via `resolveToCartesian3()`.

---

## Prerequisites

| Tool    | Version                            |
| ------- | ---------------------------------- |
| Node.js | >= 20.11.0 < 23.0.0                |
| npm     | >= 8.0.0                           |
| Browser | Any modern (Chrome, Edge, Firefox) |

---

## Build

### Compile TypeScript

```bash
npm run build:dev        # one-shot
npm run build:watch      # watch mode
```

### UMD browser bundles

Produces webpack bundles for `@dev/core`, `@dev/babylon`, and `@dev/cesium`:

```bash
npm run bundle           # production (minified)
npm run bundle:dev       # development (source maps)
npm run bundle:watch     # watch mode (core only)
```

Outputs:

- `packages/dev/core/bundle/mcp-server.js`
- `packages/dev/babylon/bundle/mcp-babylon.js`
- `packages/dev/cesium/bundle/mcp-cesium.js`

### Deploy bundles to dev harness

```bash
npm run deploy:bundles   # copies bundles → packages/host/www/bundle/
```

### Build everything at once

```bash
npm run build:all:dev    # development (recommended)
npm run build:all        # production (minified)
```

> **Tip** — after changing TypeScript source, always re-run `npm run build:all:dev`
> so the browser picks up your changes.

---

## Running the dev server

```bash
npm run server:start
```

Output:

```
⚙️  MCP Browser World — tunnel started
────────────────────────────────────────────────────────
📡  Provider     ws://localhost:3000/provider
🔌  MCP HTTP     http://localhost:3000/mcp   ← MCP Inspector
📺  MCP SSE      http://localhost:3000/sse   ← Claude Code
🖥️   Dev harness  http://localhost:3000/
────────────────────────────────────────────────────────
```

Set `MCP_TUNNEL_NO_OPEN=1` to suppress the automatic browser launch.

---

## Connecting MCP clients

### Browser dev harness

1. Open `http://localhost:3000/`
2. Leave defaults in the **Connection** panel
3. Click **Start** — status changes to **Connected**

### MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

Select **Streamable HTTP** transport, URL: `http://localhost:3000/<serverName>/mcp`.

### Claude Code

Add to `~/.claude/settings.json`:

```json
{
    "mcpServers": {
        "babylon": {
            "url": "http://localhost:3000/<serverName>/sse"
        }
    }
}
```

Replace `<serverName>` with the name passed to `McpServerBuilder.withName()`.

Then try:

> "List all the resources available in the Babylon scene."
> "Move BoxMesh to position (3, 0, -2)."
> "Smoothly animate the camera to look at the sphere over 2 seconds."

---

## HTTPS / TLS

```bash
# Generate a self-signed certificate
npm run gen-cert

# Start with TLS (bash)
MCP_TUNNEL_TLS_CERT=certs/cert.pem MCP_TUNNEL_TLS_KEY=certs/key.pem npm run server:start

# Or use the shortcut
npm run server:start:https
```

Replace `http://` with `https://` in all client URLs. See [docs/guides/howto.md](docs/guides/howto.md)
for more TLS details.

---

## Samples

Ready-to-use sample pages live in `packages/host/www/samples/`:

| Sample                  | Engine     | File                      |
| ----------------------- | ---------- | ------------------------- |
| Camera controls         | Babylon.js | `babylon-camera.html`     |
| Light management        | Babylon.js | `babylon-light.html`      |
| Mesh manipulation       | Babylon.js | `babylon-mesh.html`       |
| Multiplex (4 viewports) | Babylon.js | `babylon-multiplex.html`  |
| Loopback client         | Babylon.js | `babylon-client.html`     |
| Camera + 3D Tiles       | CesiumJS   | `cesium-camera.html`      |

Each sample includes a connection panel, canvas, and console output.

---

## Grammar system

Tool descriptions are separated from tool schemas so they can be replaced,
localised, or tuned per client without touching code. The grammar is a plain
JSON-serialisable object, resolved per-session during the `initialize` handshake.

Full documentation: **[docs/grammar.md](docs/grammar.md)**

---

## Snapshot filters

The `@dev/filters` package provides post-capture image filters applied to
`camera_snapshot` results before PNG encoding. Filters implement
`ISnapshotFilter` and are registered on camera adapters via the
`IHasImageFiltering` interface.

The `camera_snapshot` tool accepts an optional `filters` parameter:

| Value               | Behaviour                                    |
| ------------------- | -------------------------------------------- |
| _(omitted)_         | Raw capture, no filters applied              |
| `[]`                | Skip all filters (same as omitted)           |
| `["retinex", ...]`  | Apply only the named filters, in order       |

Use `camera_list_filters` to discover registered filters at runtime.

Worker-eligible filters (those implementing `IWorkerSnapshotFilter`) are
automatically batched and executed off the main thread for better performance.

Built-in filters: **grayscale**, **retinex** (multi-scale retinex with colour restoration).

![Loopback client — camera snapshot with retinex filter](docs/images/babylon-client-filters.png)

Full documentation: **[docs/filters/architecture.md](docs/filters/architecture.md)**

---

## MCP transports

| Transport       | Endpoint                                  | Spec               |
| --------------- | ----------------------------------------- | ------------------ |
| Streamable HTTP | `POST /<serverName>/mcp`                  | MCP 2025-03-26     |
| SSE stream      | `GET /<serverName>/sse`                   | MCP 2024-11-05     |
| SSE messages    | `POST /<serverName>/messages?sessionId=…` | MCP 2024-11-05     |
| Raw WebSocket   | `ws://localhost:3000/<serverName>`        | Internal / testing |

All transports available over HTTPS/WSS when TLS is configured.

---

## Behaviors

The framework ships with three behaviors, each documented in detail:

| Behavior | Tools | Documentation |
|----------|-------|---------------|
| **Camera** | 20 tools — positioning, projection, animation, snapshot filtering, scene queries | [docs/behaviors/camera.md](docs/behaviors/camera.md) |
| **Light** | 17 tools — creation, properties, ambient lighting | [docs/behaviors/light.md](docs/behaviors/light.md) |
| **Mesh** | 13 tools — visibility, transforms, materials, tags | [docs/behaviors/mesh.md](docs/behaviors/mesh.md) |

### Camera tools (summary)

| Category | Tools |
|----------|-------|
| Movement | `camera_set_target`, `camera_set_position`, `camera_look_at`, `camera_orbit`, `camera_dolly`, `camera_pan` |
| Optics | `camera_set_fov`, `camera_zoom`, `camera_set_projection` |
| Control | `camera_lock`, `camera_unlock` |
| Capture | `camera_snapshot` (accepts optional `filters` array), `camera_list_filters` |
| Animation | `camera_animate_to`, `camera_animate_orbit`, `camera_follow_path`, `camera_shake`, `camera_stop_animation` |
| Scene query | `scene_visible_objects`, `scene_pick_from_center` |

### Light tools (summary)

| Category | Tools |
|----------|-------|
| Lifecycle | `light_create`, `light_remove` |
| Properties | `light_set_enabled`, `light_set_intensity`, `light_set_diffuse_color`, `light_set_specular_color` |
| Spatial | `light_set_position`, `light_set_direction`, `light_set_target`, `light_set_range` |
| Type-specific | `light_spot_set_angle`, `light_spot_set_exponent`, `light_hemi_set_ground_color` |
| Batch | `light_update` |
| Ambient | `scene_get_ambient`, `scene_set_ambient_color`, `scene_set_ambient_enabled` |

### Mesh tools (summary)

| Category | Tools |
|----------|-------|
| Visibility | `mesh_set_enabled`, `mesh_set_visible`, `mesh_set_visibility` |
| Transform | `mesh_set_position`, `mesh_set_rotation`, `mesh_set_scaling`, `mesh_animate_to` |
| Material | `mesh_set_color`, `mesh_set_material_alpha` |
| Tags | `mesh_tag_add`, `mesh_tag_remove`, `mesh_tag_set`, `mesh_find_by_tag` |

---

## Project structure

```
mcp-browser-world/
├── packages/
│   ├── dev/
│   │   ├── core/           @dev/core — MCP server SDK
│   │   │   ├── src/
│   │   │   │   ├── interfaces/       Public TypeScript interfaces
│   │   │   │   └── server/           McpServer, McpServerBuilder, McpGrammar
│   │   │   └── bundle/               mcp-server.js (UMD)
│   │   ├── geodesy/        @dev/geodesy — coordinate systems & ellipsoids
│   │   │   └── src/
│   │   │       ├── geodesy.ellipsoid.ts      Ellipsoid (WGS84, GRS80, …)
│   │   │       ├── geodesy.system.ts         GeodeticSystem (ECEF ↔ geodetic)
│   │   │       ├── geodesy.schemas.ts        JSON schemas + resolveToCartesian3
│   │   │       └── calculators/              Spherical & flat-earth calculators
│   │   ├── behaviors/      @dev/behaviors — engine-agnostic scene behaviors
│   │   │   └── src/
│   │   │       ├── behaviours/       McpCameraBehavior, McpLightBehavior, McpMeshBehavior
│   │   │       └── states/           State interfaces (camera, light, mesh, math)
│   │   ├── babylon/        @dev/babylon — Babylon.js adapters
│   │   │   ├── src/adapters/         Camera, Light, Mesh adapters
│   │   │   └── bundle/               mcp-babylon.js (UMD)
│   │   ├── cesium/         @dev/cesium — CesiumJS adapters
│   │   │   ├── src/adapters/         Camera, Light, Mesh adapters (ECEF)
│   │   │   └── bundle/               mcp-cesium.js (UMD)
│   │   ├── filters/        @dev/filters — snapshot image filters
│   │   │   └── src/
│   │   │       ├── interfaces/       ISnapshotFilter, IImageFilterSet, IHasImageFiltering
│   │   │       ├── imageFilterSet.ts Default implementation (worker batching)
│   │   │       ├── grayscale.filter.ts   Built-in: grayscale (worker-eligible)
│   │   │       └── retinex.filter.ts     Built-in: retinex  (worker-eligible)
│   │   ├── tunnel/         @dev/tunnel — WebSocket/HTTP relay
│   │   │   └── src/                  WsTunnel, WsTunnelBuilder, CLI entry
│   │   └── tools/          @dev/tools — shared build utilities (placeholder)
│   └── host/
│       └── www/            Dev harness & samples
│           ├── bundle/     Deployed UMD bundles
│           ├── samples/    babylon-camera, babylon-light, babylon-mesh, cesium-camera
│           └── index.html  Browser MCP provider
├── scripts/
│   ├── deploy-bundles.mjs  Copy bundles → www/bundle/
│   └── gen-cert.mjs        Generate self-signed TLS certificate
├── docs/
│   ├── behaviors/
│   │   ├── camera.md       Camera behavior — full tool reference
│   │   ├── light.md        Light behavior — full tool reference
│   │   └── mesh.md         Mesh behavior — full tool reference
│   ├── filters/
│   │   └── architecture.md Filter pipeline architecture & custom filters
│   ├── guides/
│   │   └── howto.md        Tips, recipes & common tasks
│   └── grammar.md          Grammar system documentation
└── package.json            Monorepo root (npm workspaces)
```

---

## Environment variables

| Variable                   | Default                    | Description                              |
| -------------------------- | -------------------------- | ---------------------------------------- |
| `MCP_TUNNEL_PORT`          | `3000`                     | TCP port                                 |
| `MCP_TUNNEL_HOST`          | `0.0.0.0`                  | Bind address                             |
| `MCP_TUNNEL_PROVIDER_PATH` | `/provider`                | WebSocket path for browser provider      |
| `MCP_TUNNEL_CLIENT_PATH`   | `/`                        | WebSocket path for raw WS clients        |
| `MCP_TUNNEL_MCP_PATH`      | `/mcp`                     | Streamable HTTP endpoint                 |
| `MCP_TUNNEL_WWW_DIR`       | `packages/host/www`        | Dev harness directory                    |
| `MCP_TUNNEL_BUNDLE_DIR`    | `packages/dev/core/bundle` | Bundle directory served under `/bundle/` |
| `MCP_TUNNEL_NO_OPEN`       | _(unset)_                  | Skip auto-opening browser                |
| `MCP_TUNNEL_TLS_CERT`      | _(unset)_                  | PEM certificate file path                |
| `MCP_TUNNEL_TLS_KEY`       | _(unset)_                  | PEM private-key file path                |
| `MCP_TUNNEL_PROTOCOL`      | _(auto)_                   | Force `"http"` or `"https"`              |

---

## npm scripts

| Script                                | Description                                |
| ------------------------------------- | ------------------------------------------ |
| `npm run build:dev`                   | Compile TypeScript                         |
| `npm run build:watch`                 | Compile in watch mode                      |
| `npm run bundle` / `bundle:dev`       | Webpack bundles (production / development) |
| `npm run deploy:bundles`              | Copy bundles to dev harness                |
| `npm run build:all` / `build:all:dev` | Full build pipeline                        |
| `npm run server:start`                | Build + start tunnel                       |
| `npm run server:start:http`           | Force HTTP                                 |
| `npm run server:start:https`          | Force HTTPS with local certs               |
| `npm run gen-cert`                    | Generate self-signed TLS certificate       |

---

## Further reading

- [Camera behavior](docs/behaviors/camera.md) — 20 tools for camera control, animation, snapshot filtering, and scene queries
- [Light behavior](docs/behaviors/light.md) — 17 tools for light management and ambient lighting
- [Mesh behavior](docs/behaviors/mesh.md) — 13 tools for mesh visibility, transforms, materials, and tags
- [Grammar system](docs/grammar.md) — how tool descriptions are resolved per-session
- [Snapshot filters](docs/filters/architecture.md) — filter pipeline architecture, worker protocol, custom filters
- [HOWTO](docs/guides/howto.md) — tips, recipes, and common tasks
- [Vue Spatiale book](https://github.com/pandaGaume/vue-spatiale) — vision and roadmap
