import { IWorkerSnapshotFilter } from "./interfaces";

/**
 * Single-Scale Retinex (SSR) filter that enhances local contrast and
 * recovers detail in shadows/highlights by subtracting a Gaussian-blurred
 * version of each channel (the "illumination estimate") from the original.
 *
 * The result is normalised back to [0, 255] so it can be used as a
 * standalone filter or as a stage in a {@link SnapshotFilterPipeline}.
 *
 * Runs in a Web Worker when available, keeping the main thread responsive.
 *
 * ```ts
 * adapter.imageFiltering.registerFilter(new RetinexSnapshotFilter());       // sigma = 80
 * adapter.imageFiltering.registerFilter(new RetinexSnapshotFilter(40));     // tighter kernel
 * ```
 */
export class RetinexSnapshotFilter implements IWorkerSnapshotFilter {
    public readonly name = "retinex";
    public readonly description =
        "Single-Scale Retinex (SSR) — enhances local contrast and recovers detail " +
        "in shadows and highlights by separating reflectance from illumination. " +
        "Controlled by a sigma parameter (default 80): smaller values emphasise fine detail, " +
        "larger values preserve global contrast.";
    private readonly _sigma: number;

    /**
     * @param sigma  Standard deviation of the Gaussian blur used to estimate
     *               illumination.  Larger values preserve more global contrast;
     *               smaller values emphasise fine detail.  Default: **80**.
     */
    constructor(sigma: number = 80) {
        this._sigma = sigma;
    }

    public get workerParams(): Record<string, unknown> {
        return { sigma: this._sigma };
    }

    // The entire retinex algorithm inlined as a self-contained function body.
    // Variables in scope: data (Uint8ClampedArray), width, height, params ({ sigma }).
    public readonly workerFn = `
        var sigma = params.sigma;
        var pixelCount = width * height;

        // ── Separate channels ─────────────────────────────
        var r = new Float32Array(pixelCount);
        var g = new Float32Array(pixelCount);
        var b = new Float32Array(pixelCount);
        for (var i = 0, j = 0; i < data.length; i += 4, j++) {
            r[j] = data[i];
            g[j] = data[i + 1];
            b[j] = data[i + 2];
        }

        // ── Build Gaussian kernel ─────────────────────────
        var radius = Math.ceil(sigma * 3);
        var kSize = 2 * radius + 1;
        var kernel = new Float32Array(kSize);
        var s2 = 2 * sigma * sigma;
        var total = 0;
        for (var ki = 0; ki < kSize; ki++) {
            var x = ki - radius;
            var v = Math.exp(-(x * x) / s2);
            kernel[ki] = v;
            total += v;
        }
        for (var ki = 0; ki < kSize; ki++) kernel[ki] /= total;

        // ── Separable Gaussian blur ───────────────────────
        function gaussianBlur(src) {
            var tmp = new Float32Array(pixelCount);
            // Horizontal pass
            for (var y = 0; y < height; y++) {
                var row = y * width;
                for (var x = 0; x < width; x++) {
                    var sum = 0;
                    for (var k = -radius; k <= radius; k++) {
                        var sx = Math.min(width - 1, Math.max(0, x + k));
                        sum += src[row + sx] * kernel[k + radius];
                    }
                    tmp[row + x] = sum;
                }
            }
            // Vertical pass
            var dst = new Float32Array(pixelCount);
            for (var x = 0; x < width; x++) {
                for (var y = 0; y < height; y++) {
                    var sum = 0;
                    for (var k = -radius; k <= radius; k++) {
                        var sy = Math.min(height - 1, Math.max(0, y + k));
                        sum += tmp[sy * width + x] * kernel[k + radius];
                    }
                    dst[y * width + x] = sum;
                }
            }
            return dst;
        }

        // ── Retinex per channel ───────────────────────────
        function retinex(channel, blur) {
            var len = channel.length;
            var out = new Float32Array(len);
            var mn = Infinity, mx = -Infinity;
            for (var i = 0; i < len; i++) {
                var v = Math.log(channel[i] + 1) - Math.log(blur[i] + 1);
                out[i] = v;
                if (v < mn) mn = v;
                if (v > mx) mx = v;
            }
            var range = mx - mn || 1;
            var result = new Uint8ClampedArray(len);
            for (var i = 0; i < len; i++) {
                result[i] = ((out[i] - mn) / range) * 255;
            }
            return result;
        }

        var blurR = gaussianBlur(r);
        var blurG = gaussianBlur(g);
        var blurB = gaussianBlur(b);

        var retR = retinex(r, blurR);
        var retG = retinex(g, blurG);
        var retB = retinex(b, blurB);

        // ── Write back, preserving alpha ──────────────────
        for (var i = 0, j = 0; i < data.length; i += 4, j++) {
            data[i]     = retR[j];
            data[i + 1] = retG[j];
            data[i + 2] = retB[j];
        }
        return data;
    `;

    /** Main-thread fallback. */
    public apply(imageData: ImageData): ImageData {
        const { width, height, data } = imageData;

        // Separate channels (skip alpha).
        const r = new Float32Array(width * height);
        const g = new Float32Array(width * height);
        const b = new Float32Array(width * height);
        for (let i = 0, j = 0; i < data.length; i += 4, j++) {
            r[j] = data[i];
            g[j] = data[i + 1];
            b[j] = data[i + 2];
        }

        // Gaussian blur each channel (separable: horizontal then vertical).
        const blurR = this._gaussianBlur(r, width, height);
        const blurG = this._gaussianBlur(g, width, height);
        const blurB = this._gaussianBlur(b, width, height);

        // Retinex: log(original + 1) - log(blurred + 1), then normalise.
        const retR = this._retinex(r, blurR);
        const retG = this._retinex(g, blurG);
        const retB = this._retinex(b, blurB);

        // Write back, preserving original alpha.
        for (let i = 0, j = 0; i < data.length; i += 4, j++) {
            data[i] = retR[j];
            data[i + 1] = retG[j];
            data[i + 2] = retB[j];
        }

        return imageData;
    }

    // ── Private helpers ───────────────────────────────────────────────────

    /** log(channel + 1) − log(blur + 1), normalised to [0, 255]. */
    private _retinex(channel: Float32Array, blur: Float32Array): Uint8ClampedArray {
        const len = channel.length;
        const out = new Float32Array(len);

        let min = Infinity;
        let max = -Infinity;
        for (let i = 0; i < len; i++) {
            const v = Math.log(channel[i] + 1) - Math.log(blur[i] + 1);
            out[i] = v;
            if (v < min) min = v;
            if (v > max) max = v;
        }

        // Normalise to 0–255.
        const range = max - min || 1;
        const result = new Uint8ClampedArray(len);
        for (let i = 0; i < len; i++) {
            result[i] = ((out[i] - min) / range) * 255;
        }
        return result;
    }

    /**
     * Separable Gaussian blur (horizontal pass then vertical pass).
     * Uses a 1-D kernel truncated at 3σ and mirror-clamped at edges.
     */
    private _gaussianBlur(src: Float32Array, w: number, h: number): Float32Array {
        const sigma = this._sigma;
        const radius = Math.ceil(sigma * 3);
        const kernel = this._buildKernel(sigma, radius);

        // Horizontal pass.
        const tmp = new Float32Array(w * h);
        for (let y = 0; y < h; y++) {
            const row = y * w;
            for (let x = 0; x < w; x++) {
                let sum = 0;
                for (let k = -radius; k <= radius; k++) {
                    const sx = Math.min(w - 1, Math.max(0, x + k));
                    sum += src[row + sx] * kernel[k + radius];
                }
                tmp[row + x] = sum;
            }
        }

        // Vertical pass.
        const dst = new Float32Array(w * h);
        for (let x = 0; x < w; x++) {
            for (let y = 0; y < h; y++) {
                let sum = 0;
                for (let k = -radius; k <= radius; k++) {
                    const sy = Math.min(h - 1, Math.max(0, y + k));
                    sum += tmp[sy * w + x] * kernel[k + radius];
                }
                dst[y * w + x] = sum;
            }
        }

        return dst;
    }

    /** Builds a normalised 1-D Gaussian kernel of length `2 * radius + 1`. */
    private _buildKernel(sigma: number, radius: number): Float32Array {
        const size = 2 * radius + 1;
        const kernel = new Float32Array(size);
        const s2 = 2 * sigma * sigma;
        let total = 0;
        for (let i = 0; i < size; i++) {
            const x = i - radius;
            const v = Math.exp(-(x * x) / s2);
            kernel[i] = v;
            total += v;
        }
        // Normalise.
        for (let i = 0; i < size; i++) {
            kernel[i] /= total;
        }
        return kernel;
    }
}
