import * as fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { net } from "electron";

/** What `resumableDownload` sends its request with; `net.fetch` in the app, a stand-in in the tests. */
type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

/**
 * Fetches `url` into `file`, continuing what an earlier call left there: a quit or a dropped
 * connection keeps the part, and the next call asks only for the rest (`Range`). A server sending
 * the whole file anyway (200) overwrites the part. What is appended is not checked against the
 * part: a mismatch makes an archive the unpack refuses, and the caller deletes it.
 */
export async function resumableDownload(url: string, file: string, signal: AbortSignal, fetchFn: FetchLike = net.fetch): Promise<void> {
  const have = await fs.promises.stat(file).then(
    (stat) => stat.size,
    () => 0
  );
  const response = await fetchFn(url, { headers: have > 0 ? { Range: `bytes=${have}-` } : {}, signal });
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
