import * as assert from "node:assert/strict";
import * as os from "node:os";
import { describe, it } from "node:test";
import { askAgent } from "../src/main/agents/ask";
import { commitMessageFrom } from "../src/main/git/commit-message";

describe("a background agent question", () => {
  it("arrives on stdin and returns trimmed stdout", async () => {
    const script = [
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => input += chunk);",
      "process.stdin.on('end', () => process.stdout.write('  ' + input.toUpperCase() + '  '));"
    ].join(" ");
    assert.equal(await askAgent(os.tmpdir(), process.execPath, ["-e", script], "first\nsecond"), "FIRST\nSECOND");
  });
});

describe("a suggested commit message", () => {
  it("takes a plain subject unchanged", () => {
    assert.equal(commitMessageFrom("fix terminal focus"), "fix terminal focus");
  });

  it("tolerates a fence, label and wrapping quotes", () => {
    assert.equal(commitMessageFrom('```text\nCommit message: "add commit suggestions"\n```'), "add commit suggestions");
  });

  it("rejects an empty or fence-only answer", () => {
    assert.equal(commitMessageFrom("\n```\n```\n"), "");
  });
});
