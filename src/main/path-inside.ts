import * as path from "node:path";

/**
 * `target` relative to `root` when strictly below it, else undefined (`root` itself too). Only a
 * whole `..` segment escapes (`..env` is inside); another win32 drive comes back absolute: outside.
 */
export function relativeInside(root: string, target: string): string | undefined {
  const relative = path.relative(root, target);
  const escapes = relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  return relative === "" || escapes ? undefined : relative;
}
