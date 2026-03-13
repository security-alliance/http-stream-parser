import { tryParseHTTP11 } from "./h1.js";
import { tryParseH2 } from "./h2.js";
import type { Chunk, HTTPRequest, HTTPResponse, ParseLimits } from "./types.js";

export const parseMessages = (data: Chunk[], limits?: ParseLimits) => {
  const messages: [HTTPRequest, HTTPResponse][] = [];

  const h2Result = tryParseH2(data, limits);
  if (h2Result) {
    for (const stream of h2Result.values()) {
      if (!stream.request || !stream.response) continue;

      messages.push([stream.request, stream.response]);
    }
  } else {
    const h1Result = tryParseHTTP11(data, limits);
    if (h1Result === undefined) return [];

    for (const [req, res] of h1Result) {
      if (!res) continue;

      messages.push([req, res]);
    }
  }
  return messages;
};
