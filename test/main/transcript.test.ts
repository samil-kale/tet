import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { AgentSessionInfo } from "../../src/main/agents/agent";
import {
  collectSessions,
  findEncodedDir,
  forgetMissing,
  listTranscriptDir,
  nonEmptyString,
  parseLine,
  readHeadLines,
  requireTitle,
  scanTranscriptHead,
  scanTranscriptTail,
  timestampOf,
  TRANSCRIPT_SCAN_BYTES,
  truncateTitle,
  watchTranscriptDir,
} from "../../src/main/agents/transcript";
import { PLATFORM } from "../../src/main/util/host-platform";
import { eventually, tempDir } from "../helpers";

/** agents/transcript.ts: the reading every agent's JSONL transcripts share. */

const session = (id: string, createdAt: number): AgentSessionInfo => ({ id, title: id, updatedAt: createdAt, createdAt });

describe("the directory of an agent that keeps one per repository", () => {
  it("is found by its encoded name, ignoring case only where the platform's paths do", async () => {
    const root = tempDir("tet-transcript-root-");
    fs.mkdirSync(path.join(root, "-Users-Me-Repo"));
    assert.equal(await findEncodedDir(root, "-Users-Me-Repo"), path.join(root, "-Users-Me-Repo"));
    assert.equal(await findEncodedDir(root, "-Users-me-repo"), PLATFORM.pathsIgnoreCase ? path.join(root, "-Users-Me-Repo") : undefined);
    assert.equal(await findEncodedDir(root, "-elsewhere"), undefined);
  });

  it("is none for a root that is not there, and a failure for one that cannot be read", async () => {
    assert.equal(await findEncodedDir(path.join(tempDir("tet-transcript-root-"), "missing"), "x"), undefined);
    const file = path.join(tempDir("tet-transcript-root-"), "file");
    fs.writeFileSync(file, "");
    await assert.rejects(findEncodedDir(file, "x"));
  });
});

describe("a listing of sessions", () => {
  it("is oldest first, without what is no session, and empty with a log line when it fails", async () => {
    const sessions = await collectSessions("test", () => Promise.resolve([session("b", 2), undefined, session("a", 1), session("c", 3)]));
    assert.deepEqual(
      sessions.map((entry) => entry.id),
      ["a", "b", "c"],
    );
    assert.deepEqual(await collectSessions("test", () => Promise.reject(new Error("unreadable"))), []);
  });

  it("hands every transcript of the directory to its reader, evicting what left the directory from the caches", async () => {
    const dir = tempDir("tet-transcript-dir-");
    fs.writeFileSync(path.join(dir, "one.jsonl"), "");
    fs.writeFileSync(path.join(dir, "two.jsonl"), "");
    fs.writeFileSync(path.join(dir, "notes.txt"), "");
    const cache = new Map<string, unknown>([
      [path.join(dir, "one.jsonl"), 1],
      [path.join(dir, "gone.jsonl"), 2],
      [path.join(tempDir("tet-transcript-other-"), "other.jsonl"), 3],
    ]);
    const read: string[] = [];
    const sessions = await listTranscriptDir(
      () => Promise.resolve(dir),
      [cache],
      "test",
      (filePath, file) => {
        read.push(file);
        return Promise.resolve(session(path.basename(filePath, ".jsonl"), file === "one.jsonl" ? 1 : 2));
      },
    );
    assert.deepEqual(read.sort(), ["one.jsonl", "two.jsonl"]);
    assert.deepEqual(
      sessions.map((entry) => entry.id),
      ["one", "two"],
    );
    assert.equal(cache.has(path.join(dir, "gone.jsonl")), false);
    assert.equal(cache.size, 2, "another folder's entries are left alone");
  });

  it("has no sessions where there is no directory", async () => {
    assert.deepEqual(
      await listTranscriptDir(
        () => Promise.resolve(undefined),
        [],
        "test",
        () => Promise.reject(new Error("never")),
      ),
      [],
    );
  });

  it("forgets only what lies under the root and is no longer present", () => {
    const cache = new Map<string, unknown>([
      [`${path.sep}a${path.sep}b${path.sep}x.jsonl`, 1],
      [`${path.sep}a${path.sep}b${path.sep}y.jsonl`, 2],
      [`${path.sep}a${path.sep}bc${path.sep}z.jsonl`, 3],
    ]);
    forgetMissing(`${path.sep}a${path.sep}b`, [`${path.sep}a${path.sep}b${path.sep}x.jsonl`], [cache]);
    assert.deepEqual([...cache.values()], [1, 3], "a root that merely starts alike is another root");
  });
});

describe("what a transcript's fields are held to", () => {
  it("counts a title only as a non-blank string", () => {
    assert.equal(nonEmptyString("title"), "title");
    for (const value of ["", "   ", 3, null, undefined, {}]) {
      assert.equal(nonEmptyString(value), undefined);
    }
  });

  it("reads an entry only where it is a JSON object, such as not a half-written last line", () => {
    assert.deepEqual(parseLine('{"type":"user"}'), { type: "user" });
    for (const line of ['{"type":"us', "[1]", "3", "null", ""]) {
      assert.equal(parseLine(line), undefined, line);
    }
  });

  it("reads a timestamp as ms where it parses", () => {
    assert.equal(timestampOf("2024-05-01T10:00:00.000Z"), Date.parse("2024-05-01T10:00:00.000Z"));
    for (const value of ["", "yesterday", 5, undefined]) {
      assert.equal(timestampOf(value), undefined);
    }
  });

  it("requires a title that is not blank, and trims it", () => {
    assert.equal(requireTitle("  My session "), "My session");
    assert.throws(() => requireTitle("   "), /non-empty/);
  });

  it("keeps a title to what the tab strip has room for, in one line", () => {
    assert.equal(truncateTitle("  fix\n\tthe   bug "), "fix the bug");
    const long = truncateTitle("x".repeat(100));
    assert.equal(long.length, 60);
    assert.ok(long.endsWith("…"));
    assert.equal(truncateTitle("y".repeat(60)), "y".repeat(60));
  });
});

describe("a transcript's head", () => {
  const file = (lines: string[]): string => {
    const target = path.join(tempDir("tet-transcript-head-"), "t.jsonl");
    fs.writeFileSync(target, lines.join("\n"));
    return target;
  };

  it("is read from the start until the reader wants nothing more", async () => {
    const seen: string[] = [];
    assert.equal(
      await readHeadLines(file(["a", "b", "c"]), "test", (line) => {
        seen.push(line);
        return line === "b";
      }),
      true,
    );
    assert.deepEqual(seen, ["a", "b"]);
  });

  it("answers false for a file that cannot be read", async () => {
    assert.equal(await readHeadLines(path.join(tempDir("tet-transcript-head-"), "missing.jsonl"), "test", () => false), false);
  });

  it("is scanned again only once the file filled more of the window, and a failed read is never kept", async () => {
    const target = file(["one"]);
    const cache = new Map<string, { size: number; head: { lines: string[] } }>();
    const scan = {
      label: "test",
      create: () => ({ lines: [] as string[] }),
      read: (line: string, head: { lines: string[] }) => !!head.lines.push(line) && false,
    };
    const first = await scanTranscriptHead(target, fs.statSync(target).size, cache, scan);
    assert.deepEqual(first.lines, ["one"]);
    assert.equal(await scanTranscriptHead(target, fs.statSync(target).size, cache, scan), first, "answered from the cache");

    fs.appendFileSync(target, "\ntwo");
    const grown = await scanTranscriptHead(target, fs.statSync(target).size, cache, scan);
    assert.deepEqual(grown.lines, ["one", "two"]);

    const missing = path.join(path.dirname(target), "missing.jsonl");
    await scanTranscriptHead(missing, 10, cache, scan);
    assert.equal(cache.has(missing), false);
  });
});

describe("a transcript's tail", () => {
  interface Tail {
    lines: string[];
  }
  const scanOf = (stopAfter = Infinity) => ({
    label: "test",
    create: (): Tail => ({ lines: [] }),
    read: (lines: string[], tail: Tail): boolean => {
      tail.lines.push(...lines.filter(Boolean).reverse());
      return tail.lines.length >= stopAfter;
    },
    merge: (tail: Tail, previous: Tail): void => {
      tail.lines.push(...previous.lines);
    },
  });
  const file = (content: string): string => {
    const target = path.join(tempDir("tet-transcript-tail-"), "t.jsonl");
    fs.writeFileSync(target, content);
    return target;
  };

  it("is read last line first, and stops where the reader wants nothing further", async () => {
    const target = file("one\ntwo\nthree\n");
    const { tail, size } = await scanTranscriptTail(target, new Map(), scanOf());
    assert.deepEqual(tail.lines, ["three", "two", "one"]);
    assert.equal(size, fs.statSync(target).size);
    assert.deepEqual((await scanTranscriptTail(target, new Map(), scanOf(1))).tail.lines.slice(0, 1), ["three"]);
  });

  it("hands lines over whole across the chunks it reads in, a multi-byte character cut by one included", async () => {
    const lines = Array.from({ length: 6 }, (_, index) => `${String(index)}-${"ä".repeat(TRANSCRIPT_SCAN_BYTES / 4)}`);
    const target = file(`${lines.join("\n")}\n`);
    const { tail } = await scanTranscriptTail(target, new Map(), scanOf());
    assert.deepEqual(tail.lines, [...lines].reverse());
  });

  it("answers an unchanged file from the cache, and a grown one by what is new merged with the old", async () => {
    const target = file("one\ntwo\n");
    const cache = new Map<string, { size: number; tail: Tail }>();
    const first = await scanTranscriptTail(target, cache, scanOf());
    assert.equal((await scanTranscriptTail(target, cache, scanOf())).tail, first.tail, "the same answer, not read again");

    fs.appendFileSync(target, "three\n");
    const grown = await scanTranscriptTail(target, cache, scanOf());
    // The scan starts a chunk below the old end, so the file's whole text is in the new read; the old answer is merged after it.
    assert.deepEqual(grown.tail.lines.slice(0, 3), ["three", "two", "one"]);
    assert.equal(cache.get(target)?.size, fs.statSync(target).size);
  });

  it("rejects for a file that cannot be opened", async () => {
    await assert.rejects(scanTranscriptTail(path.join(tempDir("tet-transcript-tail-"), "missing.jsonl"), new Map(), scanOf()));
  });
});

describe("the watch of a transcript directory", () => {
  it("reports a transcript written, not a file the agent does not keep, and stops when told", async () => {
    const root = tempDir("tet-transcript-watch-");
    const dir = path.join(root, "encoded");
    fs.mkdirSync(dir);
    let changes = 0;
    const watch = watchTranscriptDir(
      () => root,
      () => Promise.resolve(dir),
      (name) => name.endsWith(".jsonl"),
      () => changes++,
    );
    try {
      await eventually("the directory is watched", () => watch.watching(), 5000);
      fs.writeFileSync(path.join(dir, "notes.txt"), "x");
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(changes, 0);
      fs.writeFileSync(path.join(dir, "s1.jsonl"), "{}\n");
      await eventually("a change is reported", () => changes > 0, 5000);
    } finally {
      watch.stop();
    }
    assert.equal(watch.watching(), false);
    const reported = changes;
    fs.writeFileSync(path.join(dir, "s2.jsonl"), "{}\n");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(changes, reported, "nothing is reported after stop");
  });

  it("waits on the root while the directory is missing, then reports the transcript that made it", async () => {
    const root = tempDir("tet-transcript-watch-");
    const dir = path.join(root, "encoded");
    let changes = 0;
    const watch = watchTranscriptDir(
      () => root,
      () => Promise.resolve(fs.existsSync(dir) ? dir : undefined),
      (name) => name.endsWith(".jsonl"),
      () => changes++,
    );
    try {
      await eventually("the root is watched", () => watch.watching(), 5000);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "first.jsonl"), "{}\n");
      await eventually("the first transcript is reported", () => changes > 0, 5000);
    } finally {
      watch.stop();
    }
  });
});
