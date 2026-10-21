/**
 * `vite build`, then the mobile budget check on the same output directory.
 * The last step of `npm run build`.
 *
 * Why a wrapper: `npm run build -- --outDir /tmp/psy/dist` appends its
 * arguments to the LAST command of the script chain only. When the chain
 * ended in `vite build && node tools/verify-mobile-budget.mjs`, vite never
 * saw --outDir and overwrote the live dist/ (server/index.mjs serves it), and
 * the budget check was handed "--outDir" as its directory. Here every
 * argument goes to vite, and the check reads the outDir out of them.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const at = args.findIndex((a) => a === "--outDir" || a.startsWith("--outDir="));
const outDir = at < 0 ? "dist" : args[at].includes("=") ? args[at].split("=")[1] : args[at + 1];

const vite = join(dirname(createRequire(import.meta.url).resolve("vite/package.json")), "bin/vite.js");
const run = (file, argv) => execFileSync(process.execPath, [file, ...argv], { stdio: "inherit" });
try {
  run(vite, ["build", ...args]);
  run("tools/verify-mobile-budget.mjs", [outDir]);
} catch {
  process.exit(1); // the child already printed why
}
