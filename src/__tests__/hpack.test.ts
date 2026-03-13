import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { HPACKDecoder } from "../hpack.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "hpack-test-case");

interface TestCase {
  seqno: number;
  wire: string;
  headers: Record<string, string>[];
}

interface TestStory {
  cases: TestCase[];
  description: string;
}

function loadStory(impl: string, story: string): TestStory {
  const path = join(fixturesDir, impl, story);
  return JSON.parse(readFileSync(path, "utf-8"));
}

function listStories(impl: string): string[] {
  return readdirSync(join(fixturesDir, impl))
    .filter((f) => f.endsWith(".json"))
    .sort();
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function expectedHeaders(headers: Record<string, string>[]) {
  return headers.map((h) => {
    const [name, value] = Object.entries(h)[0];
    return { name, value };
  });
}

/**
 * Run a full story: decode each case sequentially with the same decoder
 * (simulating a connection where dynamic table state accumulates).
 */
function runStory(story: TestStory) {
  const decoder = new HPACKDecoder();
  for (const tc of story.cases) {
    const wire = hexToBytes(tc.wire);
    const decoded = decoder.decode([wire]);
    expect(decoded).toEqual(expectedHeaders(tc.headers));
  }
}

// nghttp2: uses static table + Huffman encoding + dynamic table
describe("nghttp2 fixtures (Huffman + static/dynamic table)", () => {
  for (const story of listStories("nghttp2")) {
    it(story, () => runStory(loadStory("nghttp2", story)));
  }
});

// haskell-http2-linear: uses static table + dynamic table, no Huffman
describe("haskell-http2-linear fixtures (no Huffman)", () => {
  for (const story of listStories("haskell-http2-linear")) {
    it(story, () => runStory(loadStory("haskell-http2-linear", story)));
  }
});

// nghttp2-change-table-size: tests dynamic table size updates
describe("nghttp2-change-table-size fixtures", () => {
  for (const story of listStories("nghttp2-change-table-size")) {
    it(story, () => runStory(loadStory("nghttp2-change-table-size", story)));
  }
});
