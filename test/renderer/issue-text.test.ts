import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { issueFileLink, issueTextHtml } from "../../src/renderer/editor/issue-text";

const GITHUB_ISSUE = "https://github.com/o/r/issues/5";
const GITLAB_ISSUE = "https://gitlab.example.com/g/p/-/issues/5";

const github = (text: string): string => issueTextHtml(text, "github", GITHUB_ISSUE).trim();
const gitlab = (text: string): string => issueTextHtml(text, "gitlab", GITLAB_ISSUE).trim();

describe("an issue's text on GitHub", () => {
  it("links a number to its issue and a mention to its user", () => {
    assert.equal(github("See #1 now"), '<p>See <a href="https://github.com/o/r/issues/1">#1</a> now</p>');
    assert.equal(github("@mira is first"), '<p><a href="https://github.com/mira">@mira</a> is first</p>');
    assert.equal(
      github("Many:@a;@b,@c."),
      '<p>Many:<a href="https://github.com/a">@a</a>;<a href="https://github.com/b">@b</a>,<a href="https://github.com/c">@c</a>.</p>',
    );
  });

  it("leaves what only looks like a reference", () => {
    assert.equal(github("not@mention and a#1"), "<p>not@mention and a#1</p>");
    assert.equal(github("Here is `@Annotation` and `#1`"), "<p>Here is <code>@Annotation</code> and <code>#1</code></p>");
    assert.equal(github("[@link #1](https://example.com)"), '<p><a href="https://example.com">@link #1</a></p>');
    assert.equal(github('<a href="https://example.com">@link</a>'), '<p><a href="https://example.com">@link</a></p>');
    assert.equal(github("```java\n@Annotation #1\n```"), '<pre><code class="language-java">@Annotation #1\n</code></pre>');
  });

  it("knows no merge request, and leaves an image as it is", () => {
    assert.equal(github("!12"), "<p>!12</p>");
    assert.equal(github("![a](https://example.com/a.png)"), '<p><img src="https://example.com/a.png" alt="a"></p>');
  });

  it("draws a task's box, ticked or not, not to be ticked here", () => {
    assert.equal(
      github("- [x] done\n- [ ] open\n- plain"),
      '<ul>\n<li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" checked disabled />done</li>\n' +
        '<li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled />open</li>\n<li>plain</li>\n</ul>',
    );
    assert.equal(github("[x] no list"), "<p>[x] no list</p>");
  });

  it("keeps a table, a struck text and a bare address", () => {
    assert.ok(github("| a |\n|---|\n| b |").includes("<table>"));
    assert.equal(github("~~gone~~"), "<p><s>gone</s></p>");
    assert.equal(github("https://example.com"), '<p><a href="https://example.com">https://example.com</a></p>');
  });
});

describe("an issue's text on GitLab", () => {
  it("links a merge request and a mention, a number not", () => {
    assert.equal(gitlab("!53"), '<p><a href="https://gitlab.example.com/g/p/-/merge_requests/53">!53</a></p>');
    assert.equal(gitlab("@a.b-c"), '<p><a href="https://gitlab.example.com/a.b-c">@a.b-c</a></p>');
    assert.equal(gitlab("See #1"), "<p>See #1</p>");
  });

  const image = '<a href="/uploads/a/c.jpg"><img src="/uploads/a/c.jpg" alt="i"></a>';

  it("makes an image a link to itself", () => {
    assert.equal(gitlab("![i](/uploads/a/c.jpg)"), `<p>${image}</p>`);
    assert.equal(
      gitlab("[![i](/uploads/a/c.jpg)](https://example.com)"),
      '<p><a href="https://example.com"><img src="/uploads/a/c.jpg" alt="i"></a></p>',
    );
  });

  it("sizes an image by its settings and keeps what follows them", () => {
    const sized = (size: string): string => `<a href="/uploads/a/c.jpg"><img src="/uploads/a/c.jpg" alt="i" ${size}></a>`;
    assert.equal(gitlab("![i](/uploads/a/c.jpg){width=900 height=520}"), `<p>${sized('width="900" height="520"')}</p>`);
    assert.equal(gitlab("![i](/uploads/a/c.jpg){width=10% height=10px}"), `<p>${sized('width="10%" height="10"')}</p>`);
    assert.equal(gitlab('![i](/uploads/a/c.jpg){width="10"} some text'), `<p>${sized('width="10"')} some text</p>`);
    assert.equal(gitlab("![i](/uploads/a/c.jpg){width=10}now"), `<p>${sized('width="10"')}now</p>`);
    assert.equal(gitlab("![i](/uploads/a/c.jpg){width=wide data-height=10}"), `<p>${image}</p>`);
    assert.equal(gitlab("![i](/uploads/a/c.jpg){a=1} {other}"), `<p>${image} {other}</p>`);
    assert.equal(gitlab("![i](/uploads/a/c.jpg){a=1}{other}"), `<p>${image}{other}</p>`);
    assert.equal(gitlab("![i][l]{a=1} text\n\n[l]: /uploads/a/c.jpg"), `<p>${image} text</p>`);
  });

  it("opens a link in the repository, and only that", () => {
    assert.equal(issueFileLink("bla.md", "gitlab", GITLAB_ISSUE), "bla.md");
    assert.equal(issueFileLink("directory/a/bla.md", "gitlab", GITLAB_ISSUE), "directory/a/bla.md");
    assert.equal(issueFileLink("/some/path?query=1", "gitlab", GITLAB_ISSUE), "/some/path?query=1");
    assert.equal(issueFileLink("/g/p/-/merge_requests/1", "gitlab", GITLAB_ISSUE), undefined);
    assert.equal(issueFileLink("/uploads/a/c.pdf", "gitlab", GITLAB_ISSUE), undefined);
    assert.equal(issueFileLink("https://example.com/a", "gitlab", GITLAB_ISSUE), undefined);
    assert.equal(issueFileLink("mailto:a@example.com", "gitlab", GITLAB_ISSUE), undefined);
    assert.equal(issueFileLink("#note", "gitlab", GITLAB_ISSUE), undefined);
    assert.equal(issueFileLink("bla.md", "github", GITHUB_ISSUE), undefined);
  });
});
