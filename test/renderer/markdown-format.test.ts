import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { markdownEdit } from "../../src/renderer/editor/markdown-format";

/** The text a format makes of `value` with `start`..`end` selected, and what is selected then. */
function applied(format: Parameters<typeof markdownEdit>[0], value: string, start: number, end: number): [string, string] {
  const edit = markdownEdit(format, value, start, end);
  const text = value.slice(0, edit.from) + edit.insert + value.slice(edit.to);
  return [text, text.slice(...edit.select)];
}

describe("a text box's Markdown formats", () => {
  it("wraps the selection and keeps it selected", () => {
    assert.deepEqual(applied("bold", "make this loud", 5, 9), ["make **this** loud", "this"]);
    assert.deepEqual(applied("italic", "make this loud", 5, 9), ["make _this_ loud", "this"]);
    assert.deepEqual(applied("code", "run npm test", 4, 12), ["run `npm test`", "npm test"]);
  });

  it("puts the cursor inside the wrapping where nothing is selected", () => {
    assert.deepEqual(applied("bold", "ab", 1, 1), ["a****b", ""]);
    assert.deepEqual(markdownEdit("bold", "ab", 1, 1).select, [3, 3]);
  });

  it("fences a selection over several lines as code", () => {
    assert.deepEqual(applied("code", "a\nb", 0, 3), ["```\na\nb\n```", "a\nb"]);
  });

  it("makes the selection a link and selects its address", () => {
    assert.deepEqual(applied("link", "see docs now", 4, 8), ["see [docs](url) now", "url"]);
    assert.deepEqual(markdownEdit("link", "ab", 1, 1).select, [2, 2]);
  });

  it("prefixes every line the selection touches", () => {
    assert.deepEqual(applied("bullets", "one\ntwo\nthree", 5, 9), ["one\n- two\n- three", "- two\n- three"]);
    assert.deepEqual(applied("numbers", "one\ntwo\nthree", 0, 13), ["1. one\n2. two\n3. three", "1. one\n2. two\n3. three"]);
    assert.deepEqual(applied("tasks", "one", 0, 3), ["- [ ] one", "- [ ] one"]);
    assert.deepEqual(applied("quote", "one", 1, 1), ["> one", ""]);
    assert.deepEqual(applied("heading", "one\ntwo", 5, 5), ["one\n### two", ""]);
  });

  it("leaves the line after a selection that ends at a line break alone", () => {
    assert.deepEqual(applied("bullets", "one\ntwo", 0, 4)[0], "- one\ntwo");
  });

  it("keeps a cursor in its text, moved on by the prefix", () => {
    assert.deepEqual(markdownEdit("bullets", "one\ntwo", 5, 5).select, [7, 7]);
  });

  it("sets a quote apart from the text around it by a blank line", () => {
    assert.deepEqual(applied("quote", "intro\nwords\noutro", 6, 11), ["intro\n\n> words\n\noutro", "> words"]);
    assert.deepEqual(applied("quote", "intro\n\nwords", 7, 12)[0], "intro\n\n> words");
  });

  it("keeps a cursor in its text when it quotes the line", () => {
    const edit = markdownEdit("quote", "intro\nwords", 8, 8);
    assert.equal(applied("quote", "intro\nwords", 8, 8)[0].slice(0, edit.select[0]), "intro\n\n> wo");
  });

  it("quotes every line of a selection as one block", () => {
    assert.deepEqual(applied("quote", "one\ntwo", 0, 7), ["> one\n> two", "> one\n> two"]);
  });

  it("takes the quote off lines that are all quoted", () => {
    assert.deepEqual(applied("quote", "> one\n> two", 0, 11), ["one\ntwo", "one\ntwo"]);
    assert.deepEqual(applied("quote", "> one", 4, 4), ["one", ""]);
    assert.deepEqual(markdownEdit("quote", "> one", 4, 4).select, [2, 2]);
  });

  it("quotes lines of which only some are quoted", () => {
    assert.deepEqual(applied("quote", "> one\ntwo", 0, 9)[0], "> > one\n> two");
  });
});
