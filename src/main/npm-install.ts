import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Where an `npm install -g` put tet, read off the package's own path: `<prefix>/node_modules/<pkg>`
 * on win32, `<prefix>/lib/node_modules/<pkg>` elsewhere. The update installs into the same prefix,
 * so a `--prefix` install stays where it was. Undefined for anything that is not such an install —
 * a checkout, or pnpm, yarn and bun, whose global layouts differ and which the update leaves to
 * the user (pi's self-update tells them apart the same way, by path).
 */
export function installPrefix(packageDir: string, platform: string = process.platform): string | undefined {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const parts = packageDir.split(/[\\/]/).map((part) => part.toLowerCase());
  if (parts.some((part) => part === ".pnpm" || part === "pnpm" || part === ".yarn" || part === "yarn" || part === ".bun")) {
    return undefined;
  }
  const modules = paths.dirname(packageDir);
  if (paths.basename(modules) !== "node_modules") {
    return undefined;
  }
  const above = paths.dirname(modules);
  if (platform === "win32") {
    return above;
  }
  return paths.basename(above) === "lib" ? paths.dirname(above) : undefined;
}

/** Whether the update can write where tet is installed, without asking for more rights. */
export function isWritable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** `x.y.z` against `x.y.z`, numerically. A prerelease or otherwise odd version is never newer. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (version: string) => (/^\d+\.\d+\.\d+$/.test(version) ? version.split(".").map(Number) : undefined);
  const next = parse(candidate);
  const now = parse(current);
  if (!next || !now) {
    return false;
  }
  for (let i = 0; i < 3; i++) {
    if (next[i] !== now[i]) {
      return next[i] > now[i];
    }
  }
  return false;
}
