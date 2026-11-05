import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { ROOT } from "../helpers";

/** ipc/: what the handlers do beyond passing on, and that every channel has one. */

/**
 * The compiler holds a handler to its channel's types, but cannot tell one is missing: that channel
 * only fails once the window calls it.
 */
describe("the channels of shared/ipc.ts", () => {
  const mainSources = fs
    .readdirSync(path.join(ROOT, "src", "main"), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8"))
    .join("\n");
  const channels = fs.readFileSync(path.join(ROOT, "src", "shared", "ipc.ts"), "utf8");

  const declaredIn = (name: string): string[] => {
    const body = new RegExp(`export interface ${name} \\{(.*?)\\n\\}`, "s").exec(channels)?.[1] ?? "";
    return [...body.matchAll(/^\s*"([^"]+)":/gm)].map((match) => match[1]);
  };
  const registeredBy = (...wrappers: string[]): Set<string> =>
    new Set([...mainSources.matchAll(new RegExp(`\\b(?:${wrappers.join("|")})\\(\\s*"([^"]+)"`, "g"))].map((match) => match[1]));
  const unhandled = (declared: string[], registered: Set<string>): string[] => declared.filter((channel) => !registered.has(channel));

  it("each have a handler where the window asks", () => {
    const declared = declaredIn("InvokeChannels");
    assert.ok(declared.length > 0, "InvokeChannels was read");
    assert.deepEqual(unhandled(declared, registeredBy("handle")), []);
  });

  it("each have a listener where the window sends", () => {
    const declared = declaredIn("SendChannels");
    assert.ok(declared.length > 0, "SendChannels was read");
    assert.deepEqual(unhandled(declared, registeredBy("on", "once")), []);
  });
});
