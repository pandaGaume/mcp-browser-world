/**
 * A pluggable image filter applied to camera snapshots after capture.
 *
 * Filters operate on raw {@link ImageData} (RGBA pixel buffer) and return a
 * (possibly new) {@link ImageData}.  Base64 encoding happens **once**, after
 * the entire filter pipeline has finished.
 *
 * Implement this interface to create a single filter.  Use
 * {@link SnapshotFilterPipeline} to chain several filters into a named,
 * composite unit that can be registered in one call.
 */
export interface ISnapshotFilter {
    /** Unique name used to select this filter in per-call `filters` arrays. */
    readonly name: string;

    /**
     * Human-readable description of what this filter does.
     * Exposed by the `camera_list_filters` tool so an LLM can decide which
     * filters to apply.  Supports grammar overrides like any other description.
     */
    readonly description?: string;

    /**
     * Transforms an image captured from a camera snapshot.
     *
     * @param imageData  Raw RGBA pixel buffer (width × height × 4 bytes).
     * @param context    Optional engine-specific context supplied by the adapter
     *                   (e.g. `{ scene, engine, camera }` for Babylon.js).
     *                   CPU-only filters can safely ignore this parameter.
     * @returns          The (possibly mutated) image data, synchronously or as a
     *                   `Promise`.
     */
    apply(imageData: ImageData, context?: Record<string, unknown>): Promise<ImageData> | ImageData;
}
