import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import { highlighter, highlightTheme, languageForFence, loadGrammar } from "./diff-highlight";
import styles from "./markdown-preview.css" with { type: "text" };

/**
 * A Markdown file as its preview shows it (VS Code's "Open Preview to the Side"): VS Code's own
 * engine and options, with the raw HTML a README carries, sanitized — the page holds `window.tet`.
 * It lands in a shadow root, so the page's stylesheet and the file's classes never meet; `style`
 * still goes, since `position: fixed` would lay an element over the whole window.
 */
const SANITIZE = { FORBID_TAGS: ["style"], FORBID_ATTR: ["style"] };

/**
 * What makes an element load something. The page's `img-src 'self'` would let a relative one reach
 * the disk beside the app, so all go but a link's target and an image's source, which
 * `resolveImage` vets: a `<picture>` falls back to its `<img>`, a `<video>` shows no poster.
 */
const LOADING_ATTRIBUTES = ["src", "srcset", "poster", "background", "href", "xlink:href", "data"];

/** Marks the source line a block starts at — VS Code's `data-line` — for the scroll sync. */
const LINE_ATTRIBUTE = "data-tet-line";

const markdown = new MarkdownIt({ html: true, linkify: true });
// Every block token markdown-it maps to the source, nested ones included; raw HTML has no element
// to carry it.
markdown.core.ruler.push("tet_source_lines", (state) => {
  for (const token of state.tokens) {
    if (token.map && token.nesting !== -1 && token.type !== "inline") {
      token.attrSet(LINE_ATTRIBUTE, String(token.map[0]));
    }
  }
});

let sheet: CSSStyleSheet | undefined;

/** A preview's scroller, in the page for its scrollbars, and the element in its shadow root that
 *  `renderMarkdown`'s content goes into. */
export function createPreview(): { scroller: HTMLDivElement; body: HTMLDivElement } {
  const scroller = document.createElement("div");
  scroller.className = "markdown-preview";
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(styles);
  }
  const root = scroller.attachShadow({ mode: "open" });
  root.adoptedStyleSheets = [sheet];
  const body = document.createElement("div");
  body.className = "markdown-body";
  root.append(body);
  return { scroller, body };
}

/**
 * The preview of the Markdown file at `path`, in an inert document that has loaded nothing: code
 * blocks colored by shiki, images replaced by `loadImage`'s data URL — asked for a repository path
 * or an https URL, which main fetches, so the page's CSP keeps it off the network. Any other image
 * source is dropped: `file:` never reaches the disk.
 */
export async function renderMarkdown(
  text: string,
  path: string,
  loadImage: (source: string) => Promise<string | undefined>
): Promise<Document> {
  const html = DOMPurify.sanitize(markdown.render(text), SANITIZE);
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const element of doc.body.querySelectorAll("*")) {
    for (const name of LOADING_ATTRIBUTES) {
      const kept = (name === "href" && element.localName === "a") || (name === "src" && element.localName === "img");
      if (!kept) {
        element.removeAttribute(name);
      }
    }
  }
  const previous = colored;
  const current = new Map<string, string>();
  await Promise.all([
    ...[...doc.querySelectorAll("pre > code")].map((code) => highlightBlock(code, previous, current)),
    ...[...doc.querySelectorAll("img")].map((img) => resolveImage(img, path, loadImage))
  ]);
  colored = current;
  return doc;
}

interface Mark {
  /** The block's first source line, 0-based. */
  line: number;
  /** Its offset in the scroller. */
  top: number;
}

/** Every marked block, in document order, which is also the source's. */
function blocks(scroller: HTMLElement, body: HTMLElement): Mark[] {
  const origin = scroller.getBoundingClientRect().top - scroller.scrollTop;
  return [...body.querySelectorAll(`[${LINE_ATTRIBUTE}]`)].map((block) => ({
    line: Number(block.getAttribute(LINE_ATTRIBUTE)),
    top: block.getBoundingClientRect().top - origin
  }));
}

/** The last block `reached` holds for, and the one after it — what a position falls between. */
function around(marks: Mark[], reached: (mark: Mark) => boolean): [Mark | undefined, Mark | undefined] {
  let index = -1;
  while (index + 1 < marks.length && reached(marks[index + 1])) {
    index++;
  }
  return [marks[index], marks[index + 1]];
}

/**
 * Scrolls the preview to the editor's `line` (0-based, fractional): between the blocks marked
 * around it, in proportion.
 */
export function scrollToLine(scroller: HTMLElement, body: HTMLElement, line: number): void {
  const [before, after] = around(blocks(scroller, body), (mark) => mark.line <= line);
  if (!before) {
    scroller.scrollTop = 0;
    return;
  }
  const share = after ? (line - before.line) / (after.line - before.line) : 0;
  scroller.scrollTop = before.top + share * ((after?.top ?? before.top) - before.top);
}

/**
 * The other way round: the source line at the top of the preview, 0-based and fractional, for the
 * editor to follow. Undefined while nothing is rendered.
 */
export function lineAtScroll(scroller: HTMLElement, body: HTMLElement): number | undefined {
  const marks = blocks(scroller, body);
  const [before, after] = around(marks, (mark) => mark.top <= scroller.scrollTop);
  if (!before) {
    return marks.length > 0 ? 0 : undefined;
  }
  const height = after ? after.top - before.top : 0;
  const share = height > 0 ? (scroller.scrollTop - before.top) / height : 0;
  return before.line + share * ((after?.line ?? before.line) - before.line);
}

/**
 * The colored HTML of the last render's code blocks, by theme, language and text. The preview is
 * rendered again on every keystroke, and shiki would tokenize every block of the file each time,
 * though only the one being typed in changed. Carried one render forward, so it holds a document
 * rather than the history of one being written; a theme change misses every key and falls out.
 */
let colored = new Map<string, string>();

async function highlightBlock(code: Element, previous: Map<string, string>, current: Map<string, string>): Promise<void> {
  const fence = [...code.classList].find((name) => name.startsWith("language-"));
  const language = fence && languageForFence(fence.slice("language-".length));
  if (!language) {
    return;
  }
  const text = code.textContent ?? "";
  const theme = highlightTheme();
  const key = `${theme}\u0000${language}\u0000${text}`;
  const html = previous.get(key) ?? (await colorBlock(text, language, theme));
  current.set(key, html);
  code.innerHTML = html;
}

/** shiki with the block's grammar loaded. Spans alone: the block's surface is the preview's, not
 *  the theme's editor background. */
async function colorBlock(text: string, language: string, theme: string): Promise<string> {
  const shiki = await highlighter();
  await loadGrammar(shiki, language);
  return shiki.codeToHtml(text, { lang: language, theme, structure: "inline" });
}

async function resolveImage(
  img: HTMLImageElement,
  path: string,
  loadImage: (source: string) => Promise<string | undefined>
): Promise<void> {
  const src = img.getAttribute("src") ?? "";
  if (/^data:image\//i.test(src)) {
    return;
  }
  img.removeAttribute("src");
  const source = /^https:/i.test(src) ? src : resolveLink(path, src);
  const url = source === undefined ? undefined : await loadImage(source);
  if (url) {
    img.setAttribute("src", url);
  }
}

/**
 * A link or image source relative to the Markdown file at `from`, as a repository-relative path;
 * a leading "/" is the repository root, as on GitHub. Undefined for a URL, or a path leaving the
 * repository. A backslash separates too: main joins the path with the platform's rules, where
 * Windows reads `..\` as a step up.
 */
export function resolveLink(from: string, href: string): string | undefined {
  const target = href.replace(/[?#].*$/, "");
  if (target === "" || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) {
    return undefined;
  }
  let decoded: string;
  try {
    decoded = decodeURI(target);
  } catch {
    return undefined;
  }
  const segments = /^[\\/]/.test(decoded) ? [] : from.split("/").slice(0, -1);
  for (const segment of decoded.split(/[\\/]/)) {
    if (segment === "..") {
      if (segments.length === 0) {
        return undefined;
      }
      segments.pop();
    } else if (segment !== "" && segment !== ".") {
      segments.push(segment);
    }
  }
  return segments.length > 0 ? segments.join("/") : undefined;
}
