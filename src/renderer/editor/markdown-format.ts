export type MarkdownFormat = "heading" | "bold" | "italic" | "quote" | "code" | "link" | "bullets" | "numbers" | "tasks";

/** `insert` replaces `value[from, to)`; `select` is the selection in the text that results. */
export interface MarkdownEdit {
  from: number;
  to: number;
  insert: string;
  select: [start: number, end: number];
}

const WRAPS: Partial<Record<MarkdownFormat, [before: string, after: string]>> = {
  bold: ["**", "**"],
  italic: ["_", "_"],
};

const QUOTE = "> ";

/** What leads line `index` of the lines a format is applied to. */
const PREFIXES: Partial<Record<MarkdownFormat, (index: number) => string>> = {
  heading: () => "### ",
  quote: () => QUOTE,
  bullets: () => "- ",
  numbers: (index) => `${index + 1}. `,
  tasks: () => "- [ ] ",
};

const LINK_URL = "url";

/** The line breaks that set a block apart from the `text` on its `side`: none where it holds no text. */
function apart(text: string, side: "before" | "after"): string {
  if (!/\S/.test(text)) {
    return "";
  }
  const breaks = (side === "before" ? /\n*$/ : /^\n*/).exec(text)?.[0].length ?? 0;
  return "\n".repeat(Math.max(0, 2 - breaks));
}

/**
 * The edit a toolbar button makes to `value` with `start`..`end` selected: the selection wrapped
 * (bold, italic, code, link), or each line it touches prefixed (the rest). Nothing selected leaves
 * the cursor in its text: inside the wrapping, or moved on by the prefix. A quote is a paragraph of
 * its own, as GitHub's, and quoting lines already quoted takes the quote off.
 */
export function markdownEdit(format: MarkdownFormat, value: string, start: number, end: number): MarkdownEdit {
  const prefix = PREFIXES[format];
  if (prefix) {
    // A selection ending right behind a line break does not reach the line after it.
    const last = end > start && value[end - 1] === "\n" ? end - 1 : end;
    const from = value.lastIndexOf("\n", start - 1) + 1;
    const lineEnd = value.indexOf("\n", last);
    const to = lineEnd === -1 ? value.length : lineEnd;
    const lines = value.slice(from, to).split("\n");
    const quote = format === "quote";
    if (quote && lines.every((line) => line.startsWith(QUOTE))) {
      const insert = lines.map((line) => line.slice(QUOTE.length)).join("\n");
      const cursor = Math.max(start - QUOTE.length, from);
      return { from, to, insert, select: start === end ? [cursor, cursor] : [from, from + insert.length] };
    }
    const prefixed = lines.map((line, index) => prefix(index) + line).join("\n");
    const lead = quote ? apart(value.slice(0, from), "before") : "";
    const trail = quote ? apart(value.slice(to), "after") : "";
    const cursor = start + lead.length + prefix(0).length;
    return {
      from,
      to,
      insert: lead + prefixed + trail,
      select: start === end ? [cursor, cursor] : [from + lead.length, from + lead.length + prefixed.length],
    };
  }
  const selected = value.slice(start, end);
  if (format === "link") {
    const url = start + selected.length + 3;
    return {
      from: start,
      to: end,
      insert: `[${selected}](${LINK_URL})`,
      select: selected === "" ? [start + 1, start + 1] : [url, url + LINK_URL.length],
    };
  }
  const [before, after] = WRAPS[format] ?? (selected.includes("\n") ? ["```\n", "\n```"] : ["`", "`"]);
  return {
    from: start,
    to: end,
    insert: before + selected + after,
    select: [start + before.length, start + before.length + selected.length],
  };
}
