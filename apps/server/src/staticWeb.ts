import { createReadStream, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

export interface WebAsset {
  file: string;
  contentType: string;
  immutable: boolean;
}

function inside(root: string, file: string): boolean {
  const base = resolve(root);
  return file === base || file.startsWith(base + sep);
}

/** Resolve a URL path to a file under the built Web root, or null. */
export function resolveWebAsset(root: string, urlPath: string): WebAsset | null {
  let pathname: string;
  try {
    pathname = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  } catch {
    return null;
  }
  if (pathname.includes("\0")) return null;
  if (pathname === "/") pathname = "/index.html";
  const file = resolve(root, "." + pathname);
  if (!inside(root, file)) return null;
  try {
    if (!statSync(file).isFile()) return null;
  } catch {
    return null;
  }
  return {
    file,
    contentType: CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    immutable: pathname.startsWith("/assets/"),
  };
}

/** SPA fallback to index.html for browser routes; never for API/WS paths. */
export function spaFallback(root: string): WebAsset | null {
  return resolveWebAsset(root, "/index.html");
}

export function sendWebAsset(reply: import("fastify").FastifyReply, asset: WebAsset): unknown {
  reply.header("content-type", asset.contentType);
  reply.header("x-content-type-options", "nosniff");
  reply.header(
    "cache-control",
    asset.immutable ? "public, max-age=31536000, immutable" : "no-cache",
  );
  return reply.send(createReadStream(asset.file));
}
