import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { apiUrl, sendApi, type ApiEndpoints } from "../../src/main/providers/api-request";
import { endpoints as gitHubEndpoints, github } from "../../src/main/providers/github";
import { endpoints as gitLabEndpoints, gitlab } from "../../src/main/providers/gitlab";
import { ApiError } from "../../src/main/providers/provider";
import type { FetchLike } from "../../src/main/util/image-response";

const GITLAB: ApiEndpoints = { rest: "https://gitlab.example.com/api/v4", graphql: "https://gitlab.example.com/api/graphql" };

const SMALL: ApiEndpoints = { rest: "https://h/api", graphql: "https://h/graphql" };

const REPO = "group%2Fsub%2Fname";

/** A fetcher answering the responses in turn, and keeping what it was asked. */
function fetcherOf(...responses: Response[]): { fetcher: FetchLike; asked: { url: string; init: Parameters<FetchLike>[1] }[] } {
  const asked: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  const fetcher: FetchLike = (url, init) => {
    asked.push({ url, init });
    const response = responses.shift();
    return response ? Promise.resolve(response) : Promise.reject(new Error("no more answers"));
  };
  return { fetcher, asked };
}

/** `sendApi` for `request` against `SMALL`, answered by `responses`. */
function sent(request: { method: string; path: string; body?: string }, ...responses: Response[]) {
  const { fetcher, asked } = fetcherOf(...responses);
  return { answer: sendApi(SMALL, "o/r", { Authorization: "Bearer t" }, request, fetcher), asked };
}

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, ...init });

describe("the address of a request to the host's API", () => {
  it("puts a path under the REST API and replaces {repo}", () => {
    assert.equal(
      apiUrl(GITLAB, "/projects/{repo}/merge_requests?state=opened", REPO),
      `https://gitlab.example.com/api/v4/projects/${REPO}/merge_requests?state=opened`,
    );
    assert.equal(apiUrl(gitHubEndpoints("github.com"), "/repos/{repo}/pulls", "o/r"), "https://api.github.com/repos/o/r/pulls");
  });

  it("sends /graphql, with its query, to the GraphQL endpoint, which does not lie under the REST one", () => {
    assert.equal(apiUrl(GITLAB, "/graphql", REPO), "https://gitlab.example.com/api/graphql");
    assert.equal(apiUrl(GITLAB, "/graphql?x=1", REPO), "https://gitlab.example.com/api/graphql?x=1");
  });

  it("refuses what is no path of the API, or leaves its tree however `..` is spelled", () => {
    for (const path of [
      "https://evil.example/x",
      "x",
      "",
      "@evil.example/x",
      "/../graphql",
      "/a/../../graphql",
      "/%2e%2e/%2E%2E/user",
      "/..\\..\\x",
    ]) {
      assert.throws(() => apiUrl(GITLAB, path, REPO), /not a path of the host's API/, JSON.stringify(path));
    }
  });

  it("keeps a path that only looks like leaving the host on the host", () => {
    assert.equal(apiUrl(GITLAB, "//evil.example/x", REPO), "https://gitlab.example.com/api/v4//evil.example/x");
    assert.equal(apiUrl(GITLAB, "/a/../b", REPO), "https://gitlab.example.com/api/v4/b");
  });
});

describe("a request to the host's API", () => {
  it("answers status, the headers worth telling and the body as JSON", async () => {
    const { answer, asked } = sent(
      { method: "POST", path: "/x", body: '{"a":1}' },
      json({ id: 1 }, { headers: { link: '<next>; rel="next"', "x-secret": "no", "content-type": "application/json" } }),
    );
    assert.deepEqual(await answer, {
      status: 200,
      headers: { link: '<next>; rel="next"', "content-type": "application/json" },
      body: { id: 1 },
    });
    assert.equal(asked[0].url, "https://h/api/x");
    assert.equal(asked[0].init.method, "POST");
    assert.equal(asked[0].init.body, '{"a":1}');
    assert.equal(asked[0].init.redirect, "manual");
    assert.deepEqual(asked[0].init.headers, { "Cache-Control": "no-cache", Authorization: "Bearer t", "Content-Type": "application/json" });
  });

  it("answers text that is no JSON as it is, and an empty body as null", async () => {
    assert.equal((await sent({ method: "GET", path: "/x" }, new Response("plain")).answer).body, "plain");
    assert.equal((await sent({ method: "DELETE", path: "/x" }, new Response(null, { status: 204 })).answer).body, null);
  });

  it("cuts a body that is too long", async () => {
    const answer = await sent({ method: "GET", path: "/x" }, new Response("a".repeat(2 * 1024 * 1024))).answer;
    assert.equal(answer.truncated, true);
    assert.equal(String(answer.body).length, 1024 * 1024);
  });

  it("throws what the host said for a refusal, with its status for the next account", async () => {
    await assert.rejects(
      sent({ method: "GET", path: "/x" }, json({ message: "Not Found" }, { status: 404, statusText: "Not Found" })).answer,
      (error: unknown) => error instanceof ApiError && error.status === 404 && error.message === "Not Found (404 Not Found)",
    );
    await assert.rejects(
      sent({ method: "GET", path: "/x" }, json({ message: { title: ["is blank"] } }, { status: 400 })).answer,
      /\{"title":\["is blank"\]\} \(400\)/,
    );
    await assert.rejects(
      sent({ method: "GET", path: "/x" }, new Response("<html>bad gateway</html>", { status: 502 })).answer,
      /<html>bad gateway<\/html> \(502\)/,
    );
  });

  it("refuses a path outside the API before sending anything", async () => {
    const { answer, asked } = sent({ method: "GET", path: "/../graphql" });
    await assert.rejects(answer, /not a path of the host's API/);
    assert.equal(asked.length, 0);
  });

  it("follows a redirect within the host, with the token, and turns a POST into a GET after a 302", async () => {
    const { answer, asked } = sent(
      { method: "POST", path: "/x", body: "{}" },
      new Response(null, { status: 302, headers: { location: "/api/y" } }),
      json({ done: true }),
    );
    assert.deepEqual((await answer).body, { done: true });
    assert.equal(asked[1].url, "https://h/api/y");
    assert.equal(asked[1].init.method, "GET");
    assert.equal(asked[1].init.body, undefined);
    assert.deepEqual(asked[1].init.headers, { "Cache-Control": "no-cache", Authorization: "Bearer t" });
  });

  it("keeps method and body across a 307", async () => {
    const { answer, asked } = sent(
      { method: "PUT", path: "/x", body: "{}" },
      new Response(null, { status: 307, headers: { location: "https://h/api/y" } }),
      json({}),
    );
    await answer;
    assert.equal(asked[1].init.method, "PUT");
    assert.equal(asked[1].init.body, "{}");
  });

  it("does not follow a redirect to another host, so that the token stays", async () => {
    const { answer, asked } = sent(
      { method: "GET", path: "/x" },
      new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } }),
    );
    await assert.rejects(answer, /redirected to https:\/\/evil\.example, which is not followed/);
    assert.equal(asked.length, 1);
  });

  it("reads a redirect without a place to go as the answer it is", async () => {
    await assert.rejects(sent({ method: "GET", path: "/x" }, new Response("choose", { status: 300 })).answer, /choose \(300\)/);
  });

  it("gives up on redirects that never end", async () => {
    const loop = (): Response => new Response(null, { status: 302, headers: { location: "/api/again" } });
    await assert.rejects(sent({ method: "GET", path: "/x" }, loop(), loop(), loop(), loop(), loop(), loop()).answer, /too many redirects/);
  });
});

describe("the providers' requests", () => {
  it("go to GitHub's API subdomain, or to /api/v3 of an Enterprise host, and to GitLab's /api/v4", () => {
    assert.deepEqual(gitHubEndpoints("github.com"), { rest: "https://api.github.com", graphql: "https://api.github.com/graphql" });
    assert.deepEqual(gitHubEndpoints("ghe.example.com"), {
      rest: "https://ghe.example.com/api/v3",
      graphql: "https://ghe.example.com/api/graphql",
    });
    assert.deepEqual(gitLabEndpoints("gitlab.example.com"), GITLAB);
  });

  it("refuse a path outside the API before sending anything", async () => {
    await assert.rejects(
      github.request({ host: "github.com", token: "t", path: "o/r" }, { method: "GET", path: "https://evil.example" }),
      /not a path/,
    );
    await assert.rejects(
      gitlab.request({ host: "gitlab.example.com", token: "t", path: "g/r" }, { method: "GET", path: "/../graphql" }),
      /not a path/,
    );
  });
});
