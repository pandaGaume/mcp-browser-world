# Grammar

## Why Grammar Matters

In the Model Context Protocol every tool is described by a JSON schema that includes a `description` for the tool itself and for each of its input properties. These descriptions are the **only** information the LLM receives when it decides which tool to call and how to fill in the arguments. A vague or misleading description leads to wrong tool calls; a precise one makes the agent reliable.

The **grammar** is the system that owns those descriptions. It is separated from the tool schema structure so that descriptions can be replaced, localised, or tuned without touching the schema definitions. Because the grammar is a plain JSON-serialisable object, it can be shipped as a file, fetched from a server, or edited in a UI.

## Architecture

### Resolution Order

Tool descriptions are resolved through two layers:

```
session grammar (server, per client)  →  fallback (inline string in behaviour)
```

| Layer | Set by | Typical use |
|-------|--------|-------------|
| **Session grammar** | Server, selected per client during `initialize` | Engine-specific wording, localisation, client-specific style (concise for Claude, verbose for GPT) |
| **Fallback** | Hardcoded in the behaviour source | Baseline English descriptions that are always available |

The session grammar is selected from a **grammar map** registered on the server. A **resolver function** maps the connecting client's identity (`McpClientInfo`) to a grammar key. If no resolver is configured, or it returns `undefined`, only fallback descriptions are used.

### Per-Session, Not Global

Each client connection resolves its own grammar during the `initialize` handshake. Two clients connected simultaneously to the same server can see different descriptions. The grammar is reset on disconnect and re-resolved on the next connection.

### What a Grammar Contains

A grammar maps **tool names** to an optional tool-level description and an optional set of **property descriptions**, keyed by property name (dot-notation is supported for nested properties).

```jsonc
// McpGrammarData
{
  "camera_set_target": {
    "description": "Sets the camera look-at point.",
    "properties": {
      "uri":    "Camera URI, e.g. babylon://camera/MyCamera",
      "target": "World-space look-at point. Cartesian {x,y,z} or geographic {lat,lon,alt?}."
    }
  },
  "camera_animate_to": {
    "description": "Smoothly animates the camera to a new position and/or target.",
    "properties": {
      "duration": "Animation duration in seconds. Defaults to 1.",
      "easing":   "Easing curve, e.g. 'sine.inout', 'bounce.out'."
    }
  }
}
```

A grammar does not need to be exhaustive. It can override a single tool description, a single property, or any combination. Keys that are not present in the grammar simply fall through to the fallback.

## McpGrammar Class

`McpGrammar` (`@dev/core`) is the runtime representation of a grammar.

### Construction

```ts
// Empty grammar
const g = new McpGrammar();

// From a plain object (e.g. parsed from JSON)
const g = new McpGrammar(data);

// Static factory (equivalent)
const g = McpGrammar.fromJSON(data);
```

### Reading and Writing Entries

```ts
// Tool-level descriptions
g.setToolDescription("camera_orbit", "Rotates the camera around its target.");
g.getToolDescription("camera_orbit");   // "Rotates the camera ..."

// Property-level descriptions (dot-notation supported)
g.setPropertyDescription("light_update", "patch.position", "Point, spot, directional (shadow frustum).");
g.getPropertyDescription("light_update", "patch.position");
```

### Serialisation

```ts
// Snapshot to a plain JSON-safe object
const data = grammar.toJSON();

// Reconstruct from that object
const copy = McpGrammar.fromJSON(data);
```

### Merging

`McpGrammar.merge()` overlays multiple grammars left-to-right. Later grammars win; `undefined` entries in a later grammar do **not** erase earlier entries.

```ts
const merged = McpGrammar.merge(grammarA, grammarB);
```

### Cloning

```ts
const snapshot = grammar.clone();
```

## Server-Level Grammar Configuration

Grammars are registered on the server via `McpServerBuilder` and selected per session.

### Registering Grammars

```ts
const server = new McpServerBuilder()
    .withName("babylon-scene")
    .withWsUrl("ws://localhost:8080")
    .withGrammar("concise", McpGrammar.fromJSON(conciseData))
    .withGrammar("verbose", McpGrammar.fromJSON(verboseData))
    .withGrammar("fr",      McpGrammar.fromJSON(frenchData))
    .withGrammarResolver(client => {
        if (client.name.includes("claude")) return "concise";
        if (client.name.includes("gpt"))    return "verbose";
        return undefined; // fallback only
    })
    .register(cameraBehavior, lightBehavior, meshBehavior)
    .build();
```

### How It Works

1. Client connects and sends `initialize` with `{ clientInfo: { name, version } }`
2. Server calls the grammar resolver with the client info
3. Resolver returns a key (e.g. `"concise"`) or `undefined`
4. Server looks up the key in its grammar map → stores as the session grammar
5. On every `tools/list` response, descriptions are patched from the session grammar on top of the behaviour's fallback descriptions
6. On disconnect, the session grammar is cleared

### Grammar Files

Grammar files are plain JSON matching the `McpGrammarData` shape. They can encode both engine-specific and client-specific descriptions in one place:

```jsonc
// grammars/cesium-claude.json — concise, ECEF-aware
{
  "camera_set_position": {
    "description": "Teleports the camera to an absolute ECEF position.",
    "properties": {
      "position": "ECEF {x,y,z} in metres or geographic {lat,lon,alt?}."
    }
  }
}

// grammars/cesium-gpt.json — verbose, ECEF-aware
{
  "camera_set_position": {
    "description": "Moves the camera instantly to a new position. Coordinates are in Earth-Centered Earth-Fixed (ECEF) frame where the origin is the center of the Earth and units are metres.",
    "properties": {
      "position": "The target position. You can provide either a Cartesian object {x, y, z} in ECEF metres, or a geographic object {lat, lon, alt} in WGS84 degrees with optional altitude in metres."
    }
  }
}
```

## Localisation Example

Ship a JSON file per locale. Properties not present in the file keep their English fallback.

```jsonc
// grammar-fr.json
{
  "camera_set_target": {
    "description": "Definit le point de visee de la camera.",
    "properties": {
      "target": "Point de visee en coordonnees cartesiennes {x,y,z} ou geographiques {lat,lon,alt?}."
    }
  },
  "camera_orbit": {
    "description": "Fait tourner la camera autour de sa cible."
  }
}
```

```ts
const server = new McpServerBuilder()
    .withGrammar("fr", McpGrammar.fromJSON(frData))
    .withGrammarResolver(client => {
        if (client.name.includes("fr")) return "fr";
        return undefined;
    })
    // ...
    .build();
```

## Summary

| Concern | Where | How |
|---------|-------|-----|
| Baseline English descriptions | Behaviour source (inline fallback strings) | Always present, no grammar object needed |
| Engine + client specific wording | Grammar JSON files | Registered on server via `withGrammar(key, grammar)` |
| Client selection | Grammar resolver on server | `withGrammarResolver(clientInfo => key)`, called during `initialize` |
| Multi-client support | Per-session grammar on server | Each connection resolves independently |
| Debugging / export | `grammar.toJSON()` | Snapshot any grammar to a plain JSON object |
