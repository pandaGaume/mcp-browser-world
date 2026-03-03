/* eslint-disable @typescript-eslint/no-var-requires */
const path = require("path");

// ---------------------------------------------------------------------------
// Shared loader / resolver settings
// ---------------------------------------------------------------------------
const tsRule = {
    test: /\.tsx?$/,
    use: {
        loader: "ts-loader",
        options: {
            configFile: path.resolve(__dirname, "tsconfig.build.json"),
            // Type-checking is handled separately by tsc; skip it here so
            // webpack only transpiles and does not re-run the full type check.
            transpileOnly: true,
        },
    },
    exclude: /node_modules/,
};

const resolve = {
    extensions: [".ts", ".tsx", ".js"],
};

// ---------------------------------------------------------------------------
// Bundle factory
// ---------------------------------------------------------------------------
/**
 * @param {string} name   Internal webpack name and UMD library name.
 * @param {string} entry  Entry-point path relative to this file.
 * @param {string} out    Output filename inside the `bundle/` directory.
 * @param {"production"|"development"} mode
 * @returns {import("webpack").Configuration}
 */
function makeBundle(name, entry, out, mode) {
    const isProd = mode === "production";
    return {
        name,
        mode,
        entry: path.resolve(__dirname, entry),
        target: "web",
        devtool: isProd ? "source-map" : "inline-source-map",
        output: {
            filename: out,
            path: path.resolve(__dirname, "bundle"),
            library: {
                name,
                type: "umd",
            },
            // Use `globalThis` so the UMD wrapper works in both browsers and
            // web workers without relying on `window` or `global`.
            globalObject: "globalThis",
        },
        externals: [
            ({ request }, callback) => {
                if (request.match("^@babylonjs/core")) {
                    return callback(null, "BABYLON");
                }
                callback();
            },
            ({ request }, callback) => {
                // @dev/core classes (McpBehavior, McpAdapterBase, …) live in the
                // mcp-server.js bundle (window.McpServer), NOT in mcp-core.js
                // (window.McpCore), which only carries TypeScript interfaces that
                // are fully erased at runtime and produce no JavaScript values.
                if (request.match("^@dev/core")) {
                    return callback(null, "McpServer");
                }
                callback();
            },
        ],
        module: { rules: [tsRule] },
        resolve,
    };
}

// ---------------------------------------------------------------------------
// Multi-configuration export
// ---------------------------------------------------------------------------
/**
 * @param {Record<string, string>} _env   Webpack env vars (unused).
 * @param {{ mode?: string }}       argv  CLI arguments — carries `--mode`.
 * @returns {import("webpack").Configuration[]}
 */
module.exports = (_env, argv) => {
    const mode = /** @type {"production"|"development"} */ (argv.mode === "development" ? "development" : "production");

    return [
        // ------------------------------------------------------------------
        // mcp-core  — interfaces / type contracts only.
        // Consumer: any Babylon.js scene that needs the shared MCP types.
        // ------------------------------------------------------------------
        makeBundle("McpBabylon", "src/index.ts", "mcp-babylon.js", mode),
    ];
};
