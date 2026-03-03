/**
 * deploy-bundles.mjs
 *
 * Collects every *.js (and *.map) file produced by each package's
 * webpack step and copies them into the single canonical bundle folder
 * that the tunnel server serves at /bundle.
 *
 * Destination : packages/host/www/bundle/
 * Sources     : packages/dev/core/bundle/
 *               packages/dev/babylon/bundle/
 *
 * Usage
 *   node scripts/deploy-bundles.mjs
 *   npm run deploy:bundles            (via root package.json)
 */

import { cp, mkdir, readdir } from "fs/promises";
import { existsSync }         from "fs";
import { resolve, dirname }   from "path";
import { fileURLToPath }      from "url";

const __root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DEST = resolve(__root, "packages/host/www/bundle");

/** All package bundle dirs that should be merged into DEST. */
const SOURCES = [
    resolve(__root, "packages/dev/core/bundle"),
    resolve(__root, "packages/dev/babylon/bundle"),
];

// ── helpers ─────────────────────────────────────────────────────────────────

const green  = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red    = (s) => `\x1b[31m${s}\x1b[0m`;
const dim    = (s) => `\x1b[2m${s}\x1b[0m`;

// ── main ─────────────────────────────────────────────────────────────────────

async function deploy() {
    console.log(`\n📦  Deploying bundles → ${dim(DEST)}\n`);

    // Ensure the destination directory exists (safe to call if already there).
    await mkdir(DEST, { recursive: true });

    let copied = 0;
    let skipped = 0;

    for (const src of SOURCES) {
        const pkg = src.replace(__root + "/", "");

        if (!existsSync(src)) {
            console.log(`  ${yellow("⚠")}  ${dim(pkg)}  — not built yet, skipping`);
            skipped++;
            continue;
        }

        const files = (await readdir(src)).filter((f) => f.endsWith(".js") || f.endsWith(".js.map"));

        if (files.length === 0) {
            console.log(`  ${yellow("⚠")}  ${dim(pkg)}  — bundle dir is empty, skipping`);
            skipped++;
            continue;
        }

        // Copy each file individually so we can log each one.
        for (const file of files) {
            await cp(resolve(src, file), resolve(DEST, file));
            console.log(`  ${green("✓")}  ${file}  ${dim(`← ${pkg}`)}`);
            copied++;
        }
    }

    if (copied === 0 && skipped === SOURCES.length) {
        console.error(`\n${red("✗")}  No bundles found. Run the bundle step first:\n`);
        console.error(`     npm run bundle\n`);
        process.exit(1);
    }

    console.log(`\n${green("✅")}  ${copied} file(s) deployed to packages/host/www/bundle/\n`);
}

deploy().catch((err) => {
    console.error(`\n${red("✗")}  Deploy failed:`, err);
    process.exit(1);
});
