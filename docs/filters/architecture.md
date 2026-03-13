# Snapshot Filter Architecture

Post-processing filters that run on raw pixel data captured by camera adapters
before encoding to PNG. Filters can execute on the **main thread** or be
offloaded to a **Web Worker** for heavy computations.

**Package:** `@dev/filters`
**Namespace:** `packages/dev/filters/src/`

---

## Overview

```
camera_snapshot tool
    │
    ▼
  RenderTargetTexture  →  readPixels()  →  ImageData
    │
    ▼
  ┌──────────────────────────────────────────┐
  │  imageFiltering.applyFiltersAsync()      │
  │                                          │
  │  ISnapshotFilter[]  (registration order) │
  │     ├── worker-eligible batch ──► Worker │
  │     ├── main-thread filter               │
  │     └── worker-eligible batch ──► Worker │
  └──────────────────────────────────────────┘
    │
    ▼
  imageFiltering.imageDataToBase64()  →  PNG base64  →  MCP tool result
```

Filters are registered on the adapter's `imageFiltering` property and
selected by name through the `filters` parameter of `camera_snapshot`.

---

## Composition Model

Filter support is decoupled from `McpAdapterBase` (in `@dev/core`) via
composition. Camera adapters implement `IHasImageFiltering` and hold an
`IImageFilterSet`:

```typescript
import { IHasImageFiltering, ImageFilterSet } from "@dev/filters";

export class McpCameraAdapter extends McpAdapterBase implements IHasImageFiltering {
    public readonly imageFiltering = new ImageFilterSet();
}
```

This keeps `@dev/core` free of any filter-related code. The dependency flows
one way: `@dev/filters` is standalone, `@dev/babylon` and `@dev/cesium`
depend on both `@dev/core` and `@dev/filters`.

---

## Interfaces

### `ISnapshotFilter`

The base contract. Any object with a `name` and an `apply` method qualifies.

```typescript
interface ISnapshotFilter {
    readonly name: string;
    apply(imageData: ImageData, context?: Record<string, unknown>): Promise<ImageData> | ImageData;
}
```

### `IWorkerSnapshotFilter`

Extends `ISnapshotFilter` with two additional properties that enable off-thread
execution:

```typescript
interface IWorkerSnapshotFilter extends ISnapshotFilter {
    readonly workerFn: string;
    readonly workerParams: Record<string, unknown>;
}
```

| Property       | Description                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workerFn`     | Self-contained function body as a string. Receives `data` (`Uint8ClampedArray`), `width`, `height`, and `params`. Returns a `Uint8ClampedArray`. |
| `workerParams` | Serializable object forwarded to `params` inside the Worker.                                                                                     |

The `apply()` method is retained as a **main-thread fallback** when the Worker
cannot be created (e.g. CSP blocks blob URLs).

### `IImageFilterSet`

The composable filter manager. Handles registration, selection, execution
(with worker batching), and base64 encoding.

```typescript
interface IImageFilterSet {
    registerFilter(filter: ISnapshotFilter): void;
    unregisterFilter(name: string): void;
    readonly filterNames: string[];
    applyFiltersAsync(imageData: ImageData, filterNames?: string[], context?: Record<string, unknown>): Promise<ImageData>;
    imageDataToBase64(imageData: ImageData): Promise<string>;
    dispose(): void;
}
```

### `IHasImageFiltering`

Marker interface for adapters that support filtering:

```typescript
interface IHasImageFiltering {
    readonly imageFiltering: IImageFilterSet;
}
```

A type guard is available:

```typescript
import { isHasImageFiltering } from "@dev/filters";

if (isHasImageFiltering(adapter)) {
    adapter.imageFiltering.registerFilter(myFilter);
}
```

---

## Web Worker Pipeline

### How It Works

1. **Lazy creation** — `SnapshotFilterWorkerPool` creates a single Worker from
   an inline blob URL the first time a worker-eligible filter runs.
2. **Batching** — Consecutive worker-eligible filters are grouped into a single
   message, reducing round-trips.
3. **Zero-copy transfer** — `ImageData.data.buffer` is transferred (not copied)
   to and from the Worker via `postMessage` transferables.
4. **Sequential execution** — Inside the Worker, filter functions run in order
   on the same pixel buffer.
5. **Fallback** — If Worker creation fails, all filters fall back to their
   `apply()` method on the main thread.

### Worker Protocol

```
Main → Worker:
  { id, filters: [{ fnBody, params }], width, height, data: Uint8ClampedArray }
  Transfer: [data.buffer]

Worker → Main:
  { id, width, height, data: Uint8ClampedArray }
  Transfer: [data.buffer]
```

### Filter Partitioning

`ImageFilterSet.applyFiltersAsync` preserves registration order by partitioning
selected filters into consecutive groups:

```
[retinex(W), grayscale(W), custom(M), sharpen(W)]
  └── worker batch ──┘     │           └── worker batch
                            └── main thread
```

Each group executes in sequence. Worker batches go to the pool; main-thread
filters call `apply()` directly.

---

## Registering Filters

```typescript
import { RetinexSnapshotFilter, GrayscaleSnapshotFilter } from "@dev/filters";

adapter.imageFiltering.registerFilter(new RetinexSnapshotFilter(20));
adapter.imageFiltering.registerFilter(new GrayscaleSnapshotFilter());
```

Names must be unique. Call `unregisterFilter(name)` to remove one.

The `camera_snapshot` tool exposes a `filters` parameter (string array).
Passing `["retinex"]` runs only Retinex; passing `[]` (empty) skips all
filters and returns the raw capture.

---

## Creating a Custom Filter

### Main-Thread Only

```typescript
import { ISnapshotFilter } from "@dev/filters";

export class SepiaFilter implements ISnapshotFilter {
    readonly name = "sepia";

    apply(imageData: ImageData): ImageData {
        const d = imageData.data;
        for (let i = 0; i < d.length; i += 4) {
            const r = d[i],
                g = d[i + 1],
                b = d[i + 2];
            d[i] = Math.min(255, 0.393 * r + 0.769 * g + 0.189 * b);
            d[i + 1] = Math.min(255, 0.349 * r + 0.686 * g + 0.168 * b);
            d[i + 2] = Math.min(255, 0.272 * r + 0.534 * g + 0.131 * b);
        }
        return imageData;
    }
}
```

### Worker-Compatible

```typescript
import { IWorkerSnapshotFilter } from "@dev/filters";

export class InvertFilter implements IWorkerSnapshotFilter {
    readonly name = "invert";
    readonly workerParams = {};

    readonly workerFn = `
        for (var i = 0; i < data.length; i += 4) {
            data[i]     = 255 - data[i];
            data[i + 1] = 255 - data[i + 1];
            data[i + 2] = 255 - data[i + 2];
        }
        return data;
    `;

    apply(imageData: ImageData): ImageData {
        const d = imageData.data;
        for (let i = 0; i < d.length; i += 4) {
            d[i] = 255 - d[i];
            d[i + 1] = 255 - d[i + 1];
            d[i + 2] = 255 - d[i + 2];
        }
        return imageData;
    }
}
```

### Rules for `workerFn`

| Rule                                         | Reason                                                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| No closures or imports                       | The string is compiled with `new Function()` inside the Worker.                                             |
| Use `var` / `function` declarations          | Arrow functions and `let`/`const` work in modern browsers but `var` is safest for the `new Function` scope. |
| Access parameters via `params`               | Constructor values arrive through `workerParams → params`.                                                  |
| Return `data` (or a new `Uint8ClampedArray`) | The Worker posts the returned buffer back to the main thread.                                               |

---

## Error Handling

| Scenario                             | Behaviour                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| Unknown filter name                  | `applyFiltersAsync` throws with the list of unknown names.                                 |
| Worker creation fails (CSP)          | `SnapshotFilterWorkerPool.unavailable` becomes `true`; all filters fall back to `apply()`. |
| Runtime error inside Worker          | The promise rejects with the stringified error.                                            |
| Pool disposed during pending request | All pending promises reject with a disposal error.                                         |

---

## Cleanup

Camera adapters call `this.imageFiltering.dispose()` in their `dispose()`
method. This terminates the Worker and rejects any pending requests.
