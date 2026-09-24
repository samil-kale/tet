import * as fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

/**
 * Fetches `url` into `file`, continuing what an earlier call left there: a quit or a dropped
 * connection keeps the part, and the next call asks only for the rest (`Range`; GitHub's release
 * downloads answer 206, measured). A server sending the whole file anyway (200) overwrites the
 * part. What is appended is not checked against the part: a mismatch makes an archive the unpack
 * refuses, and the caller deletes it.
 */
export async function resumableDownload(url: string, file: string, signal: AbortSignal): Promise<void> {
  const have = await fs.promises.stat(file).then(
    (stat) => stat.size,
    () => 0
  );
  const response = await fetch(url, { headers: have > 0 ? { Range: `bytes=${have}-` } : {}, signal });
  // Asked for what follows a complete file.
  if (response.status === 416) {
    await response.body?.cancel();
    return;
  }
  if (!response.ok || !response.body) {
    throw new Error(`download answered ${response.status}`);
  }
  const resumed = response.status === 206;
  if (resumed && !response.headers.get("content-range")?.startsWith(`bytes ${have}-`)) {
    await response.body.cancel();
    await fs.promises.rm(file, { force: true });
    throw new Error(`download answered ${response.headers.get("content-range")} for bytes ${have}-`);
  }
  await pipeline(Readable.fromWeb(response.body as WebReadableStream), fs.createWriteStream(file, { flags: resumed ? "a" : "w" }));
}
