import { HTTPParser } from "http-parser-js";
import type { Chunk, HTTPRequest, HTTPResponse, ParseLimits } from "./types.js";
import { DEFAULT_LIMITS } from "./types.js";

type MessageForType = {
  [HTTPParser.REQUEST]: HTTPRequest;
  [HTTPParser.RESPONSE]: HTTPResponse;
};

function parseMessages<T extends keyof MessageForType>(type: T, inputs: Buffer[], limits: Required<ParseLimits>): MessageForType[T][] {
  const messages: MessageForType[T][] = [];
  const bodyChunks: Buffer[] = [];
  let bodySize = 0;

  const parser = new HTTPParser(type);
  parser[HTTPParser.kOnHeaders] = function () {};
  parser[HTTPParser.kOnHeadersComplete] = function (req) {
    const headers = new Headers();
    for (let i = 0; i < req.headers.length; i += 2) {
      headers.append(req.headers[i], req.headers[i + 1]);
    }
    if (type === HTTPParser.REQUEST) {
      messages.push({
        type: "request",
        authority: headers.get("host") ?? "",
        method: HTTPParser.methods[req.method],
        headers,
        scheme: "https",
        path: req.url,
        body: Buffer.alloc(0),
      } as MessageForType[T]);
    } else {
      messages.push({
        type: "response",
        status: req.statusCode,
        statusMessage: req.statusMessage,
        headers,
        body: Buffer.alloc(0),
      } as MessageForType[T]);
    }
  };
  parser[HTTPParser.kOnBody] = function (chunk, offset, length) {
    bodySize += length;
    if (bodySize > limits.maxBodySize) {
      throw new Error(`Body size exceeds limit ${limits.maxBodySize}`);
    }
    bodyChunks.push(chunk.subarray(offset, offset + length));
  };
  parser[HTTPParser.kOnMessageComplete] = function () {
    messages[messages.length - 1].body = Buffer.concat(bodyChunks);
    bodyChunks.length = 0;
    bodySize = 0;
  };

  for (const input of inputs) parser.execute(input);
  parser.finish();

  return messages;
}

export function tryParseHTTP11(chunks: Chunk[], limits?: ParseLimits): [HTTPRequest, HTTPResponse | undefined][] | undefined {
  const resolved = { ...DEFAULT_LIMITS, ...limits };
  try {
    const requests = parseMessages(
      HTTPParser.REQUEST,
      chunks.filter((v) => v[0]).map((v) => v[1]),
      resolved,
    );
    const responses = parseMessages(
      HTTPParser.RESPONSE,
      chunks.filter((v) => !v[0]).map((v) => v[1]),
      resolved,
    );
    return requests.map((req, i) => [req, responses[i]]);
  } catch {
    return undefined;
  }
}
