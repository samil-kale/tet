/** Repository-relative, forward-slashed paths as the views show them. */

/** The last segment of a repository-relative path. */
export function baseName(entryPath: string): string {
  return entryPath.slice(entryPath.lastIndexOf("/") + 1);
}

/** "" at the root. */
export function parentOf(entryPath: string): string {
  const index = entryPath.lastIndexOf("/");
  return index === -1 ? "" : entryPath.slice(0, index);
}

/** A file name's extension with its dot, "" for none: path.extname's rule, which git.ts's
 *  ignorePath applies, so a dotfile has none. */
export function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index) : "";
}
