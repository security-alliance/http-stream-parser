/** A bidirectional TCP stream chunk: [fromClient, data]. */
export type Chunk = readonly [boolean, Buffer];

export interface HTTPRequest {
  type: "request";
  method: string;
  path: string;
  authority: string;
  scheme: string;
  headers: Headers;
  body: Buffer;
}

export interface HTTPResponse {
  type: "response";
  status: number;
  statusMessage: string;
  headers: Headers;
  body: Buffer;
}

export type HTTPMessage = HTTPRequest | HTTPResponse;

export interface ParseLimits {
  /** Max body size per message in bytes. Default: 100MB */
  maxBodySize?: number;
  /** Max header block size in bytes (sum of all header fragments). Default: 1MB */
  maxHeaderBlockSize?: number;
  /** Max number of streams. Default: 10,000 */
  maxStreams?: number;
  /** Max frame payload size in bytes. Default: 16,384 (RFC 7540 default) */
  maxFramePayloadSize?: number;
  /** Max HPACK dynamic table size in bytes. Default: 65,536 */
  maxHeaderTableSize?: number;
}

export const DEFAULT_LIMITS: Required<ParseLimits> = {
  maxBodySize: 100 * 1024 * 1024,
  maxHeaderBlockSize: 1024 * 1024,
  maxStreams: 10_000,
  maxFramePayloadSize: 16_384,
  maxHeaderTableSize: 65_536,
};
