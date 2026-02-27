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
 * | MCP_TUNNEL_BUNDLE_DIR      | packages/dev/core/bundle                |
 * | MCP_TUNNEL_NO_OPEN         | (set to any value to skip auto-launch)  |
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
 * Resolves a path from an env var (relative to CWD) or falls back to a path
 * relative to the compiled dist/ directory.
 */
function resolvePath(envVar: string, fallbackFromDist: string): string {
    const raw = process.env[envVar];
    return raw ? path.resolve(process.cwd(), raw) : path.resolve(__dist, fallbackFromDist);
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

// Default paths assume this binary is dist/bin.js inside packages/dev/tunnel/
//   __dist/../../../host/www       → packages/host/www
//   __dist/../../core/bundle       → packages/dev/core/bundle
const wwwDir = resolvePath("MCP_TUNNEL_WWW_DIR", "../../../host/www");
const bundleDir = resolvePath("MCP_TUNNEL_BUNDLE_DIR", "../../core/bundle");

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    const builder = new WsTunnelBuilder().withPort(port).withProviderPath(providerPath).withClientPath(clientPath).withMcpPath(mcpPath);

    if (host) {
        builder.withHost(host);
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
    const hr = "─".repeat(64);
    const localhost = `http://localhost:${port}`;
    const hasWww = fs.existsSync(wwwDir);
    const mcpSuffix = mcpPath.replace(/^\//, "");
    const sseSuffix = ssePath.replace(/^\//, "");

    console.log();
    console.log(`⚙️  MCP for Babylon — multi-provider tunnel started`);
    console.log(hr);
    console.log(`📡  Provider WebSocket   ws://localhost:${port}${providerPath}/<serverName>`);
    console.log(`🔌  MCP Inspector (HTTP) ${localhost}/<serverName>/${mcpSuffix}`);
    console.log(`📺  Claude Code   (SSE)  ${localhost}/<serverName>/${sseSuffix}`);
    console.log();
    console.log(`   Replace <serverName> with the name you pass to McpServerBuilder.withName()`);
    console.log(`   Example: server name "babylon-scene"`);
    console.log(`     Provider WS  →  ws://localhost:${port}${providerPath}/babylon-scene`);
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
