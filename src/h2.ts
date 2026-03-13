import { HPACKDecoder, type HeaderField } from "./hpack.js";
import type { Chunk, HTTPRequest, HTTPResponse, ParseLimits } from "./types.js";
import { DEFAULT_LIMITS } from "./types.js";

interface Frame {
  type: number;
  flags: number;
  streamId: number;
  payload: Buffer;
}

interface Stream {
  id: number;
  headers: HeaderField[] | null;
  headerBuffers: Buffer[];
  headerBlockSize: number;
  bodyBuffers: Buffer[];
  bodySize: number;
  complete: boolean;
  processed: boolean;
  reset: boolean;
}

interface Connection {
  buffers: Buffer[];
  bufferBytes: number;
  streams: Map<number, Stream>;
  prefixParsed: boolean;
  headerTableSize: number;
  hpack: HPACKDecoder | null;
  /** Stream ID whose headerBuffers should receive CONTINUATION fragments. */
  pendingHeaderTarget: number | null;
}

export type H2Stream = {
  request: HTTPRequest | undefined;
  response: HTTPResponse | undefined;
};

const enum FrameType {
  DATA = 0x0,
  HEADERS = 0x1,
  PRIORITY = 0x2,
  RST_STREAM = 0x3,
  SETTINGS = 0x4,
  PUSH_PROMISE = 0x5,
  PING = 0x6,
  GOAWAY = 0x7,
  WINDOW_UPDATE = 0x8,
  CONTINUATION = 0x9,
}

const enum FrameFlag {
  END_STREAM = 0x01,
  ACK = 0x01,
  END_HEADERS = 0x04,
  PADDED = 0x08,
  PRIORITY = 0x20,
}

const H2_PREFACE = "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";

function createConnection(isServer: boolean): Connection {
  return {
    buffers: [],
    bufferBytes: 0,
    streams: new Map(),
    prefixParsed: isServer,
    headerTableSize: 4096,
    hpack: null,
    pendingHeaderTarget: null,
  };
}

/** Flatten pending buffers into a single buffer only when needed for parsing. */
function flattenBuffer(conn: Connection): Buffer {
  if (conn.buffers.length === 0) return Buffer.alloc(0);
  if (conn.buffers.length === 1) return conn.buffers[0];
  const flat = Buffer.concat(conn.buffers);
  conn.buffers = [flat];
  return flat;
}

function consumeBuffer(conn: Connection, bytes: number): void {
  const flat = flattenBuffer(conn);
  if (bytes >= flat.length) {
    conn.buffers = [];
    conn.bufferBytes = 0;
  } else {
    conn.buffers = [flat.subarray(bytes)];
    conn.bufferBytes -= bytes;
  }
}

function parseFrame(conn: Connection, limits: Required<ParseLimits>): Frame | null {
  if (conn.bufferBytes < 9) return null;

  const buf = flattenBuffer(conn);
  const length = (buf[0] << 16) | (buf[1] << 8) | buf[2];
  const type = buf[3];
  const flags = buf[4];
  const streamId = buf.readUInt32BE(5) & 0x7fffffff;

  if (length > limits.maxFramePayloadSize) {
    throw new Error(`Frame payload size ${length} exceeds limit ${limits.maxFramePayloadSize}`);
  }

  if (conn.bufferBytes < 9 + length) return null;

  const payload = Buffer.from(buf.subarray(9, 9 + length));
  consumeBuffer(conn, 9 + length);

  return { type, flags, streamId, payload };
}

function decodeHeaders(buffers: Buffer[], conn: Connection): HeaderField[] {
  if (!conn.hpack) {
    conn.hpack = new HPACKDecoder();
    if (conn.headerTableSize !== 4096) {
      conn.hpack.setMaxDynamicTableSize(conn.headerTableSize);
    }
  }
  return conn.hpack.decode(buffers);
}

function getOrCreateStream(conn: Connection, streamId: number, limits: Required<ParseLimits>): Stream {
  let stream = conn.streams.get(streamId);
  if (!stream) {
    if (conn.streams.size >= limits.maxStreams) {
      throw new Error(`Stream count exceeds limit ${limits.maxStreams}`);
    }
    stream = {
      id: streamId,
      headers: null,
      bodyBuffers: [],
      bodySize: 0,
      headerBuffers: [],
      headerBlockSize: 0,
      complete: false,
      processed: false,
      reset: false,
    };
    conn.streams.set(streamId, stream);
  }
  return stream;
}

function addHeaderFragment(stream: Stream, fragment: Buffer, limits: Required<ParseLimits>): void {
  stream.headerBlockSize += fragment.length;
  if (stream.headerBlockSize > limits.maxHeaderBlockSize) {
    throw new Error(`Header block size exceeds limit ${limits.maxHeaderBlockSize}`);
  }
  stream.headerBuffers.push(fragment);
}

function addBodyData(stream: Stream, data: Buffer, limits: Required<ParseLimits>): void {
  stream.bodySize += data.length;
  if (stream.bodySize > limits.maxBodySize) {
    throw new Error(`Body size exceeds limit ${limits.maxBodySize}`);
  }
  stream.bodyBuffers.push(data);
}

function finalizeHeaders(stream: Stream, conn: Connection): void {
  const decoded = decodeHeaders(stream.headerBuffers, conn);
  stream.headerBuffers = [];
  stream.headerBlockSize = 0;

  if (stream.headers === null) {
    stream.headers = decoded;
  }
  // Trailing headers are intentionally ignored — the initial
  // pseudo-headers (:method, :path, etc.) are what we need.
}

function stripPadding(payload: Buffer): Buffer {
  const paddingLength = payload.readUint8(0);
  return payload.subarray(1, payload.length - paddingLength);
}

function buildMessage(stream: Stream, fromClient: boolean): HTTPRequest | HTTPResponse | null {
  if (!stream.headers || stream.reset) return null;

  const pseudo: Record<string, string> = {};
  const headers = new Headers();
  for (const { name, value } of stream.headers) {
    if (name.startsWith(":")) {
      pseudo[name] = value;
    } else {
      headers.append(name, value);
    }
  }

  if (fromClient) {
    if (!pseudo[":method"] || !pseudo[":path"]) return null;
    return {
      type: "request",
      method: pseudo[":method"],
      path: pseudo[":path"],
      authority: pseudo[":authority"] ?? "",
      scheme: pseudo[":scheme"] ?? "https",
      headers,
      body: Buffer.concat(stream.bodyBuffers),
    };
  } else {
    if (!pseudo[":status"]) return null;
    return {
      type: "response",
      status: parseInt(pseudo[":status"]),
      statusMessage: "",
      headers,
      body: Buffer.concat(stream.bodyBuffers),
    };
  }
}

function processFrame(
  frame: Frame,
  source: Connection,
  fromClient: boolean,
  results: Map<number, H2Stream>,
  limits: Required<ParseLimits>,
): void {
  // Connection-level frames (stream 0) don't belong in per-stream results.
  if (frame.streamId === 0) {
    switch (frame.type) {
      case FrameType.SETTINGS: {
        if (frame.flags & FrameFlag.ACK) return;
        for (let i = 0; i < frame.payload.length; i += 6) {
          const id = frame.payload.readUInt16BE(i);
          const value = frame.payload.readUInt32BE(i + 2);
          if (id === 0x1) {
            const clamped = Math.min(value, limits.maxHeaderTableSize);
            source.headerTableSize = clamped;
            if (source.hpack) {
              source.hpack.setMaxDynamicTableSize(clamped);
            }
          }
        }
        break;
      }
      case FrameType.PING:
      case FrameType.GOAWAY:
      case FrameType.WINDOW_UPDATE:
        break;
    }
    return;
  }

  const stream = getOrCreateStream(source, frame.streamId, limits);
  if (!results.has(stream.id)) {
    results.set(stream.id, { request: undefined, response: undefined });
  }

  switch (frame.type) {
    case FrameType.DATA: {
      let payload = frame.payload;
      if (frame.flags & FrameFlag.PADDED) {
        payload = stripPadding(payload);
      }
      addBodyData(stream, payload, limits);
      if (frame.flags & FrameFlag.END_STREAM) {
        stream.complete = true;
      }
      break;
    }
    case FrameType.HEADERS: {
      let payload = frame.payload;
      if (frame.flags & FrameFlag.PADDED) {
        payload = stripPadding(payload);
      }
      if (frame.flags & FrameFlag.PRIORITY) {
        payload = payload.subarray(5);
      }

      addHeaderFragment(stream, payload, limits);

      if (frame.flags & FrameFlag.END_HEADERS) {
        finalizeHeaders(stream, source);
      } else {
        source.pendingHeaderTarget = stream.id;
      }

      if (frame.flags & FrameFlag.END_STREAM) {
        stream.complete = true;
      }
      break;
    }
    case FrameType.PRIORITY:
      break;
    case FrameType.RST_STREAM: {
      stream.reset = true;
      break;
    }
    case FrameType.PUSH_PROMISE: {
      let payload = frame.payload;
      if (frame.flags & FrameFlag.PADDED) {
        payload = stripPadding(payload);
      }

      const promisedStreamId = payload.readUInt32BE(0) & 0x7fffffff;
      const headerBlock = payload.subarray(4);

      const promisedStream = getOrCreateStream(source, promisedStreamId, limits);
      addHeaderFragment(promisedStream, headerBlock, limits);

      if (frame.flags & FrameFlag.END_HEADERS) {
        finalizeHeaders(promisedStream, source);
      } else {
        source.pendingHeaderTarget = promisedStreamId;
      }
      break;
    }
    case FrameType.CONTINUATION: {
      const targetId = source.pendingHeaderTarget ?? frame.streamId;
      const targetStream = getOrCreateStream(source, targetId, limits);
      addHeaderFragment(targetStream, frame.payload, limits);

      if (frame.flags & FrameFlag.END_HEADERS) {
        finalizeHeaders(targetStream, source);
        source.pendingHeaderTarget = null;
      }
      break;
    }
  }

  if (stream.complete && !stream.processed) {
    stream.processed = true;
    const message = buildMessage(stream, fromClient);
    if (message) {
      const result = results.get(stream.id)!;
      if (message.type === "request") {
        result.request = message;
      } else {
        result.response = message;
      }
    }
  }
}

export function tryParseH2(chunks: Chunk[], limits?: ParseLimits): Map<number, H2Stream> | undefined {
  const resolved = { ...DEFAULT_LIMITS, ...limits };
  const results = new Map<number, H2Stream>();

  const clientConn = createConnection(false);
  const serverConn = createConnection(true);

  for (const [fromClient, buffer] of chunks) {
    const source = fromClient ? clientConn : serverConn;

    source.buffers.push(buffer);
    source.bufferBytes += buffer.length;

    if (fromClient && !source.prefixParsed && source.bufferBytes >= 24) {
      const flat = flattenBuffer(source);
      if (flat.subarray(0, 24).toString() !== H2_PREFACE) {
        return undefined;
      }
      source.buffers = [flat.subarray(24)];
      source.bufferBytes -= 24;
      source.prefixParsed = true;
    }

    if (!source.prefixParsed) continue;

    while (source.bufferBytes >= 9) {
      const frame = parseFrame(source, resolved);
      if (!frame) break;

      processFrame(frame, source, fromClient, results, resolved);
    }
  }

  if (!clientConn.prefixParsed || !serverConn.prefixParsed) return undefined;

  return results;
}
