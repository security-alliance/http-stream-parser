import { describe, it, expect } from "vitest";
import { tryParseH2 } from "../h2.js";
import { tryParseHTTP11 } from "../h1.js";
import { parseMessages } from "../parser.js";
import { getMessageBody } from "../body.js";
import type { Chunk } from "../types.js";

// ---- H2 frame building helpers ----

const H2_PREFACE = Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");

function h2Frame(type: number, flags: number, streamId: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(9);
  header[0] = (payload.length >> 16) & 0xff;
  header[1] = (payload.length >> 8) & 0xff;
  header[2] = payload.length & 0xff;
  header[3] = type;
  header[4] = flags;
  header.writeUInt32BE(streamId & 0x7fffffff, 5);
  return Buffer.concat([header, payload]);
}

function settingsFrame(ack = false): Buffer {
  return h2Frame(0x4, ack ? 0x01 : 0x00, 0, Buffer.alloc(0));
}

// HPACK encode helpers (raw, no Huffman)
function hpackEncodeInteger(value: number, prefixBits: number, mask: number): Buffer {
  const maxPrefix = (1 << prefixBits) - 1;
  if (value < maxPrefix) return Buffer.from([mask | value]);
  const bytes = [mask | maxPrefix];
  value -= maxPrefix;
  while (value >= 128) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return Buffer.from(bytes);
}

function hpackString(str: string): Buffer {
  const buf = Buffer.from(str, "utf-8");
  return Buffer.concat([hpackEncodeInteger(buf.length, 7, 0x00), buf]);
}

function hpackIndexed(index: number): Buffer {
  return hpackEncodeInteger(index, 7, 0x80);
}

function hpackLiteral(nameIndex: number, value: string): Buffer {
  return Buffer.concat([hpackEncodeInteger(nameIndex, 6, 0x40), hpackString(value)]);
}

function hpackLiteralNewName(name: string, value: string): Buffer {
  return Buffer.concat([Buffer.from([0x40]), hpackString(name), hpackString(value)]);
}

function headersFrame(streamId: number, headerBlock: Buffer, endStream = false): Buffer {
  const flags = 0x04 | (endStream ? 0x01 : 0x00); // END_HEADERS | END_STREAM?
  return h2Frame(0x1, flags, streamId, headerBlock);
}

function dataFrame(streamId: number, payload: Buffer, endStream = false): Buffer {
  return h2Frame(0x0, endStream ? 0x01 : 0x00, streamId, payload);
}

// ---- Tests ----

describe("tryParseH2", () => {
  it("parses a simple GET request and 200 response", () => {
    // Client: preface + settings + HEADERS (GET / on stream 1, END_STREAM + END_HEADERS)
    const reqHeaders = Buffer.concat([
      hpackIndexed(2), // :method GET
      hpackIndexed(7), // :scheme https
      hpackIndexed(4), // :path /
      hpackLiteral(1, "example.com"), // :authority
    ]);

    const clientData = Buffer.concat([H2_PREFACE, settingsFrame(), headersFrame(1, reqHeaders, true)]);

    // Server: settings + HEADERS (200, END_HEADERS) + DATA (END_STREAM)
    const resHeaders = Buffer.concat([
      hpackIndexed(8), // :status 200
      hpackLiteral(31, "text/plain"), // content-type
    ]);
    const body = Buffer.from("hello world");

    const serverData = Buffer.concat([settingsFrame(), headersFrame(1, resHeaders, false), dataFrame(1, body, true)]);

    const chunks: Chunk[] = [
      [true, clientData],
      [false, serverData],
    ];

    const result = tryParseH2(chunks);
    expect(result).toBeDefined();

    const stream1 = result!.get(1)!;
    expect(stream1.request).toBeDefined();
    expect(stream1.response).toBeDefined();

    expect(stream1.request!.method).toBe("GET");
    expect(stream1.request!.path).toBe("/");
    expect(stream1.request!.authority).toBe("example.com");
    expect(stream1.request!.scheme).toBe("https");

    expect(stream1.response!.status).toBe(200);
    expect(stream1.response!.body.toString()).toBe("hello world");
    expect(stream1.response!.headers.get("content-type")).toBe("text/plain");
  });

  it("returns undefined for non-H2 data", () => {
    const chunks: Chunk[] = [[true, Buffer.from("GET / HTTP/1.1\r\n\r\n")]];
    expect(tryParseH2(chunks)).toBeUndefined();
  });

  it("handles interleaved chunks from client and server", () => {
    const reqHeaders = Buffer.concat([hpackIndexed(2), hpackIndexed(7), hpackLiteral(4, "/api"), hpackLiteral(1, "api.test")]);

    const resHeaders = Buffer.concat([hpackIndexed(8)]);
    const body = Buffer.from("ok");

    const chunks: Chunk[] = [
      [true, H2_PREFACE],
      [true, settingsFrame()],
      [false, settingsFrame()],
      [true, headersFrame(1, reqHeaders, true)],
      [false, headersFrame(1, resHeaders, false)],
      [false, dataFrame(1, body, true)],
    ];

    const result = tryParseH2(chunks);
    expect(result).toBeDefined();

    const stream1 = result!.get(1)!;
    expect(stream1.request).toBeDefined();

    expect(stream1.request!.path).toBe("/api");
    expect(stream1.request!.authority).toBe("api.test");
  });
});

describe("tryParseHTTP11", () => {
  it("parses a simple request/response pair", () => {
    const request = Buffer.from("GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n");
    const response = Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello");

    const chunks: Chunk[] = [
      [true, request],
      [false, response],
    ];

    const result = tryParseHTTP11(chunks);
    expect(result).toBeDefined();
    expect(result).toHaveLength(1);

    const [req, res] = result![0];
    expect(req.type).toBe("request");
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/");
    expect(req.authority).toBe("example.com");

    expect(res!.type).toBe("response");
    expect(res!.status).toBe(200);
    expect(res!.body.toString()).toBe("hello");
  });

  it("parses multiple request/response pairs (pipelining)", () => {
    const req1 = "GET /a HTTP/1.1\r\nHost: example.com\r\n\r\n";
    const req2 = "GET /b HTTP/1.1\r\nHost: example.com\r\n\r\n";
    const res1 = "HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\na";
    const res2 = "HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\nb";

    const chunks: Chunk[] = [
      [true, Buffer.from(req1 + req2)],
      [false, Buffer.from(res1 + res2)],
    ];

    const result = tryParseHTTP11(chunks);
    expect(result).toBeDefined();
    expect(result).toHaveLength(2);

    expect(result![0][0].path).toBe("/a");
    expect(result![0][1]!.body.toString()).toBe("a");
    expect(result![1][0].path).toBe("/b");
    expect(result![1][1]!.body.toString()).toBe("b");
  });

  it("returns empty array for garbage data", () => {
    const chunks: Chunk[] = [[true, Buffer.from([0xff, 0xfe, 0xfd])]];
    expect(tryParseHTTP11(chunks)).toEqual([]);
  });
});

describe("parseMessages", () => {
  it("routes H2 traffic through H2 parser", () => {
    const reqHeaders = Buffer.concat([hpackIndexed(2), hpackIndexed(7), hpackIndexed(4), hpackLiteral(1, "example.com")]);
    const resHeaders = Buffer.concat([hpackIndexed(8)]);

    const chunks: Chunk[] = [
      [true, Buffer.concat([H2_PREFACE, settingsFrame(), headersFrame(1, reqHeaders, true)])],
      [false, Buffer.concat([settingsFrame(), headersFrame(1, resHeaders, false), dataFrame(1, Buffer.from("ok"), true)])],
    ];

    const messages = parseMessages(chunks);
    expect(messages).toHaveLength(1);
    expect(messages[0][0].type).toBe("request");
    expect(messages[0][1].type).toBe("response");
  });

  it("routes H1 traffic through H1 parser", () => {
    const chunks: Chunk[] = [
      [true, Buffer.from("GET / HTTP/1.1\r\nHost: example.com\r\n\r\n")],
      [false, Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")],
    ];

    const messages = parseMessages(chunks);
    expect(messages).toHaveLength(1);
    expect(messages[0][0].authority).toBe("example.com");
    expect(messages[0][1].body.toString()).toBe("ok");
  });
});

describe("getMessageBody", () => {
  it("returns plain text body", () => {
    const body = getMessageBody({
      type: "response",
      status: 200,
      statusMessage: "OK",
      headers: new Headers(),
      body: Buffer.from("hello"),
    }).toString("utf-8");
    expect(body).toBe("hello");
  });

  it("decompresses gzip body", () => {
    const zlib = require("node:zlib");
    const compressed = zlib.gzipSync(Buffer.from("compressed"));
    const body = getMessageBody({
      type: "response",
      status: 200,
      statusMessage: "OK",
      headers: new Headers({ "content-encoding": "gzip" }),
      body: compressed,
    }).toString("utf-8");
    expect(body).toBe("compressed");
  });

  it("decompresses brotli body", () => {
    const zlib = require("node:zlib");
    const compressed = zlib.brotliCompressSync(Buffer.from("brotli-test"));
    const body = getMessageBody({
      type: "response",
      status: 200,
      statusMessage: "OK",
      headers: new Headers({ "content-encoding": "br" }),
      body: compressed,
    }).toString("utf-8");
    expect(body).toBe("brotli-test");
  });

  it("throws on unsupported encoding", () => {
    expect(() =>
      getMessageBody({
        type: "response",
        status: 200,
        statusMessage: "OK",
        headers: new Headers({ "content-encoding": "lz4" }),
        body: Buffer.from("data"),
      }).toString("utf-8"),
    ).toThrow("unsupported encoding lz4");
  });
});
