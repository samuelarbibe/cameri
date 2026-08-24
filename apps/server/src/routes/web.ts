import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";

/**
 * Serves the built dashboard.
 *
 * Written out rather than pulled from a middleware package because the whole
 * job is four rules — content type, two cache policies and a fallback — and all
 * four are things we would end up overriding anyway.
 */

const MIME: Record<string, string> = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * Paths this host must never answer, whatever the client asked for.
 *
 * Without it, a typo against the API would be handed the dashboard's HTML with
 * a 200, and a reporter would report "unexpected token '<'" instead of the 404
 * that would have told its author what was actually wrong.
 */
const RESERVED = ["/api/", "/trpc", "/health"];

export function webRoutes(dir: string): Hono {
  const root = resolve(dir);
  const index = join(root, "index.html");

  const router = new Hono();

  router.on(["GET", "HEAD"], "/*", async (c) => {
    const path = decodeURIComponent(new URL(c.req.url).pathname);
    if (RESERVED.some((prefix) => path === prefix.replace(/\/$/, "") || path.startsWith(prefix))) {
      throw new HTTPException(404, { message: "not found" });
    }

    const file = resolveWithin(root, path);
    const found = file ? await sizeOf(file) : null;

    if (found !== null && file) {
      // Vite fingerprints everything under `assets/`, so those URLs can never
      // change meaning. `index.html` is the opposite: it names the current
      // bundle, and a cached copy pins a browser to a deployment that is gone.
      const immutable = path.startsWith("/assets/");
      return send(c, file, found, c.req.method === "HEAD", {
        "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      });
    }

    // A request that looks like a file and is not one is a 404, not the app:
    // returning HTML for a missing script tag turns a build problem into a
    // blank page with a syntax error.
    if (extname(path)) throw new HTTPException(404, { message: "not found" });

    // Anything else is a client-side route — `/acme/runs/<id>` and friends only
    // exist once React Router has loaded.
    const shell = await sizeOf(index);
    if (shell === null) throw new HTTPException(500, { message: "WEB_DIST has no index.html" });

    return send(c, index, shell, c.req.method === "HEAD", { "cache-control": "no-cache" });
  });

  return router;
}

function send(
  c: Context,
  file: string,
  size: number,
  headOnly: boolean,
  headers: Record<string, string>,
): Response {
  c.header("content-type", MIME[extname(file).toLowerCase()] ?? "application/octet-stream");
  c.header("content-length", String(size));
  for (const [name, value] of Object.entries(headers)) c.header(name, value);

  if (headOnly) return c.body(null, 200);
  return c.body(Readable.toWeb(createReadStream(file)) as ReadableStream);
}

/**
 * Resolves a request path to a file inside the root, or null.
 *
 * `resolve` collapses `..` before the check, so an encoded traversal is caught
 * here rather than by whatever the filesystem makes of it.
 */
function resolveWithin(root: string, path: string): string | null {
  if (path === "/") return null;
  const target = resolve(root, `.${path}`);
  return target === root || target.startsWith(root + sep) ? target : null;
}

/** Size of a regular file, or null if it is missing or is a directory. */
async function sizeOf(file: string): Promise<number | null> {
  try {
    const stats = await stat(file);
    return stats.isFile() ? stats.size : null;
  } catch {
    return null;
  }
}
