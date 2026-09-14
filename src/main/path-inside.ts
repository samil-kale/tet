import * as path from "node:path";

/**
 * `target` relative to `root` when it lies strictly below it, else undefined — `root` itself
 * included. Only a whole `..` segment leaves the root: a name that merely starts with two dots
 * (`..env`) is inside. A target on another win32 drive comes back absolute, which is outside too.
 */
export function relativeInside(root: string, target: string): string | undefined {
  const relative = path.relative(root, target);
  const escapes = relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  return relative === "" || escapes ? undefined : relative;
}
