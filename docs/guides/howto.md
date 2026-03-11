# HOWTO — Tips & Recipes

Practical guidance for common tasks with the MCP for Babylon framework.

---

## Setting up a Babylon.js scene

### Minimal page

Load the UMD bundles and wire up your Babylon.js scene:

```html
<script src="/bundle/mcp-server.js"></script>
<script src="/bundle/mcp-babylon.js"></script>
<script>
const { McpServerBuilder } = McpServer;
const { McpCameraBehavior, McpLightBehavior, McpMeshBehavior,
        McpCameraAdapter, McpLightAdapter, McpMeshAdapter } = McpBabylon;

// Create behaviors with Babylon adapters
const cameraBehavior = new McpCameraBehavior();
const lightBehavior  = new McpLightBehavior();
const meshBehavior   = new McpMeshBehavior();

// Build the MCP server
const server = new McpServerBuilder()
    .withName("My Scene")
    .withWsUrl("ws://localhost:3000/provider")
    .register(cameraBehavior, lightBehavior, meshBehavior)
    .build();

// Attach adapters after the Babylon scene is ready
cameraBehavior.attachAdapter(new McpCameraAdapter(scene, camera));
lightBehavior.attachAdapter(new McpLightAdapter(scene));
meshBehavior.attachAdapter(new McpMeshAdapter(scene));

// Connect
server.connect();
</script>
```

See `packages/host/www/samples/babylon-camera.html` for a complete working example.

### Setting up a CesiumJS scene

Same pattern, different adapter package:

```html
<script src="/bundle/mcp-server.js"></script>
<script src="/bundle/mcp-cesium.js"></script>
<script>
const { McpServerBuilder } = McpServer;
const { McpCameraBehavior, McpCameraAdapter } = McpCesium;

const cameraBehavior = new McpCameraBehavior();

const server = new McpServerBuilder()
    .withName("Cesium Scene")
    .withWsUrl("ws://localhost:3000/provider")
    .register(cameraBehavior)
    .build();

cameraBehavior.attachAdapter(new McpCameraAdapter(viewer));
server.connect();
</script>
```

See `packages/host/www/samples/cesium-camera.html` for a working example with 3D Tiles.

---

## Working with coordinates

### Cartesian vs Geographic

All camera tools accept both coordinate formats — the adapter resolves them
automatically:

```jsonc
// Cartesian (Babylon world-space or Cesium ECEF)
{ "x": 10, "y": 5, "z": -3 }

// Geographic (WGS84)
{ "lat": 48.8566, "lon": 2.3522 }           // Paris, ground level
{ "lat": 48.8566, "lon": 2.3522, "alt": 300 } // 300m above
```

Detection is implicit: if the object has `lat` and `lon`, it is geographic;
if it has `x`, `y`, and `z`, it is Cartesian. No `@type` discriminator needed.

### Using geographic coordinates in Babylon.js

The Babylon adapter has a `geodeticSystem` property. When set, geographic inputs
are converted to Cartesian via the geodetic system's ENU reference:

```js
import { GeodeticSystem, Ellipsoid } from "@dev/geodesy";

const adapter = new McpCameraAdapter(scene, camera);
adapter.geodeticSystem = new GeodeticSystem(Ellipsoid.WGS84);
```

### Using geographic coordinates in CesiumJS

The Cesium adapter uses `resolveToCartesian3()` with WGS84 by default. Geographic
inputs are automatically converted to ECEF — no extra setup required.

---

## Customising tool descriptions with Grammar

### Why customise?

Different LLM clients perform better with different description styles. Claude
prefers concise wording; other models may need more verbose explanations. The
grammar system lets you ship multiple description sets and select one per client.

Full documentation: [grammar.md](../grammar.md)

### Quick example

```ts
import { McpGrammar } from "@dev/core";

const concise = McpGrammar.fromJSON({
    "camera_set_position": {
        "description": "Teleport camera to a position.",
        "properties": {
            "position": "World-space {x,y,z} or geographic {lat,lon,alt?}."
        }
    }
});

const server = new McpServerBuilder()
    .withName("My Scene")
    .withGrammar("concise", concise)
    .withGrammarResolver(client => {
        if (client.name.includes("claude")) return "concise";
        return undefined; // fallback descriptions
    })
    .register(cameraBehavior)
    .build();
```

### Loading grammar from a JSON file

```ts
const response = await fetch("/grammars/cesium-claude.json");
const data = await response.json();
const grammar = McpGrammar.fromJSON(data);
```

---

## TLS / HTTPS setup

### Generate a self-signed certificate

```bash
npm run gen-cert
```

Creates `certs/cert.pem` and `certs/key.pem` (the `certs/` folder is gitignored).

### Start with TLS

**Bash / Git Bash:**

```bash
MCP_TUNNEL_TLS_CERT=certs/cert.pem MCP_TUNNEL_TLS_KEY=certs/key.pem npm run server:start
```

**PowerShell:**

```powershell
$env:MCP_TUNNEL_TLS_CERT="certs\cert.pem"
$env:MCP_TUNNEL_TLS_KEY="certs\key.pem"
npm run server:start
```

**Shortcut:**

```bash
npm run server:start:https
```

### Browser warning

Self-signed certs trigger a browser warning on first visit. Click
**Advanced → Proceed to localhost**. MCP clients (Claude Code, MCP Inspector)
typically skip certificate validation for `localhost`.

### Production certificates

Point the env vars at your Let's Encrypt (or other CA) files:

```bash
MCP_TUNNEL_TLS_CERT=/etc/letsencrypt/live/example.com/fullchain.pem
MCP_TUNNEL_TLS_KEY=/etc/letsencrypt/live/example.com/privkey.pem
```

---

## Development workflow

### Watch mode for fast iteration

Run these in separate terminals for live rebuilds:

```bash
# Terminal 1 — TypeScript compilation
npm run build:watch

# Terminal 2 — Webpack bundling (core only in watch)
npm run bundle:watch

# Terminal 3 — Tunnel server
npm run server:start
```

After each change, refresh the browser to pick up the new bundles.

### Full rebuild shortcut

```bash
npm run build:all:dev
```

This runs TypeScript compilation, webpack bundling (dev mode with source maps),
and deploys bundles to the dev harness — all in one command.

### Linting and formatting

```bash
npm run lint:check      # ESLint check
npm run lint:fix        # ESLint auto-fix
npm run format:check    # Prettier check
```

Prettier config: 180 columns, 4 spaces, double quotes, trailing comma (es5).

---

## Adding a new behavior

1. **Define the behavior** in `@dev/behaviors`:

```ts
export class McpMyBehavior extends McpBehavior {
    constructor() {
        super("mytype"); // namespace
    }
    // Define tools, resources, URI templates...
}
```

2. **Create engine adapters** in `@dev/babylon` and/or `@dev/cesium`:

```ts
export class McpMyAdapter extends McpAdapterBase {
    // Implement tool handlers that interact with the engine
}
```

3. **Register** the behavior with the server:

```ts
const myBehavior = new McpMyBehavior();
myBehavior.attachAdapter(new McpMyAdapter(scene));

const server = new McpServerBuilder()
    .register(cameraBehavior, lightBehavior, myBehavior)
    .build();
```

---

## Using camera animations

### Fly to a position

```jsonc
// Tool: camera_animate_to
{
    "uri": "babylon://camera/main",
    "position": { "x": 10, "y": 5, "z": -3 },
    "target": { "x": 0, "y": 0, "z": 0 },
    "duration": 2,
    "easing": "sine.inout"
}
```

### Orbit around target

```jsonc
// Tool: camera_animate_orbit
{
    "uri": "babylon://camera/main",
    "deltaAlpha": 360,
    "duration": 10,
    "loop": true,
    "easing": "linear"
}
```

### Follow a path

```jsonc
// Tool: camera_follow_path
{
    "uri": "babylon://camera/main",
    "waypoints": [
        { "position": { "x": 10, "y": 5, "z": 0 }, "target": { "x": 0, "y": 0, "z": 0 } },
        { "position": { "x": 0, "y": 10, "z": 10 }, "target": { "x": 0, "y": 0, "z": 0 } },
        { "position": { "x": -10, "y": 5, "z": 0 }, "target": { "x": 0, "y": 0, "z": 0 } }
    ],
    "duration": 6,
    "easing": "cubic.inout"
}
```

### Easing reference

Format: `'<type>'` (defaults to inout) or `'<type>.<mode>'`.

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

Modes: `in` (start slow), `out` (end slow), `inout` (slow at both ends).

---

## Testing with MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

1. Open the Inspector URL (usually `http://localhost:6274/`)
2. Select **Streamable HTTP** transport
3. URL: `http://localhost:3000/<serverName>/mcp`
4. Click **Connect**

Make sure the browser dev harness is connected first, otherwise you get
`-32000 No provider connected`.

### Useful tabs

| Tab | What it shows |
|-----|---------------|
| **Resources → List** | All registered resources (meshes, cameras, lights) |
| **Resources → Templates** | URI templates for each behavior type |
| **Resources → Read** | JSON state for a specific resource |
| **Tools → List** | All available tools with schemas |
| **Tools → Call** | Execute a tool interactively |

---

## Troubleshooting

### "No provider connected"

The browser page has not connected to the tunnel yet. Open `http://localhost:3000/`
and click **Start**.

### Tools not showing up

- Check that behaviors are registered with `McpServerBuilder.register()`
- Check that adapters are attached with `behavior.attachAdapter()`
- Verify the tunnel is running (`npm run server:start`)

### Bundle not loading

After TypeScript changes, rebuild and redeploy:

```bash
npm run build:all:dev
```

Then hard-refresh the browser (`Ctrl+Shift+R`).

### Self-signed cert rejected

Some MCP clients reject self-signed certificates. For `localhost` development,
HTTP is usually sufficient. Use TLS only when the client requires it.
