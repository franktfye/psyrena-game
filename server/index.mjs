/**
 * Standalone runner: the account API plus (when a build exists) the game
 * itself, from one process. `npm run build && npm run server` is a complete
 * origin — put Cloudflare (or any CDN/proxy) in front for TLS, compression
 * and asset caching, and set:
 *   PSYRENA_SECURE_COOKIES=1  session cookie carries Secure
 *   PSYRENA_TRUST_PROXY=1     rate limiting reads CF-Connecting-IP/X-Forwarded-For
 *
 * Static serving is deliberately simple — hashed assets get immutable cache
 * headers and the CDN does the heavy lifting. No compression work per request:
 * `vite build` writes .br/.gz siblings (tools/precompress.mjs) and this only
 * picks one by Accept-Encoding. That matters even behind Cloudflare, which
 * re-compresses text at lower levels and never touches octet-stream (the HDR
 * environment) — and the tailnet origin has no CDN in front at all.
 */
import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { handleApi, closeDb } from "./app.mjs";

// One process serves every player: a stray rejection must be a log line, not
// a shutdown. Node's default policy for either of these is process exit.
process.on("unhandledRejection", (err) => console.error("[api] unhandled rejection:", err));
process.on("uncaughtException", (err) => console.error("[api] uncaught exception:", err));

const PORT = Number(process.env.PORT ?? 8787);
const STATIC_DIR = process.env.PSYRENA_STATIC ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const HAS_STATIC = existsSync(join(STATIC_DIR, "index.html"));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".glb": "model/gltf-binary",
  ".ktx2": "image/ktx2",
  ".hdr": "application/octet-stream",
  ".env": "application/octet-stream",
  // All shipped audio is Opus-in-WebM (see src/core/audio.ts). This MUST be
  // declared: falling through to application/octet-stream makes Safari refuse
  // to decode the file, and every playback path in the client swallows that
  // into silence — so the bug presents as "the game has no sound on iPhone"
  // with nothing in the console. `audio/webm` rather than `video/webm`, since
  // these carry no video track.
  ".webm": "audio/webm",
  ".mp4": "video/mp4",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
};

/**
 * Vite's content-hashed outputs, exactly — the list the psyrena-immutable-assets
 * plugin (vite.config.ts) writes into every build.
 *
 * "Everything under /assets/" is NOT the same set: public/assets/** (hero and
 * boss GLBs, OST, KTX2) is copied in under its own unhashed name, so marking
 * the whole prefix immutable cached a re-exported pavlov.glb in returning
 * players' browsers for a year. Only names on this list can never change.
 *
 * Re-read when the file changes, because a rebuild replaces dist/ under a
 * running server. No list (an old build) means nothing is immutable — every
 * file revalidates by ETag, which is slower but never stale.
 */
const IMMUTABLE_LIST = join(STATIC_DIR, "immutable-assets.json");
let immutableCache = { mtimeMs: -1, names: new Set() };
function immutableAssets() {
  const st = existsSync(IMMUTABLE_LIST) ? statSync(IMMUTABLE_LIST) : null;
  const mtimeMs = st ? st.mtimeMs : 0;
  if (mtimeMs !== immutableCache.mtimeMs) {
    let names = new Set();
    try {
      if (st) names = new Set(JSON.parse(readFileSync(IMMUTABLE_LIST, "utf8")).map((n) => `/${n}`));
    } catch (e) {
      console.error("[api] unreadable immutable-assets.json:", e);
    }
    immutableCache = { mtimeMs, names };
  }
  return immutableCache.names;
}

/**
 * Conditional GET: does the client's cached copy still match? An ETag check
 * wins over the date when both are sent (RFC 9110 §13.2.2).
 */
function isFresh(req, etag, mtime) {
  const inm = req.headers["if-none-match"];
  if (inm) return inm.split(",").some((t) => t.trim() === etag || t.trim() === "*");
  const ims = Date.parse(req.headers["if-modified-since"] ?? "");
  return !Number.isNaN(ims) && Math.floor(mtime.getTime() / 1000) * 1000 <= ims;
}

/**
 * The best precompressed sibling the client accepts, or null for identity.
 * Siblings exist only where they paid for themselves (tools/precompress.mjs),
 * so their presence on disk is the whole policy.
 */
function pickEncoding(acceptEncoding = "", filePath) {
  // "br;q=0" is an explicit refusal, so the q-value has to be read.
  const accepted = new Set(
    acceptEncoding
      .split(",")
      .map((token) => token.trim().split(";"))
      .filter(([, q]) => !/^\s*q=0(\.0*)?\s*$/.test(q ?? ""))
      .map(([name]) => name.trim().toLowerCase())
  );
  const accepts = (name) => accepted.has(name);
  if (accepts("br") && existsSync(`${filePath}.br`)) return "br";
  if (accepts("gzip") && existsSync(`${filePath}.gz`)) return "gzip";
  return null;
}

function serveStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }
  // Resolve inside STATIC_DIR only — normalize() collapses any ../ the URL
  // smuggled in, and the prefix check refuses what remains.
  let filePath = normalize(join(STATIC_DIR, decodeURIComponent(pathname)));
  if (!filePath.startsWith(normalize(STATIC_DIR))) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "forbidden" }));
    return;
  }
  let stats = existsSync(filePath) ? statSync(filePath) : null;
  if (stats?.isDirectory()) {
    filePath = join(filePath, "index.html");
    stats = existsSync(filePath) ? statSync(filePath) : null;
  }
  if (!stats) {
    // A missing FILE is a 404. Only extensionless navigation routes get the
    // SPA shell.
    //
    // Handing the shell to a request for a missing asset is how a renamed or
    // deleted file becomes a `200 text/html`, which Cloudflare then caches
    // under the asset's own URL for hours — so the file stays "missing" long
    // after the origin has it. It bit exactly that way on the Opus deploy.
    // It is also silent: every audio path in the client swallows a decode
    // error, so an HTML body served as a sound is a game that just goes quiet.
    // `no-store` so a 404 during a deploy window is never the cached answer.
    const namesAFile = pathname.startsWith("/assets/") || extname(pathname) !== "";
    if (namesAFile) {
      res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    filePath = join(STATIC_DIR, "index.html");
    stats = statSync(filePath);
  }
  const ext = extname(filePath).toLowerCase();
  // Whole-file requests only: a Range is a byte offset into the identity body
  // (Safari media probes), which a compressed sibling cannot answer.
  const encoding = req.headers.range ? null : pickEncoding(req.headers["accept-encoding"], filePath);
  const bodyPath = encoding ? `${filePath}.${encoding === "br" ? "br" : "gz"}` : filePath;
  const bodyStats = encoding ? statSync(bodyPath) : stats;
  // Hashed build outputs never change. The shell must revalidate on every
  // load: a cached index.html outliving a deploy points at chunks the deploy
  // deleted. Everything else (public/) may change between deploys and
  // revalidates by ETag after five minutes — a 304, not a re-download.
  const cacheControl = immutableAssets().has(pathname)
    ? "public, max-age=31536000, immutable"
    : ext === ".html" || pathname === "/sw.js"
      ? "no-cache"
      : "public, max-age=300";
  // Weak: the .br and .gz bodies are different bytes of the same resource,
  // so the encoding rides in the tag and each representation validates alone.
  const etag = `W/"${stats.size.toString(36)}-${Math.floor(stats.mtimeMs).toString(36)}${encoding ? `-${encoding}` : ""}"`;
  const headers = {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Content-Length": bodyStats.size,
    "Cache-Control": cacheControl,
    ETag: etag,
    "Last-Modified": stats.mtime.toUTCString(),
    // Range support is not an optimization here: Safari probes media with
    // `Range: bytes=0-1` and refuses to play <video>/<audio> from an origin
    // that answers 200 — so without this, the trailer works everywhere
    // except iPhone, silently. Single ranges only; nothing sends multipart.
    "Accept-Ranges": "bytes",
  };
  if (encoding) headers["Content-Encoding"] = encoding;
  // Caches must key on the encoding whenever one is on offer, including for
  // the identity response, or a gzip-less client could be handed brotli.
  if (encoding || existsSync(`${filePath}.gz`)) headers.Vary = "Accept-Encoding";
  if (!req.headers.range && isFresh(req, etag, stats.mtime)) {
    const { "Content-Length": _len, ...notModified } = headers;
    res.writeHead(304, notModified);
    return void res.end();
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  let status = 200;
  let start = 0;
  let end = stats.size - 1;
  if (range && (range[1] !== "" || range[2] !== "")) {
    start = range[1] === "" ? Math.max(stats.size - Number(range[2]), 0) : Number(range[1]);
    if (range[1] !== "" && range[2] !== "") end = Math.min(Number(range[2]), stats.size - 1);
    if (start >= stats.size || start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${stats.size}`, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "range not satisfiable" }));
      return;
    }
    status = 206;
    headers["Content-Range"] = `bytes ${start}-${end}/${stats.size}`;
    headers["Content-Length"] = end - start + 1;
  }
  res.writeHead(status, headers);
  if (req.method === "HEAD") return void res.end();
  // The 200 path deliberately passes no start/end: {start: 0, end: -1} throws
  // on an empty file, and the whole-file stream needs no bounds anyway.
  const stream = status === 206 ? createReadStream(filePath, { start, end }) : createReadStream(bodyPath);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    const handled = await handleApi(req, res);
    if (handled) return;
    if (HAS_STATIC) {
      const pathname = new URL(req.url, "http://x").pathname;
      return serveStatic(req, res, pathname);
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "API server only serves /api/* (no dist/ build found)" }));
  } catch (e) {
    console.error("[api] request failed:", e);
    // Headers may already be gone out the door (an SSE stream that died
    // mid-setup) — ending the socket is all that is left to do safely.
    if (res.headersSent) return void res.end();
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "internal error" }));
  }
});

// Malformed TLS/HTTP noise from the open internet must not become an
// uncaught 'clientError' — answer minimally and drop the socket.
server.on("clientError", (err, socket) => {
  if (err.code !== "ECONNRESET" && socket.writable) {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  }
  socket.destroy();
});

server.listen(PORT, () =>
  console.log(`[api] listening on :${PORT}${HAS_STATIC ? ` — serving ${STATIC_DIR}` : " — API only (no dist/)"}`)
);

// SIGTERM/SIGINT: stop accepting, checkpoint the WAL, go. The timer covers
// the SSE streams that keep server.close() waiting forever.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[api] ${signal} — shutting down`);
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  setTimeout(() => {
    closeDb();
    process.exit(0);
  }, 5_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
