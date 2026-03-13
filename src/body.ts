import { decompress } from "fzstd";
import zlib from "node:zlib";
import type { HTTPMessage } from "./types.js";

export const getMessageBody = (msg: HTTPMessage, maxOutputLength = 1024 * 1024 * 100): Buffer => {
  const { headers, body } = msg;

  let buf: Buffer;
  const encoding = headers.get("content-encoding");
  if (!encoding) {
    buf = body;
  } else if (encoding === "gzip") {
    buf = zlib.gunzipSync(body, { maxOutputLength: maxOutputLength });
  } else if (encoding === "deflate") {
    buf = zlib.inflateSync(body, { maxOutputLength: maxOutputLength });
  } else if (encoding === "br") {
    buf = zlib.brotliDecompressSync(body, { maxOutputLength: maxOutputLength });
  } else if (encoding === "zstd") {
    buf = Buffer.from(decompress(body));
  } else {
    throw new Error("unsupported encoding " + encoding);
  }

  return buf;
};
