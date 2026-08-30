/**
 * Node module-resolution hook that understands the repo's import style.
 *
 * `shared/` is written for Vite and tsc, which both resolve `../combat` to
 * `../combat.ts`. Bare Node does not. This teaches it to, so plain
 * `node --experimental-strip-types` scripts in tools/ can import the real
 * shared model instead of restating its numbers — which would defeat the point
 * of a script whose whole job is checking those numbers.
 */
export async function resolve(specifier, context, next) {
  const relative = specifier.startsWith("./") || specifier.startsWith("../");
  const hasExtension = /\.[a-z0-9]+$/i.test(specifier);
  if (relative && !hasExtension) {
    for (const ext of [".ts", ".mjs", ".js", "/index.ts"]) {
      try {
        return await next(specifier + ext, context);
      } catch {
        // try the next candidate
      }
    }
  }
  return next(specifier, context);
}
