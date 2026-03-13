import { IWorkerSnapshotFilter } from "./interfaces";

/**
 * CPU filter that converts an image to grayscale using the luminance
 * formula (ITU-R BT.601).  Runs in a Web Worker when available.
 *
 * ```ts
 * adapter.imageFiltering.registerFilter(new GrayscaleSnapshotFilter());
 * ```
 */
export class GrayscaleSnapshotFilter implements IWorkerSnapshotFilter {
    public readonly name = "grayscale";
    public readonly description =
        "Converts the image to grayscale using the ITU-R BT.601 luminance formula " +
        "(0.299 R + 0.587 G + 0.114 B). Useful for removing colour distractions " +
        "and focusing on shape, contrast, and lighting.";

    public readonly workerParams = {};

    public readonly workerFn = `
        for (var i = 0; i < data.length; i += 4) {
            var gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            data[i] = data[i + 1] = data[i + 2] = gray;
        }
        return data;
    `;

    /** Main-thread fallback. */
    public apply(imageData: ImageData): ImageData {
        const d = imageData.data;
        for (let i = 0; i < d.length; i += 4) {
            const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            d[i] = d[i + 1] = d[i + 2] = gray;
        }
        return imageData;
    }
}
