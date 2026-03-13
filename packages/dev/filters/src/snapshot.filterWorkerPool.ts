import { IWorkerSnapshotFilter } from "./interfaces";
import { getWorkerScript } from "./snapshot.workerRuntime";

interface PendingRequest {
    resolve: (value: ImageData) => void;
    reject: (reason: Error) => void;
}

/**
 * Manages a single lazily-created Web Worker that executes
 * {@link IWorkerSnapshotFilter} instances off the main thread.
 *
 * Pixel data is **transferred** (not copied) to and from the Worker,
 * making the overhead negligible for large images.
 *
 * If the Worker cannot be created (e.g. CSP blocks blob URLs), all
 * subsequent calls silently fall back to main-thread execution via
 * each filter's {@link IWorkerSnapshotFilter.apply} method.
 */
export class SnapshotFilterWorkerPool {
    private _worker: Worker | null = null;
    private _workerUnavailable = false;
    private _pending = new Map<number, PendingRequest>();
    private _nextId = 0;

    // ── Lazy Worker creation ─────────────────────────────────────────────

    private _ensureWorker(): Worker | null {
        if (this._workerUnavailable) return null;
        if (this._worker) return this._worker;

        try {
            const blob = new Blob([getWorkerScript()], { type: "text/javascript" });
            const url = URL.createObjectURL(blob);
            this._worker = new Worker(url);
            URL.revokeObjectURL(url);

            this._worker.onmessage = (e: MessageEvent) => {
                const msg = e.data as { id: number; data?: Uint8ClampedArray; width?: number; height?: number; error?: string };
                const pending = this._pending.get(msg.id);
                if (!pending) return;
                this._pending.delete(msg.id);

                if (msg.error) {
                    pending.reject(new Error(`Worker filter error: ${msg.error}`));
                } else {
                    const result = new ImageData(new Uint8ClampedArray(msg.data!), msg.width!, msg.height!);
                    pending.resolve(result);
                }
            };

            this._worker.onerror = (e: ErrorEvent) => {
                // Reject all pending requests.
                for (const [, pending] of this._pending) {
                    pending.reject(new Error(`Worker error: ${e.message}`));
                }
                this._pending.clear();
            };

            return this._worker;
        } catch {
            this._workerUnavailable = true;
            return null;
        }
    }

    // ── Public API ────────────────────────────────────────────────────────

    /** `true` when the Worker could not be created and all calls fall back to main thread. */
    public get unavailable(): boolean {
        return this._workerUnavailable;
    }

    /**
     * Runs a sequence of worker-compatible filters on {@link ImageData}.
     *
     * @returns A new `ImageData` with the filtered pixels, or the original
     *          if the Worker is unavailable (main-thread fallback applied
     *          in that case by the caller).
     */
    public async applyFilters(imageData: ImageData, filters: IWorkerSnapshotFilter[]): Promise<ImageData> {
        const worker = this._ensureWorker();
        if (!worker) {
            // Fallback: run on main thread.
            let result = imageData;
            for (const f of filters) {
                result = await f.apply(result);
            }
            return result;
        }

        const id = this._nextId++;
        const data = imageData.data;
        const filterDescs = filters.map((f) => ({ fnBody: f.workerFn, params: f.workerParams }));

        return new Promise<ImageData>((resolve, reject) => {
            this._pending.set(id, { resolve, reject });
            worker.postMessage({ id, filters: filterDescs, width: imageData.width, height: imageData.height, data }, [data.buffer]);
        });
    }

    /** Terminates the Worker and rejects pending requests. */
    public dispose(): void {
        if (this._worker) {
            this._worker.terminate();
            this._worker = null;
        }
        for (const [, pending] of this._pending) {
            pending.reject(new Error("SnapshotFilterWorkerPool disposed."));
        }
        this._pending.clear();
    }
}
