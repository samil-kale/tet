import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchHttpsImage } from "../../src/main/ipc/shell";

/** ipc/: what the handlers do beyond passing on. */

/**
 * A Markdown preview's images are fetched in main so the page's CSP keeps them off the network.
 * A followed redirect is a fetch of its own, so each hop is checked like the first.
 */
describe("a Markdown preview's image fetch", () => {
  /** Answers the chain in `hops`, then "200 ok"; records what was asked for. */
  const server = (hops: Record<string, string>) => {
    const asked: string[] = [];
    const fetchFn = (url: string): Promise<Response> => {
      asked.push(url);
      const location = hops[url];
      return Promise.resolve(
        location === undefined
          ? new Response("image bytes", { status: 200, headers: { "content-type": "image/png" } })
          : new Response(null, { status: 302, headers: { location } })
      );
    };
    return { asked, fetchFn };
  };

  it("follows an https redirect chain to the image", async () => {
    const { asked, fetchFn } = server({
      "https://a.example/badge.svg": "https://b.example/real.png"
    });
    const response = await fetchHttpsImage("https://a.example/badge.svg", fetchFn);
    assert.equal(response?.status, 200);
    assert.deepEqual(asked, ["https://a.example/badge.svg", "https://b.example/real.png"]);
  });

  it("resolves a relative location against the hop that sent it", async () => {
    const { asked, fetchFn } = server({ "https://a.example/x/badge.svg": "../y/real.png" });
    assert.equal((await fetchHttpsImage("https://a.example/x/badge.svg", fetchFn))?.status, 200);
    assert.deepEqual(asked, ["https://a.example/x/badge.svg", "https://a.example/y/real.png"]);
  });

  it("stops where a redirect leaves https, without sending that request", async () => {
    // What the fetch-in-main was meant to prevent: a README's image reaching the machine's network,
    // the disk, or the page's own scheme.
    const targets = [
      "http://192.168.1.1/admin",
      "http://localhost:9200/_cat",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<script>x</script>",
      // No URL at all — neither followed nor thrown out of the handler.
      "http://[",
      "//"
    ];
    for (const target of targets) {
      const { asked, fetchFn } = server({ "https://a.example/badge.svg": target });
      assert.equal(await fetchHttpsImage("https://a.example/badge.svg", fetchFn), undefined, target);
      assert.deepEqual(asked, ["https://a.example/badge.svg"], `${target} was never requested`);
    }
  });

  it("refuses a first hop that is not https, without sending anything", async () => {
    for (const url of ["http://a.example/x.png", "file:///x.png", "not a url"]) {
      const { asked, fetchFn } = server({});
      assert.equal(await fetchHttpsImage(url, fetchFn), undefined, url);
      assert.deepEqual(asked, [], url);
    }
  });

  it("gives up on a redirect loop", async () => {
    const { asked, fetchFn } = server({
      "https://a.example/1": "https://a.example/2",
      "https://a.example/2": "https://a.example/1"
    });
    assert.equal(await fetchHttpsImage("https://a.example/1", fetchFn), undefined);
    assert.ok(asked.length <= 7, `stopped after ${asked.length} hops`);
  });
});
