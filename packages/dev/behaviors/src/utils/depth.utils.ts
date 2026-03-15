/**
 * Engine-agnostic utilities for downsampling and encoding depth buffers
 * into compact representations suitable for MCP tool responses.
 *
 * Used by the `camera_lidar` tool in both Babylon.js and Cesium adapters.
 */

/**
 * Downsamples a full-resolution depth buffer (normalized `[0, 1]`) to a
 * `cols × rows` grid and converts values to **meters**.
 *
 * Each output cell contains the average depth of all source pixels that
 * fall within that cell, mapped from `[0, 1]` to `[near, far]`.
 *
 * @param depth    Full-resolution depth buffer (row-major, top-to-bottom,
 *                 values in `[0, 1]` where 0 = near plane, 1 = far plane).
 * @param srcW     Source width in pixels.
 * @param srcH     Source height in pixels.
 * @param cols     Output grid columns.
 * @param rows     Output grid rows.
 * @param near     Camera near plane distance in meters.
 * @param far      Camera far plane distance in meters.
 * @returns        `Float32Array` of length `cols × rows`, values in meters.
 */
export function downsampleDepthGrid(
    depth: Float32Array,
    srcW: number,
    srcH: number,
    cols: number,
    rows: number,
    near: number,
    far: number,
): Float32Array {
    const grid = new Float32Array(cols * rows);
    const cellW = srcW / cols;
    const cellH = srcH / rows;
    const range = far - near;

    for (let row = 0; row < rows; row++) {
        const yStart = Math.floor(row * cellH);
        const yEnd = Math.floor((row + 1) * cellH);

        for (let col = 0; col < cols; col++) {
            const xStart = Math.floor(col * cellW);
            const xEnd = Math.floor((col + 1) * cellW);

            let sum = 0;
            let count = 0;
            for (let y = yStart; y < yEnd; y++) {
                const rowOffset = y * srcW;
                for (let x = xStart; x < xEnd; x++) {
                    sum += depth[rowOffset + x];
                    count++;
                }
            }

            const avgNorm = count > 0 ? sum / count : 1;
            grid[row * cols + col] = near + avgNorm * range;
        }
    }

    return grid;
}

/**
 * Result of {@link encodeDepthGrid}.
 */
export interface ILidarResult {
    /** Number of horizontal columns (derived from `hFov / angularResolution`). */
    cols: number;
    /** Number of vertical rows (= beam count). */
    rows: number;
    /** Horizontal field of view used for the scan, in degrees. */
    hFov: number;
    /** Horizontal angular step between columns, in degrees. */
    angularResolution: number;
    /** Camera near plane distance, in meters. */
    near: number;
    /** Camera far plane distance, in meters. */
    far: number;
    /** Encoding format of the depth array. */
    encoding: "uint16" | "float32";
    /** Unit of depth values: `"mm"` for uint16, `"m"` for float32. */
    unit: "mm" | "m";
    /** Base64-encoded depth data (little-endian). */
    depth: string;
}

/**
 * Encodes a depth grid (meters) to a base64 string.
 *
 * @param grid              `Float32Array` of depth values in meters.
 * @param cols              Grid columns.
 * @param rows              Grid rows (= beams).
 * @param near              Camera near plane in meters.
 * @param far               Camera far plane in meters.
 * @param hFov              Horizontal FOV in degrees.
 * @param angularResolution Angular step in degrees.
 * @param encoding          `"uint16"` (millimeters, clamped 0–65535) or
 *                          `"float32"` (meters, full precision).
 */
export function encodeDepthGrid(
    grid: Float32Array,
    cols: number,
    rows: number,
    near: number,
    far: number,
    hFov: number,
    angularResolution: number,
    encoding: "uint16" | "float32",
): ILidarResult {
    let bytes: Uint8Array;
    let unit: "mm" | "m";

    if (encoding === "uint16") {
        // Meters → millimeters, clamped to uint16 range.
        const u16 = new Uint16Array(grid.length);
        for (let i = 0; i < grid.length; i++) {
            u16[i] = Math.min(Math.round(grid[i] * 1000), 65535);
        }
        bytes = new Uint8Array(u16.buffer);
        unit = "mm";
    } else {
        // Float32 meters, as-is.
        bytes = new Uint8Array(grid.buffer);
        unit = "m";
    }

    // Base64 encode.
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    const depth = btoa(binary);

    return { cols, rows, hFov, angularResolution, near, far, encoding, unit, depth };
}
