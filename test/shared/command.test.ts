import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatEnv, isSameCommand, parseEnv, splitWords } from "../../src/shared/command";

/** The one reading of a saved command line, shared by the dialog and the spawn. */

describe("splitWords", () => {
  it("splits on whitespace, quotes group a word, and a backslash is a character", () => {
    assert.deepEqual(splitWords("npm run build"), ["npm", "run", "build"]);
    assert.deepEqual(splitWords('  mvn   -q  "spring-boot:run"  '), ["mvn", "-q", "spring-boot:run"]);
    assert.deepEqual(splitWords(`echo "a b" 'c d'`), ["echo", "a b", "c d"]);
    assert.deepEqual(splitWords('C:\\tools\\run.exe --path "C:\\my dir"'), ["C:\\tools\\run.exe", "--path", "C:\\my dir"]);
    // A quote inside a word joins, the way a shell reads it; the other kind is literal inside.
    assert.deepEqual(splitWords(`say"it's"`), ["sayit's"]);
  });

  it("keeps an empty quoted argument, and an unclosed quote takes the rest of the line", () => {
    assert.deepEqual(splitWords('cmd "" x'), ["cmd", "", "x"]);
    assert.deepEqual(splitWords('cmd "unclosed rest'), ["cmd", "unclosed rest"]);
    assert.deepEqual(splitWords(""), []);
    assert.deepEqual(splitWords("   "), []);
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
  it("compares every field, the variables in any order", () => {
    const one = { command: "npm test", cwd: "web", env: { A: "1", B: "2" } };
    assert.ok(isSameCommand(one, { command: "npm test", cwd: "web", env: { B: "2", A: "1" } }));
    assert.ok(!isSameCommand(one, { command: "npm test", env: { A: "1", B: "2" } }), "another folder");
    assert.ok(!isSameCommand(one, { command: "npm test", cwd: "web", env: { A: "1" } }), "other variables");
    const full = { command: "x", name: "one", color: "red", cwd: "web", env: { A: "1" }, os: "win32" } as const;
    assert.ok(isSameCommand(full, { ...full, env: { A: "1" } }));
  });

  it("tells apart rows that differ only in name, color or platform", () => {
    assert.ok(!isSameCommand({ command: "npm test" }, { command: "npm test", name: "Tests" }), "a name");
    assert.ok(!isSameCommand({ command: "x", name: "one" }, { command: "x", name: "two" }), "another name");
    assert.ok(!isSameCommand({ command: "x" }, { command: "x", color: "red" }), "a color");
    assert.ok(!isSameCommand({ command: "x", color: "red" }, { command: "x", color: "blue" }), "another color");
    assert.ok(!isSameCommand({ command: "x" }, { command: "x", os: "win32" }), "one platform's");
  });
});
