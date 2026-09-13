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
