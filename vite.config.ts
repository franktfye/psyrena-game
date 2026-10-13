import { defineConfig, type Plugin } from "vite";
import { fileURLToPath, URL } from "node:url";
import { resolve } from "node:path";
import { precompress } from "./tools/precompress.mjs";

/**
 * Mount the account API (server/app.mjs) directly into the dev server.
 *
 * Same origin as the game, so `npm run dev` is the whole stack: no second
 * process to remember, no proxy, and session cookies just work. A static
 * deployment runs `npm run server` (server/index.mjs) behind a reverse proxy
 * instead — same handler either way.
 *
 * Loading goes through `ssrLoadModule`, NOT a bare `import()`. Node's ESM cache
 * is permanent for the life of the process: with a plain import, a dev server
 * started before a server/*.mjs edit keeps serving the code as it was at first
 * request, forever. That is how a whole router can go missing in the browser
 * while it is plainly there on disk — the achievements/leaderboards panels
 * answered "No such endpoint." from a build that predated their routes, and
 * nothing short of a manual restart brought them back. Vite's SSR module graph
 * watches the files and invalidates importers, so an edit anywhere under
 * server/ is picked up on the next request.
 *
 * Re-evaluating app.mjs opens a fresh node:sqlite handle and drops whatever the
 * lobby/queue kept in module scope. That is dev-only churn on a file you just
 * edited, and the alternative is silently stale routes.
 */
function accountApi(): Plugin {
  return {
    name: "psyrena-account-api",
    configureServer(server) {
      // Dev fixtures (frank/jung/adler/horney + two rooms) exist only under
      // the dev server — a production boot of server/index.mjs never seeds
      // accounts. Set here so `npm run dev` stays zero-config for the e2e
      // scripts that log in with the fixture credentials.
      process.env.PSYRENA_DEV_SEED ??= "1";
      server.middlewares.use((req, res, next) => {
        server
          .ssrLoadModule("/server/app.mjs")
          .then(({ handleApi }) => handleApi(req, res) as Promise<boolean>)
          .then((handled) => { if (!handled) next(); })
          .catch(next);
      });
    },
  };
}

/**
 * Brotli/gzip siblings for every compressible file in the build output
 * (tools/precompress.mjs), served by server/index.mjs per Accept-Encoding.
 *
 * Without this the production server sends the boot chunk raw — ~3 MB of JS
 * over a phone's connection where ~0.6 MB would do. closeBundle runs after
 * public/ has been copied in, so the HDR environment and wasm transcoders get
 * compressed alongside the hashed chunks.
 */
function precompressBuild(): Plugin {
  let outDir = "dist";
  return {
    name: "psyrena-precompress",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const r = precompress(outDir);
      console.log(`[precompress] ${r.files} files: ${r.rawMB.toFixed(1)} MB -> ${r.brMB.toFixed(1)} MB brotli`);
    },
  };
}

/**
 * `immutable-assets.json`: every content-hashed file this build emitted.
 *
 * server/index.mjs gives exactly these a one-year immutable Cache-Control, and
 * public/sw.js serves exactly these cache-first. Neither can infer the set from
 * the path: public/assets/** lands under /assets/ too, with stable unhashed
 * names whose bytes change between deploys. `enforce: "post"` so files other
 * plugins emit in generateBundle are already in the bundle when it is listed.
 */
function immutableAssetList(): Plugin {
  return {
    name: "psyrena-immutable-assets",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      this.emitFile({
        type: "asset",
        fileName: "immutable-assets.json",
        source: JSON.stringify(Object.keys(bundle).filter((f) => f.startsWith("assets/")).sort()),
      });
    },
  };
}

// Vite rejects any Host header it does not recognise (DNS-rebinding defence),
// on the dev server as well as `preview`. If you reach the dev server under any
// name other than localhost -- a LAN hostname, a Tailscale MagicDNS name, a
// tunnel -- it must be listed here or the app 403s with "Blocked request".
//
// Deliberately NOT `true`: allowing every host is the same defence switched off.
// Add your own names at launch rather than editing this file:
//   PSYRENA_ALLOWED_HOSTS=game.example.com,box.tailnet.ts.net npm run dev
const ALLOWED_HOSTS = [
  ...(process.env.PSYRENA_ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean) ?? []),
];

export default defineConfig({
  plugins: [accountApi(), immutableAssetList(), precompressBuild()],
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    host: true,
    port: 5173,
    allowedHosts: ALLOWED_HOSTS,
  },
  preview: {
    host: true,
    port: 4173,
    allowedHosts: ALLOWED_HOSTS,
  },
  optimizeDeps: {
    // Vite's default dep scan crawls EVERY *.html under the repo root, and the
    // scratch pages under assets/work/ import packages that are deliberately
    // not installed (e.g. the mesh2motion viewer's bare `three` imports). The
    // scan then aborts with "dependencies … could not be resolved" on every
    // server start. The game has exactly one real entry; scan only that.
    // admin/boss-math and public/*.html are self-contained (inline scripts /
    // CDN globals) and never need dep optimization.
    entries: ["index.html"],
  },
  build: {
    target: "es2022",
    // NOTE: do NOT hand-roll manualChunks for @babylonjs/core.
    //
    // The obvious version — `if (id.includes("@babylonjs/core")) return
    // "babylon-core"` — drags every inspector-only module into the eagerly
    // loaded chunk, because the inspector imports deep into core. That turns a
    // lazily imported dev tool into ~5 MB of initial download and silently
    // blows the budget in docs/06. Rollup's default splitting already respects
    // the dynamic-import boundary in src/main.ts. Leave it alone.
    chunkSizeWarningLimit: 2500,
    reportCompressedSize: true,
  },
  // KTX2 transcoder wasm/js are copied into public/ktx2 — never bundled.
  assetsInclude: ["**/*.ktx2", "**/*.env", "**/*.glb"],
});
