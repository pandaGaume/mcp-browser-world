import { IImageFilterSet, ISnapshotFilter, isWorkerSnapshotFilter, IWorkerSnapshotFilter } from "./interfaces";
import { SnapshotFilterWorkerPool } from "./snapshot.filterWorkerPool";

/**
 * Default implementation of {@link IImageFilterSet}.
 *
 * Handles filter registration, selection by name, worker-based execution
 * (partitioning consecutive worker-eligible filters into batched round-trips),
 * and base64 PNG encoding.
 *
 * ```ts
 * const filtering = new ImageFilterSet();
 * filtering.registerFilter(new RetinexSnapshotFilter(20));
 * filtering.registerFilter(new GrayscaleSnapshotFilter());
 *
 * const filtered = await filtering.applyFiltersAsync(imageData, ["retinex"]);
 * const base64   = await filtering.imageDataToBase64(filtered);
 * ```
 */
export class ImageFilterSet implements IImageFilterSet {
    private _filters: ISnapshotFilter[] = [];
    private _workerPool?: SnapshotFilterWorkerPool;

    // ── Registration ──────────────────────────────────────────────────────

    public registerFilter(filter: ISnapshotFilter): void {
        if (this._filters.some((f) => f.name === filter.name)) {
            throw new Error(`Snapshot filter "${filter.name}" is already registered.`);
        }
        this._filters.push(filter);
    }

    public unregisterFilter(name: string): void {
        this._filters = this._filters.filter((f) => f.name !== name);
    }

    public get filterNames(): string[] {
        return this._filters.map((f) => f.name);
    }

    public getFilterDescriptions(): ReadonlyArray<{ name: string; description: string }> {
        return this._filters.map((f) => ({ name: f.name, description: f.description ?? "" }));
    }

    // ── Execution ─────────────────────────────────────────────────────────

    public async applyFiltersAsync(imageData: ImageData, filterNames?: string[], context?: Record<string, unknown>): Promise<ImageData> {
        // Empty array → caller explicitly wants raw capture.
        if (filterNames !== undefined && filterNames.length === 0) {
            return imageData;
        }

        // Select which filters to run.
        let filters: ISnapshotFilter[];
        if (filterNames === undefined) {
            // Omitted → all registered filters.
            filters = this._filters;
        } else {
            // Named subset, in registration order.
            filters = this._filters.filter((f) => filterNames.includes(f.name));
            const unknown = filterNames.filter((n) => !filters.some((f) => f.name === n));
            if (unknown.length > 0) {
                throw new Error(`Unknown snapshot filter(s): ${unknown.join(", ")}`);
            }
        }

        // Partition filters into consecutive groups: worker-eligible batches
        // and main-thread filters, preserving registration order.
        type Group = { worker: true; filters: IWorkerSnapshotFilter[] } | { worker: false; filter: ISnapshotFilter };
        const groups: Group[] = [];

        for (const f of filters) {
            if (isWorkerSnapshotFilter(f)) {
                const last = groups[groups.length - 1];
                if (last && last.worker) {
                    last.filters.push(f);
                } else {
                    groups.push({ worker: true, filters: [f] });
                }
            } else {
                groups.push({ worker: false, filter: f });
            }
        }

        // Execute groups in order.
        let result = imageData;
        for (const group of groups) {
            if (group.worker) {
                if (!this._workerPool) {
                    this._workerPool = new SnapshotFilterWorkerPool();
                }
                result = await this._workerPool.applyFilters(result, group.filters);
            } else {
                result = await group.filter.apply(result, context);
            }
        }
        return result;
    }

    // ── Encoding ──────────────────────────────────────────────────────────

    public async imageDataToBase64(imageData: ImageData): Promise<string> {
        const canvas = new OffscreenCanvas(imageData.width, imageData.height);
        const ctx = canvas.getContext("2d")!;
        ctx.putImageData(imageData, 0, 0);
        const blob = await canvas.convertToBlob({ type: "image/png" });
        const buffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────

    public dispose(): void {
        this._workerPool?.dispose();
        this._workerPool = undefined;
        this._filters = [];
    }
}
