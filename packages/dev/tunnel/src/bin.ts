/**
 * Standalone entry-point that starts the WebSocket tunnel server.
 *
 * ## Environment variables
 *
 * | Variable                   | Default (relative to this file's dist/) |
 * |----------------------------|-----------------------------------------|
 * | MCP_TUNNEL_PORT            | 3000                                    |
 * | MCP_TUNNEL_HOST            | 0.0.0.0                                 |
 * | MCP_TUNNEL_PROVIDER_PATH   | /provider                               |
 * | MCP_TUNNEL_CLIENT_PATH     | /                                       |
 * | MCP_TUNNEL_MCP_PATH        | /mcp                                    |
 * | MCP_TUNNEL_WWW_DIR         | packages/host/www      (monorepo root)  |
 * | MCP_TUNNEL_BUNDLE_DIR      | packages/host/www/bundle                |
 * | MCP_TUNNEL_NO_OPEN         | (set to any value to skip auto-launch)  |
 * | MCP_TUNNEL_TLS_CERT        | (path to PEM certificate — enables TLS) |
 * | MCP_TUNNEL_TLS_KEY         | (path to PEM private key — enables TLS) |
 *
 * Populate packages/host/www/bundle/ by running:
 *   npm run build:all        (TypeScript + webpack production + deploy)
 *   npm run build:all:dev    (TypeScript + webpack development + deploy)
 *   npm run deploy:bundles   (deploy only, after bundles are already built)
 *
 * All path env vars are resolved relative to `process.cwd()`.
 * When run via `npm run start --workspace=@dev/tunnel` from the repo root,
 * the defaults derived from `import.meta.url` also point to the correct
 * monorepo locations automatically.
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import open from "open";
import { WsTunnelBuilder } from "./index.js";

// ---------------------------------------------------------------------------
// Path resolution helpers
// ---------------------------------------------------------------------------

/** Absolute path of the compiled `dist/` directory (where this file lives). */
const __dist = path.dirname(fileURLToPath(import.meta.url));

/**
 * The directory where `npm run` was originally invoked.
 * npm sets INIT_CWD before changing into the workspace package directory,
 * so relative env-var paths like "certs/cert.pem" are resolved from the
 * monorepo root rather than from packages/dev/tunnel/.
 */
const initCwd = process.env["INIT_CWD"] ?? process.cwd();

/**
 * Resolves a path from an env var (relative to INIT_CWD) or falls back to a path
 * relative to the compiled dist/ directory.
 */
function resolvePath(envVar: string, fallbackFromDist: string): string {
    const raw = process.env[envVar];
    return raw ? path.resolve(initCwd, raw) : path.resolve(__dist, fallbackFromDist);
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const port = parseInt(process.env["MCP_TUNNEL_PORT"] ?? "3000", 10);
const host = process.env["MCP_TUNNEL_HOST"];
const providerPath = process.env["MCP_TUNNEL_PROVIDER_PATH"] ?? "/provider";
const clientPath = process.env["MCP_TUNNEL_CLIENT_PATH"] ?? "/";
const mcpPath = process.env["MCP_TUNNEL_MCP_PATH"] ?? "/mcp";
const ssePath = "/sse"; // Not currently configurable since it's hardcoded in the client bundle.
const tlsCertFile = process.env["MCP_TUNNEL_TLS_CERT"];
const tlsKeyFile  = process.env["MCP_TUNNEL_TLS_KEY"];

// Default paths assume this binary is dist/bin.js inside packages/dev/tunnel/
//   __dist/../../../host/www         → packages/host/www
//   __dist/../../../host/www/bundle  → packages/host/www/bundle  (all bundles aggregated here)
//
// Run `npm run build:all` (or `npm run deploy:bundles`) from the repo root
// to compile, webpack, and copy all bundles into packages/host/www/bundle/.
const wwwDir = resolvePath("MCP_TUNNEL_WWW_DIR", "../../../host/www");
const bundleDir = resolvePath("MCP_TUNNEL_BUNDLE_DIR", "../../../host/www/bundle");

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    const builder = new WsTunnelBuilder().withPort(port).withProviderPath(providerPath).withClientPath(clientPath).withMcpPath(mcpPath);

    if (host) {
        builder.withHost(host);
    }

    if (tlsCertFile && tlsKeyFile) {
        builder.withTlsFiles(
            path.resolve(initCwd, tlsCertFile),
            path.resolve(initCwd, tlsKeyFile),
        );
    }

    // Mount static directories that actually exist on disk.
    // /bundle must be registered before / so the prefix router can distinguish them.
    if (fs.existsSync(bundleDir)) {
        builder.withStaticMount("/bundle", bundleDir);
    }
    if (fs.existsSync(wwwDir)) {
        builder.withStaticMount("/", wwwDir);
    }

    const tunnel = builder.build();
    await tunnel.start();

    // ── Styled startup banner ──────────────────────────────────────────────
    const isTls     = !!(tlsCertFile && tlsKeyFile);
    const httpScheme = isTls ? "https" : "http";
    const wsScheme   = isTls ? "wss"   : "ws";
    const hr = "─".repeat(64);
    const localhost = `${httpScheme}://localhost:${port}`;
    const hasWww = fs.existsSync(wwwDir);
    const mcpSuffix = mcpPath.replace(/^\//, "");
    const sseSuffix = ssePath.replace(/^\//, "");

    console.log();
    console.log(`⚙️  MCP for Babylon — multi-provider tunnel started${isTls ? " (TLS)" : ""}`);
    console.log(hr);
    console.log(`📡  Provider WebSocket   ${wsScheme}://localhost:${port}${providerPath}/<serverName>`);
    console.log(`🔌  MCP Inspector (HTTP) ${localhost}/<serverName>/${mcpSuffix}`);
    console.log(`📺  Claude Code   (SSE)  ${localhost}/<serverName>/${sseSuffix}`);
    console.log();
    console.log(`   Replace <serverName> with the name you pass to McpServerBuilder.withName()`);
    console.log(`   Example: server name "babylon-scene"`);
    console.log(`     Provider WS  →  ${wsScheme}://localhost:${port}${providerPath}/babylon-scene`);
    console.log(`     MCP endpoint →  ${localhost}/babylon-scene/${mcpSuffix}`);
    if (hasWww) {
        console.log();
        console.log(`🖥️   Dev harness  ${localhost}/`);
        console.log(`   (The dev harness computes and shows the MCP endpoint automatically)`);
    }
    console.log(hr);
    console.log(`   Press Ctrl+C to stop.`);
    console.log();

    // Auto-launch the dev harness in the default browser unless suppressed.
    if (hasWww && !process.env["MCP_TUNNEL_NO_OPEN"]) {
        const devUrl = `${localhost}/`;
        console.log(`🚀  Opening dev harness: ${devUrl}`);
        console.log();
        await open(devUrl);
    }

    // ── Signal handlers ────────────────────────────────────────────────────
    const shutdown = async (signal: string): Promise<void> => {
        console.log(`\n⛔  ${signal} received — shutting down…`);
        await tunnel.stop();
        process.exit(0);
    };

    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
    console.error("[MCP Tunnel] Fatal error:", err);
    process.exit(1);
});
