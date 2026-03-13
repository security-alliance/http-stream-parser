import { gunzipSync, inflateSync } from "fflate";
import { decompress as fzstdDecompress } from "fzstd";
import type { HTTPMessage } from "./types.js";

let brotliDecompressFn: ((data: Uint8Array) => Uint8Array) | undefined;

/**
 * Must be called once before using getMessageBody with brotli-encoded content.
 * Loads the brotli WASM module.
 */
export async function initDecompress(): Promise<void> {
  const brotli = await import("brotli-wasm");
  brotliDecompressFn = brotli.decompress;
}

/**
 * Browser-compatible version of getMessageBody.
 * Uses fflate for gzip/deflate, brotli-wasm for br, fzstd for zstd.
 */
export const getMessageBody = (
  msg: HTTPMessage,
  maxOutputLength = 100 * 1024 * 1024
): Buffer => {
  const { headers, body } = msg;
  const encoding = headers.get("content-encoding");

  if (!encoding) return body;

  if (encoding === "gzip") {
    return Buffer.from(gunzipSync(new Uint8Array(body)));
  }
  if (encoding === "deflate") {
    return Buffer.from(inflateSync(new Uint8Array(body)));
  }
  if (encoding === "br") {
    if (!brotliDecompressFn) {
      throw new Error(
        "Call initDecompress() before decompressing brotli content"
      );
    }
    return Buffer.from(brotliDecompressFn(new Uint8Array(body)));
  }
  if (encoding === "zstd") {
    return Buffer.from(fzstdDecompress(body));
  }

  throw new Error("unsupported encoding " + encoding);
};
