import { ISnapshotFilter } from "./snapshot.interfaces";

/**
 * Composable filter manager that handles filter registration, selection,
 * worker-based execution, and base64 encoding.
 *
 * Adapters that support image filtering hold an {@link IImageFilterSet}
 * instance and delegate all filter operations to it.
 */
export interface IImageFilterSet {
    /**
     * Registers a snapshot filter (or pipeline).  Filters run in registration
     * order after the raw capture.
     *
     * @throws If a filter with the same name is already registered.
     */
    registerFilter(filter: ISnapshotFilter): void;

    /** Removes a previously registered snapshot filter by name. */
    unregisterFilter(name: string): void;

    /** Names of all registered snapshot filters, in registration order. */
    readonly filterNames: string[];

    /**
     * Returns name + description for every registered filter.
     * Filters without a description get an empty string.
     */
    getFilterDescriptions(): ReadonlyArray<{ name: string; description: string }>;

    /**
     * Runs the snapshot filter pipeline on raw pixel data.
     *
     * @param imageData    Raw RGBA pixel buffer from the engine capture.
     * @param filterNames  Filter selection:
     *                     - `undefined` (omitted) → run **all** registered filters.
     *                     - `[]` (empty array) → skip all filters (raw capture).
     *                     - `["name1", ...]` → run only the named filters, in
     *                       registration order.
     * @param context      Optional engine-specific objects passed to each filter.
     * @returns            The filtered image data.
     */
    applyFiltersAsync(imageData: ImageData, filterNames?: string[], context?: Record<string, unknown>): Promise<ImageData>;

    /**
     * Encodes an {@link ImageData} to a raw base64 PNG string (no `data:` prefix).
     */
    imageDataToBase64(imageData: ImageData): Promise<string>;

    /** Releases resources (terminates Worker, clears filter list). */
    dispose(): void;
}

/**
 * Marker interface for adapters that support image filtering.
 * Camera adapters implement this to expose their {@link IImageFilterSet}.
 */
export interface IHasImageFiltering {
    readonly imageFiltering: IImageFilterSet;
}

/** Type guard for {@link IHasImageFiltering}. */
export function isHasImageFiltering(obj: unknown): obj is IHasImageFiltering {
    return obj !== null && typeof obj === "object" && "imageFiltering" in obj;
}
