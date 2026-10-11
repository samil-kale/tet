import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { ROOT } from "../helpers";

/** src/shared holds only what two processes use (AGENTS.md, "Where things live"): a file one process
 *  alone reaches, directly or through another shared file, belongs in that process. */

const SRC = path.join(ROOT, "src");

function sourcesIn(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true, recursive: true }).flatMap((entry) => {
    const file = path.join(entry.parentPath, entry.name);
    return entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [file] : [];
  });
}

/** The file a relative import names, or undefined for a package or a type-only module. */
function resolveImport(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  const base = path.resolve(path.dirname(from), specifier).replace(/\.[jt]sx?$/, "");
  return [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")].find((candidate) => fs.existsSync(candidate));
}

function importsOf(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  const specifiers = [
    ...text.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gms),
    ...text.matchAll(/^\s*import\s+["']([^"']+)["']/gm),
  ];
  return specifiers.flatMap((match) => resolveImport(file, match[1]) ?? []);
}

describe("src/shared", () => {
  it("holds only files that two processes reach", () => {
    const sharedRoot = path.join(SRC, "shared") + path.sep;
    const reached = new Map<string, Set<string>>();
    for (const process of fs.readdirSync(SRC).filter((name) => name !== "shared")) {
      const pending = sourcesIn(path.join(SRC, process));
      const seen = new Set(pending);
      for (const file of pending) {
        for (const imported of importsOf(file)) {
          if (imported.startsWith(sharedRoot) && !seen.has(imported)) {
            seen.add(imported);
            pending.push(imported);
          }
        }
      }
      for (const file of seen) {
        if (file.startsWith(sharedRoot)) {
          reached.set(file, (reached.get(file) ?? new Set()).add(process));
        }
      }
    }
    const single = sourcesIn(path.join(SRC, "shared"))
      .filter((file) => (reached.get(file)?.size ?? 0) < 2)
      .map(
        (file) => `${path.relative(ROOT, file).split(path.sep).join("/")}: ${[...(reached.get(file) ?? [])].join(", ") || "no process"}`,
      );
    assert.deepEqual(single, []);
  });
});
