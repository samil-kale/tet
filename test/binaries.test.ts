import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { crc32 } from "node:zlib";
import { ROOT } from "./helpers";

/** Every tracked binary file is intact: a tool that treats one as text (line endings normalized,
 *  bytes re-encoded) breaks it without a trace in the diff, so each format's own checksums and
 *  lengths are checked, and a binary of a format no check knows fails until one is added. */

/** What is wrong with the file's bytes, or undefined. */
type Check = (bytes: Buffer) => string | undefined;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function checkPng(bytes: Buffer): string | undefined {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return "no PNG signature";
  }
  let at = 8;
  while (at + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(at);
    const end = at + 12 + length;
    if (end > bytes.length) {
      return `chunk at ${at} runs past the end`;
    }
    const type = bytes.toString("latin1", at + 4, at + 8);
    if (crc32(bytes.subarray(at + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) {
      return `${type} chunk at ${at} fails its CRC`;
    }
    at = end;
    if (type === "IEND") {
      return at === bytes.length ? undefined : "data after IEND";
    }
  }
  return "no IEND chunk";
}

function checkIco(bytes: Buffer): string | undefined {
  if (bytes.length < 6 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) {
    return "no ICO header";
  }
  const count = bytes.readUInt16LE(4);
  let last = 6 + count * 16;
  for (let index = 0; index < count; index++) {
    const entry = 6 + index * 16;
    const size = bytes.readUInt32LE(entry + 8);
    const offset = bytes.readUInt32LE(entry + 12);
    if (offset + size > bytes.length) {
      return `image ${index} runs past the end`;
    }
    const image = bytes.subarray(offset, offset + size);
    const problem = image.subarray(0, 8).equals(PNG_SIGNATURE) ? checkPng(image) : undefined;
    if (problem) {
      return `image ${index}: ${problem}`;
    }
    last = Math.max(last, offset + size);
  }
  return last === bytes.length ? undefined : "data after the last image";
}

function checkWoff(bytes: Buffer): string | undefined {
  if (bytes.toString("latin1", 0, 4) !== "wOFF") {
    return "no wOFF signature";
  }
  if (bytes.readUInt32BE(8) !== bytes.length) {
    return `the header says ${bytes.readUInt32BE(8)} bytes, the file has ${bytes.length}`;
  }
  for (let index = 0; index < bytes.readUInt16BE(12); index++) {
    const entry = 44 + index * 20;
    if (bytes.readUInt32BE(entry + 4) + bytes.readUInt32BE(entry + 8) > bytes.length) {
      return `table ${bytes.toString("latin1", entry, entry + 4)} runs past the end`;
    }
  }
  return undefined;
}

function checkWoff2(bytes: Buffer): string | undefined {
  if (bytes.toString("latin1", 0, 4) !== "wOF2") {
    return "no wOF2 signature";
  }
  return bytes.readUInt32BE(8) === bytes.length
    ? undefined
    : `the header says ${bytes.readUInt32BE(8)} bytes, the file has ${bytes.length}`;
}

/** The sum of a block's 32-bit big-endian words, zero-padded to a whole word. */
function wordSum(bytes: Buffer, from: number, length: number): number {
  let sum = 0;
  for (let at = from; at < from + length; at += 4) {
    let word = 0;
    for (let byte = 0; byte < 4; byte++) {
      word = word * 256 + (at + byte < from + length ? bytes[at + byte] : 0);
    }
    sum = (sum + word) % 2 ** 32;
  }
  return sum;
}

/** The sfnt checksums: each table's own, and the whole file's against `head.checkSumAdjustment`. */
function checkTrueType(bytes: Buffer): string | undefined {
  for (let index = 0; index < bytes.readUInt16BE(4); index++) {
    const entry = 12 + index * 16;
    const tag = bytes.toString("latin1", entry, entry + 4);
    const offset = bytes.readUInt32BE(entry + 8);
    const length = bytes.readUInt32BE(entry + 12);
    if (offset + length > bytes.length) {
      return `table ${tag} runs past the end`;
    }
    const table = Buffer.from(bytes.subarray(offset, offset + length));
    if (tag === "head") {
      table.writeUInt32BE(0, 8);
    }
    if (wordSum(table, 0, length) !== bytes.readUInt32BE(entry + 4)) {
      return `table ${tag} fails its checksum`;
    }
  }
  return wordSum(bytes, 0, bytes.length) === 0xb1b0afba ? undefined : "the file fails its checksum";
}

/** The GIF's blocks, each chain of data sub-blocks by its own lengths, up to the trailer at the end. */
function checkGif(bytes: Buffer): string | undefined {
  if (!/^GIF8[79]a/.test(bytes.toString("latin1", 0, 6))) {
    return "no GIF signature";
  }
  const colorTable = (packed: number): number => (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0);
  const subBlocks = (from: number): number => {
    let at = from;
    while (at < bytes.length && bytes[at] !== 0) {
      at += bytes[at] + 1;
    }
    return at + 1;
  };
  let at = 13 + colorTable(bytes[10]);
  while (at < bytes.length) {
    const block = bytes[at];
    if (block === 0x3b) {
      return at === bytes.length - 1 ? undefined : "data after the GIF trailer";
    }
    if (block === 0x21) {
      at = subBlocks(at + 2);
    } else if (block === 0x2c) {
      at = subBlocks(at + 10 + colorTable(bytes[at + 9]) + 1);
    } else {
      return `unknown block ${block} at ${at}`;
    }
  }
  return "no GIF trailer";
}

const CHECKS: Record<string, Check> = {
  ".png": checkPng,
  ".ico": checkIco,
  ".woff": checkWoff,
  ".woff2": checkWoff2,
  ".ttf": checkTrueType,
  ".gif": checkGif,
};

/** Text has no NUL byte; the first 8000 are what git looks at too. */
const isBinary = (bytes: Buffer): boolean => bytes.subarray(0, 8000).includes(0);

function trackedBinaries(): string[] {
  const run = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout
    .split("\0")
    .filter((file) => file !== "" && fs.existsSync(path.join(ROOT, file)))
    .filter((file) => isBinary(fs.readFileSync(path.join(ROOT, file))));
}

const BINARIES = trackedBinaries();

/** Line endings normalized, as a tool treating the file as text would leave it. */
const withoutCarriageReturns = (bytes: Buffer): Buffer => Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1");

describe("the tracked binary files", () => {
  it("are found", () => {
    assert.ok(BINARIES.length > 0, "no binary file found: git ls-files or the NUL test is off");
  });

  for (const file of BINARIES) {
    const bytes = fs.readFileSync(path.join(ROOT, file));
    const check = CHECKS[path.extname(file).toLowerCase()];

    it(`${file} is intact`, () => {
      assert.ok(check, `no integrity check for ${path.extname(file) || file}: add one to test/binaries.test.ts`);
      assert.equal(check(bytes), undefined);
    });

    // The check must see what it is there for.
    if (check && bytes.includes("\r\n")) {
      it(`${file}'s check notices normalized line endings`, () => {
        assert.notEqual(check(withoutCarriageReturns(bytes)), undefined);
      });
    }
  }
});
