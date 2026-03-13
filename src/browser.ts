export { parseMessages } from "./parser.js";
export { tryParseHTTP11 } from "./h1.js";
export { tryParseH2, type H2Stream } from "./h2.js";
export { HPACKDecoder, type HeaderField } from "./hpack.js";
export { DEFAULT_LIMITS } from "./types.js";
export type {
  Chunk,
  HTTPRequest,
  HTTPResponse,
  HTTPMessage,
  ParseLimits,
} from "./types.js";

// Browser-compatible getMessageBody + init
export { getMessageBody, initDecompress } from "./decompress-browser.js";
