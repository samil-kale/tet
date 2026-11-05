import MarkdownIt, { type Env, type StateCore, type Token } from "markdown-it";
import type { ProviderId } from "../../shared/types/providers";

/** What a text is rendered for. */
interface IssueTextEnv extends Env {
  provider: ProviderId;
  /** Where its references lead from. */
  issueUrl: string;
}

/** Before and after a reference: a line's edge, a space or ASCII punctuation, so `not@mention` is none. */
const EDGE = "\\s!-\\/:-@\\[-`{-~";
const BEFORE = `(?<=^|[${EDGE}])`;
const AFTER = `(?=[${EDGE}]|$)`;

/** The references of a text as IntelliJ's converters find them: by their shape, whether or not they exist. */
const REFERENCES: Record<ProviderId, RegExp> = {
  github: new RegExp(`${BEFORE}#\\d+${AFTER}|${BEFORE}@[a-zA-Z0-9-]+${AFTER}`, "g"),
  gitlab: new RegExp(`!\\d+|${BEFORE}(?:@[a-zA-Z0-9_.][a-zA-Z0-9_\\-.]{0,254}[a-zA-Z0-9_\\-]|@[a-zA-Z0-9_])${AFTER}`, "g"),
};

const TASK = /^\[([ xX])\]\s+/;

/** Where a reference found by `REFERENCES` leads. A `#` may be a pull request, which GitHub redirects to. */
function referenceUrl(reference: string, { issueUrl }: IssueTextEnv): string {
  const name = reference.slice(1);
  if (reference.startsWith("@")) {
    return new URL(`/${name}`, issueUrl).href;
  }
  return new URL(reference.startsWith("!") ? `../merge_requests/${name}` : name, issueUrl).href;
}

function linkOpen(state: StateCore, href: string, level: number): Token {
  const open = new state.Token("link_open", "a", 1);
  open.attrSet("href", href);
  open.level = level;
  return open;
}

function linkClose(state: StateCore, level: number): Token {
  const close = new state.Token("link_close", "a", -1);
  close.level = level;
  return close;
}

function textToken(state: StateCore, content: string, level: number): Token {
  const text = new state.Token("text", "", 0);
  text.content = content;
  text.level = level;
  return text;
}

/** A text token with its references made links. */
function withReferences(state: StateCore, token: Token, env: IssueTextEnv): Token[] {
  const tokens: Token[] = [];
  let end = 0;
  for (const match of token.content.matchAll(REFERENCES[env.provider])) {
    if (match.index > end) {
      tokens.push(textToken(state, token.content.slice(end, match.index), token.level));
    }
    tokens.push(
      linkOpen(state, referenceUrl(match[0], env), token.level),
      textToken(state, match[0], token.level + 1),
      linkClose(state, token.level),
    );
    end = match.index + match[0].length;
  }
  if (end === 0) {
    return [token];
  }
  if (end < token.content.length) {
    tokens.push(textToken(state, token.content.slice(end), token.level));
  }
  return tokens;
}

/** A GitLab image's `{width=50%}` right behind it goes, what follows its `}` stays. */
function dropImageSettings(next: Token | undefined): void {
  if (next?.type === "text" && next.content.startsWith("{")) {
    const close = next.content.indexOf("}");
    if (close >= 0) {
      next.content = next.content.slice(close + 1);
    }
  }
}

/** A line's inline tokens with what IntelliJ's converters add: references made links outside a link,
 *  and on GitLab each image a link to itself, without its settings. */
function converted(state: StateCore, children: Token[], env: IssueTextEnv): Token[] {
  const tokens: Token[] = [];
  let linkDepth = 0;
  for (const [index, token] of children.entries()) {
    if (token.type === "link_open" || (token.type === "html_inline" && /^<a[\s>]/i.test(token.content))) {
      linkDepth++;
    } else if (token.type === "link_close" || (token.type === "html_inline" && /^<\/a\s*>/i.test(token.content))) {
      linkDepth--;
    }
    if (token.type === "text" && linkDepth === 0) {
      tokens.push(...withReferences(state, token, env));
    } else if (token.type === "image" && env.provider === "gitlab") {
      dropImageSettings(children[index + 1]);
      if (linkDepth > 0) {
        tokens.push(token);
      } else {
        tokens.push(linkOpen(state, String(token.attrGet("src") ?? ""), token.level), token, linkClose(state, token.level));
      }
    } else {
      tokens.push(token);
    }
  }
  return tokens;
}

/** A list item starting with `[ ]` or `[x]` is a task: its box drawn, not to be ticked here. */
function markTask(state: StateCore, index: number): void {
  const { tokens } = state;
  const inline = tokens[index];
  const first = inline.children?.[0];
  const task = first?.type === "text" ? TASK.exec(first.content) : null;
  if (!first || !task || tokens[index - 1]?.type !== "paragraph_open" || tokens[index - 2]?.type !== "list_item_open") {
    return;
  }
  first.content = first.content.slice(task[0].length);
  tokens[index - 2].attrJoin("class", "task-list-item");
  const box = new state.Token("html_inline", "", 0);
  box.content = `<input type="checkbox" class="task-list-item-checkbox"${task[1] === " " ? "" : " checked"} disabled />`;
  inline.children?.unshift(box);
}

// The options of `markdown.ts`'s preview, which reads a text as a file and adds none of this.
const markdown = new MarkdownIt({ html: true, linkify: true });
markdown.core.ruler.push("tet_issue_text", (state) => {
  state.tokens.forEach((token, index) => {
    if (token.type === "inline" && token.children) {
      markTask(state, index);
      token.children = converted(state, token.children, state.env as IssueTextEnv);
    }
  });
});

/**
 * The HTML of an issue's text: rendered here from its Markdown as IntelliJ's
 * `GHMarkdownToHtmlConverter` and `GitLabMarkdownToHtmlConverter` do, never by its host.
 */
export function issueTextHtml(text: string, provider: ProviderId, issueUrl: string): string {
  return markdown.render(text, { provider, issueUrl } satisfies IssueTextEnv);
}

/** The file of the repository a link of a GitLab issue's text means, as written: any other than a web
 *  address, an upload or one into its own project. Undefined for those, and on GitHub. */
export function issueFileLink(href: string, provider: ProviderId, issueUrl: string): string | undefined {
  if (provider !== "gitlab" || href === "" || href.startsWith("#") || href.startsWith("//") || href.startsWith("/uploads/")) {
    return undefined;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    return undefined;
  }
  const project = new URL(issueUrl).pathname.split("/-/")[0].replace(/^\//, "");
  return href.replace(/^\/+/, "").startsWith(project) ? undefined : href;
}
