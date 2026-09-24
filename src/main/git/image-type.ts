import * as path from "node:path";

/** Shown as images instead of "binary file". SVG stays text on purpose. */
const IMAGE_TYPES: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp"
};

function imageType(filePath: string): string | undefined {
  return IMAGE_TYPES[path.extname(filePath).slice(1).toLowerCase()];
}

/** Tells an image from any other binary, for HEAD's side (git.ts) and the working tree's
 *  (Repository.readFile) alike. Its own module: repository.ts runs in the main process, git.ts in
 *  the git one, and neither should pull in the other for two functions. */
export function isImage(filePath: string): boolean {
  return imageType(filePath) !== undefined;
}

/** One version of an image, or undefined for an empty file. No size cap of its own: both callers
 *  already apply the editor's, and a second number would go stale. */
export function toDataUrl(filePath: string, content: Buffer): string | undefined {
  return content.length > 0 ? `data:${imageType(filePath)};base64,${content.toString("base64")}` : undefined;
}
