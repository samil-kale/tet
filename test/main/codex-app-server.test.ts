import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { listModels, renameThread } from "../../src/main/agents/codex/app-server-client";
import { PLATFORM } from "../../src/main/util/host-platform";
import { eventually, processAlive, tempDir } from "../helpers";

/** agents/codex/app-server-client.ts: the JSON-RPC conversation with `codex app-server`, against a stand-in. */

interface Behavior {
  /** Every request answers with this JSON-RPC error. */
  error?: string;
  /** Exits at once with this on stderr, before saying anything. */
  exitEarly?: string;
}

/** A stand-in `codex` on PATH speaking app-server's JSONL; its requests and lifetime are logged. */
async function withCodex<T>(behavior: Behavior, action: (executable: string) => Promise<T>): Promise<{ result: T; log: string[] }> {
  const dir = tempDir("tet-codex-app-server-");
  const log = path.join(dir, "log.jsonl");
  const script = path.join(dir, "codex-stub.js");
  fs.writeFileSync(
    script,
    `const fs = require("node:fs");
const readline = require("node:readline");
const behavior = ${JSON.stringify(behavior)};
const log = (entry) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(entry) + "\\n");
log({ open: process.argv.slice(2), pid: process.pid });
if (behavior.exitEarly) {
  process.stderr.write(behavior.exitEarly);
  process.exit(3);
}
const reply = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
// What a server says unasked: a notification, and a line that is no JSON.
process.stdout.write("not json at all\\n");
reply({ method: "thread/started", params: {} });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  log({ method: request.method, params: request.params });
  setTimeout(() => {
    if (request.method === "initialize") {
      reply({ id: request.id, result: {} });
    } else if (behavior.error) {
      reply({ id: request.id, error: { message: behavior.error } });
    } else if (request.method === "model/list") {
      const first = request.params.cursor === undefined || request.params.cursor === null;
      reply({
        id: request.id,
        result: first
          ? { data: [{ model: "gpt-a", displayName: "GPT A" }, { model: "gpt-b" }, { model: 5 }], nextCursor: "c2" }
          : { data: [{ model: "gpt-c", displayName: "C" }] },
      });
    } else {
      reply({ id: request.id, result: {} });
    }
  }, 20);
});
`,
  );
  const name = "codex-stub";
  if (PLATFORM.executableByExtension) {
    fs.writeFileSync(path.join(dir, `${name}.cmd`), `@ECHO off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  }
  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
  try {
    const result = await action(name);
    return { result, log: await settledLog(log) };
  } finally {
    process.env.PATH = originalPath;
  }
}

/** The stand-in's log once every server it started is gone: the kill is asked for before it is done. */
async function settledLog(file: string): Promise<string[]> {
  const lines = (): string[] => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split(/\r?\n/) : []);
  const pids = (): number[] => lines().flatMap((line) => (JSON.parse(line) as { pid?: number }).pid ?? []);
  await eventually("the servers are stopped", () => pids().every((pid) => !processAlive(pid)), 10_000);
  return lines();
}

describe("codex app-server's models", () => {
  it("lists the models its picker offers, page by page, labelled by display name where it has one", async () => {
    const { result, log } = await withCodex({}, (executable) => listModels(executable, process.cwd()));
    assert.deepEqual(result, [
      { id: "gpt-a", label: "GPT A" },
      { id: "gpt-b", label: "gpt-b" },
      { id: "gpt-c", label: "C" },
    ]);
    const methods = log.flatMap((line) => (JSON.parse(line) as { method?: string }).method ?? []);
    assert.deepEqual(methods, ["initialize", "model/list", "initialize", "model/list"], "a server of its own per page, initialized first");
    assert.deepEqual(
      log.filter((line) => line.startsWith('{"open"')).map((line) => (JSON.parse(line) as { open: string[] }).open),
      [
        ["app-server", "--stdio"],
        ["app-server", "--stdio"],
      ],
    );
  });
});

describe("codex app-server's requests", () => {
  it("renames a thread by its id, and leaves no server running after", async () => {
    const { log } = await withCodex({}, (executable) => renameThread(executable, process.cwd(), "thread-1", "New name"));
    const requests = log.map((line) => JSON.parse(line) as { method?: string; params?: unknown });
    assert.deepEqual(requests.find((entry) => entry.method === "thread/name/set")?.params, { threadId: "thread-1", name: "New name" });
  });

  it("rejects with the server's own message for an error reply", async () => {
    await withCodex({ error: "no such thread" }, async (executable) => {
      await assert.rejects(renameThread(executable, process.cwd(), "missing", "x"), /no such thread/);
    });
  });

  it("rejects with what a server that exited early said", async () => {
    await withCodex({ exitEarly: "database is locked" }, async (executable) => {
      await assert.rejects(listModels(executable, process.cwd()), /exited \(3\): database is locked/);
    });
  });

  it("rejects where the executable cannot be started", async () => {
    await assert.rejects(listModels(path.join(tempDir("tet-codex-missing-"), "codex"), process.cwd()));
  });

  it("serves one request at a time across callers: the cold start races when two begin together", async () => {
    const { log } = await withCodex({}, (executable) =>
      Promise.all([renameThread(executable, process.cwd(), "a", "A"), renameThread(executable, process.cwd(), "b", "B")]),
    );
    const steps = log.map((line) => {
      const entry = JSON.parse(line) as { open?: unknown; method?: string };
      return entry.open ? "open" : entry.method;
    });
    assert.deepEqual(steps, ["open", "initialize", "thread/name/set", "open", "initialize", "thread/name/set"]);
  });
});
