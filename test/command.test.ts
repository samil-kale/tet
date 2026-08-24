import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatEnv, isSameCommand, parseEnv, splitCommand } from "../src/shared/command";

/** The one reading of a saved command line, shared by the dialog and the spawn. */

describe("splitCommand", () => {
  it("splits on whitespace, quotes group a word, and a backslash is a character", () => {
    assert.deepEqual(splitCommand("npm run build"), ["npm", "run", "build"]);
    assert.deepEqual(splitCommand('  mvn   -q  "spring-boot:run"  '), ["mvn", "-q", "spring-boot:run"]);
    assert.deepEqual(splitCommand(`echo "a b" 'c d'`), ["echo", "a b", "c d"]);
    assert.deepEqual(splitCommand('C:\\tools\\run.exe --path "C:\\my dir"'), [
      "C:\\tools\\run.exe",
      "--path",
      "C:\\my dir"
    ]);
    // A quote inside a word joins, the way a shell reads it; the other kind is literal inside.
    assert.deepEqual(splitCommand(`say"it's"`), ["sayit's"]);
  });

  it("keeps an empty quoted argument, and an unclosed quote takes the rest of the line", () => {
    assert.deepEqual(splitCommand('cmd "" x'), ["cmd", "", "x"]);
    assert.deepEqual(splitCommand('cmd "unclosed rest'), ["cmd", "unclosed rest"]);
    assert.deepEqual(splitCommand(""), []);
    assert.deepEqual(splitCommand("   "), []);
  });

  it("leaves shell operators as words of their own, for the caller to refuse", () => {
    assert.deepEqual(splitCommand("a && b | c > out 2>&1"), ["a", "&&", "b", "|", "c", ">", "out", "2>&1"]);
    // Not an operator: one that is part of an argument.
    assert.deepEqual(splitCommand("grep -e a>b"), ["grep", "-e", "a>b"]);
  });
});

describe("parseEnv and formatEnv", () => {
  it("read and write the dialog's one field the same way", () => {
    assert.deepEqual(parseEnv('A=1 B="a b" C=x=y'), { A: "1", B: "a b", C: "x=y" });
    assert.equal(parseEnv("nothing here =empty"), undefined, "a word without a name is not a variable");
    assert.equal(parseEnv(""), undefined);
    assert.equal(formatEnv(undefined), "");
    assert.equal(formatEnv({ A: "1", B: "a b" }), 'A=1 B="a b"');
    assert.equal(formatEnv({ Q: 'say "hi"' }), `Q='say "hi"'`, "the other quote kind around one holding quotes");
  });

  it("round-trip whatever can be written", () => {
    const env = { PROFILE: "dev", PATH_EXTRA: "C:\\a b\\c", NAME: "it's" };
    assert.deepEqual(parseEnv(formatEnv(env)), env);
  });
});

describe("isSameCommand", () => {
  it("compares the line, the folder and the variables, the variables in any order", () => {
    const one = { command: "npm test", cwd: "web", env: { A: "1", B: "2" } };
    assert.ok(isSameCommand(one, { command: "npm test", cwd: "web", env: { B: "2", A: "1" } }));
    assert.ok(!isSameCommand(one, { command: "npm test", env: { A: "1", B: "2" } }), "another folder");
    assert.ok(!isSameCommand(one, { command: "npm test", cwd: "web", env: { A: "1" } }), "other variables");
    assert.ok(isSameCommand({ command: "x", name: "one" }, { command: "x", name: "two" }), "a name is a label");
  });
});
