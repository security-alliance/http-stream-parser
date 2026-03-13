# @security-alliance/http-stream-parser

Parse HTTP/1.1 and HTTP/2 messages from bidirectional TCP stream chunks.

## Install

```bash
npm install @security-alliance/http-stream-parser
```

## Usage

```ts
import { parseMessages, getMessageBody } from "@security-alliance/http-stream-parser";

// chunks: [fromClient, data][] — raw TCP stream data
const messages = parseMessages(chunks);

for (const [request, response] of messages) {
  console.log(request.method, request.path);
  console.log(response.status);

  const body = getMessageBody(response);
  console.log(body.toString());
}
```

### Browser

A browser-compatible entry point is available that uses WASM-based decompression instead of Node.js `zlib`:

```ts
import { parseMessages, getMessageBody, initDecompress } from "@security-alliance/http-stream-parser/browser";

// Must be called once before decompressing brotli content
await initDecompress();

const messages = parseMessages(chunks);
const body = getMessageBody(messages[0][1]);
```

## Features

- Parses both HTTP/1.1 and HTTP/2 from raw TCP stream chunks
- Automatic protocol detection (HTTP/2 connection preface vs HTTP/1.1)
- Full HPACK header decompression for HTTP/2
- Body decompression: gzip, deflate, brotli, zstd
- Configurable limits for body size, header size, streams, and frame payload size
- Browser-compatible entry point (`/browser`) using WASM-based decompression

## API

### `parseMessages(chunks, limits?)`

Parse TCP stream chunks into paired HTTP request/response tuples.

- `chunks` — `[fromClient: boolean, data: Buffer][]`
- `limits` — optional `ParseLimits` to cap resource usage

Returns `[HTTPRequest, HTTPResponse][]`.

### `getMessageBody(message, maxOutputLength?)`

Decompress and return the body of an HTTP message, respecting `Content-Encoding`.

### `initDecompress()` (browser entry point only)

Initialize the WASM brotli decompression module. Must be called before decompressing brotli-encoded content.

## License

MIT
