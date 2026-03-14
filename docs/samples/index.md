# Samples

The sample pages live in `packages/host/www/samples/` and are served by the
tunnel dev-server (`npm run server:start`). Each sample is a self-contained
HTML file that loads the UMD bundles and demonstrates a specific aspect of the
MCP Browser World framework.

---

## Overview

| Sample | Engine | Focus | Transport | Key concept |
|--------|--------|-------|-----------|-------------|
| [babylon-camera](babylon-camera.md) | Babylon.js | Camera control | WebSocket (Direct) | Single adapter/behavior, full camera tool-set |
| [babylon-light](babylon-light.md) | Babylon.js | Lighting | WebSocket (Direct) | Light creation/removal, protected lights |
| [babylon-mesh](babylon-mesh.md) | Babylon.js | Mesh manipulation | WebSocket (Direct) | Tag-based queries, multi-behavior server |
| [babylon-multiplex](babylon-multiplex.md) | Babylon.js | Multi-viewport | WebSocket (Multiplex) | N servers over one WebSocket, per-rover viewports |
| [babylon-client](babylon-client.md) | Babylon.js | Client loopback | LoopbackTransport | McpClient, rover-to-rover, dynamic tool panel |
| [cesium-camera](cesium-camera.md) | CesiumJS | Camera control | WebSocket (Direct) | ECEF coordinates, geographic scene |

---

## Running the samples

```bash
# from the repo root
npm run server:start          # HTTPS  (default)
npm run server:start:http     # HTTP   (no certificate)
```

The server opens your browser automatically. Navigate to the sample page, e.g.
`http://localhost:3000/samples/babylon-camera.html`.

---

## Progressive learning path

The samples are designed to be explored in order of increasing complexity:

1. **babylon-camera** -- Start here. One camera, one behavior, one server.
   Learn how adapters, behaviors, and the server builder fit together.

2. **babylon-light** -- Same pattern as camera, but with light-specific
   concepts: protected vs. user-created lights, directional/spot/hemisphere
   tool variants.

3. **babylon-mesh** -- Introduces multi-behavior registration (mesh + camera)
   on a single server. Demonstrates tag-based queries and scene understanding
   tools.

4. **babylon-multiplex** -- Scales to 4 independent rovers sharing one
   WebSocket via `MultiplexTransport`. Shows multi-viewport rendering and
   viewport-aware pointer input.

5. **babylon-client** -- Adds the client side. Rovers connect to each other
   in-process via `LoopbackTransport`. Demonstrates `McpClient`, dynamic tool
   discovery, and a reusable tool-panel UI.

6. **cesium-camera** -- Same camera behavior on a completely different engine
   (CesiumJS). Proves the adapter abstraction: identical MCP tools work in ECEF
   coordinates on a real globe.

---

## Shared infrastructure

All samples share a common dark-theme stylesheet
(`packages/host/www/samples/css/sample.css`) that defines:

- **CSS custom properties** for colors, typography, spacing
- **Layout skeleton**: fixed header, left panel (300 px), scene panel, console panel
- **Component styles**: status badge, buttons, form inputs, log entries
- **Console log** formatting with color-coded severity levels

Each sample adds its own inline `<style>` block for page-specific overlays
(viewport dividers, connection icons, tool panels, etc.).
