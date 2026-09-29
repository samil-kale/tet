import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { describe, it } from "node:test";
import { resumableDownload } from "../../src/main/update/resumable-download";
import { tempDir } from "../helpers";

/** update/: the download of a new version. */

describe("an update's download, continued after it was cut short", () => {
  const BODY = Buffer.from(Array.from({ length: 512 * 1024 }, (_, i) => i % 251));

  /**
   * Serves BODY and records each request's Range. `cutAt`: the first response stops there and the
   * connection drops; `ignoreRange`: always the whole file; `wrongStart`: a 206 from byte 0.
   */
  async function releaseServer(mode: { cutAt?: number; ignoreRange?: boolean; wrongStart?: boolean }) {
    const ranges: (string | undefined)[] = [];
    const server = http.createServer((request, response) => {
      ranges.push(request.headers.range);
      const asked = mode.ignoreRange ? undefined : /^bytes=(\d+)-$/.exec(request.headers.range ?? "")?.[1];
      if (asked !== undefined && Number(asked) >= BODY.length) {
        response.writeHead(416, { "Content-Range": `bytes */${BODY.length}` });
        response.end();
      } else if (asked !== undefined) {
        const start = mode.wrongStart ? 0 : Number(asked);
        response.writeHead(206, { "Content-Range": `bytes ${start}-${BODY.length - 1}/${BODY.length}`, "Content-Length": BODY.length - start });
        response.end(BODY.subarray(start));
      } else if (mode.cutAt !== undefined) {
        response.writeHead(200, { "Content-Length": BODY.length });
        response.write(BODY.subarray(0, mode.cutAt));
        mode.cutAt = undefined;
        // Long enough for the part to reach the disk.
        setTimeout(() => response.destroy(), 300);
      } else {
        response.writeHead(200, { "Content-Length": BODY.length });
        response.end(BODY);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    return { url: `http://127.0.0.1:${port}/TET.zip`, ranges, close: () => server.close() };
  }

  const archive = (): string => path.join(tempDir("tet-download-test-"), "TET.zip");
  const signal = (): AbortSignal => AbortSignal.timeout(10_000);
  const ignore = (): void => undefined;

  it("fetches the whole file when there is no part", async () => {
    const server = await releaseServer({});
    try {
      const file = archive();
      await resumableDownload(server.url, file, signal(), ignore, fetch);
      assert.deepEqual(fs.readFileSync(file), BODY);
      assert.deepEqual(server.ranges, [undefined]);
    } finally {
      server.close();
    }
  });

  it("keeps the part of a dropped connection and asks only for the rest", async () => {
    const server = await releaseServer({ cutAt: 200 * 1024 });
    try {
      const file = archive();
      await assert.rejects(resumableDownload(server.url, file, signal(), ignore, fetch));
      const part = fs.statSync(file).size;
      assert.ok(part > 0 && part <= 200 * 1024, `part of ${part} bytes`);
      const fractions: number[] = [];
      await resumableDownload(server.url, file, signal(), (fraction) => fractions.push(fraction), fetch);
      assert.deepEqual(fs.readFileSync(file), BODY);
      assert.deepEqual(server.ranges, [undefined, `bytes=${part}-`]);
      // Counted from the part on, not from zero.
      assert.ok(fractions[0] > part / BODY.length, `first fraction ${fractions[0]}`);
      assert.equal(fractions.at(-1), 1);
    } finally {
      server.close();
    }
  });

  it("overwrites the part when the server sends the whole file", async () => {
    const server = await releaseServer({ ignoreRange: true });
    try {
      const file = archive();
      fs.writeFileSync(file, BODY.subarray(0, 1000));
      await resumableDownload(server.url, file, signal(), ignore, fetch);
      assert.deepEqual(fs.readFileSync(file), BODY);
      assert.deepEqual(server.ranges, ["bytes=1000-"]);
    } finally {
      server.close();
    }
  });

  it("leaves a complete file as it is", async () => {
    const server = await releaseServer({});
    try {
      const file = archive();
      fs.writeFileSync(file, BODY);
      await resumableDownload(server.url, file, signal(), ignore, fetch);
      assert.deepEqual(fs.readFileSync(file), BODY);
    } finally {
      server.close();
    }
  });

  it("drops the part when the server answers another range", async () => {
    const server = await releaseServer({ wrongStart: true });
    try {
      const file = archive();
      fs.writeFileSync(file, BODY.subarray(0, 1000));
      await assert.rejects(resumableDownload(server.url, file, signal(), ignore, fetch), /bytes 0-/);
      assert.equal(fs.existsSync(file), false);
    } finally {
      server.close();
    }
  });
});
