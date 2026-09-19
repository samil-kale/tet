import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import { highlighter, highlightTheme, languageForFence, loadGrammar } from "./diff-highlight";
import styles from "./markdown-preview.css" with { type: "text" };

/**
 * A Markdown file as its preview shows it (VS Code's "Open Preview to the Side"): VS Code's own
 * engine and options, with the raw HTML a README carries, sanitized — the page holds `window.tet`.
 * It lands in a shadow root, so the page's stylesheet and the file's classes never meet; `style`
 * still goes, since `position: fixed` would lay an element over the whole window. `srcset` goes
 * too, so every image passes `resolveImage`: a `<picture>` falls back to its `<img>`.
 */
const SANITIZE = { FORBID_TAGS: ["style"], FORBID_ATTR: ["style", "srcset"] };

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
  await Promise.all([
    ...[...doc.querySelectorAll("pre > code")].map((code) => highlightBlock(code)),
    ...[...doc.querySelectorAll("img")].map((img) => resolveImage(img, path, loadImage))
  ]);
  return doc;
}

/**
 * Scrolls the preview to the editor's `line` (0-based, fractional): between the blocks marked
 * around it, in proportion.
 */
export function scrollToLine(scroller: HTMLElement, body: HTMLElement, line: number): void {
  const origin = scroller.getBoundingClientRect().top - scroller.scrollTop;
  let before: { line: number; top: number } | undefined;
  let after: { line: number; top: number } | undefined;
  for (const block of body.querySelectorAll(`[${LINE_ATTRIBUTE}]`)) {
    const mark = { line: Number(block.getAttribute(LINE_ATTRIBUTE)), top: block.getBoundingClientRect().top - origin };
    if (mark.line <= line) {
      before = mark;
    } else {
      after = mark;
      break;
    }
  }
  if (!before) {
    scroller.scrollTop = 0;
    return;
  }
  const share = after ? (line - before.line) / (after.line - before.line) : 0;
  scroller.scrollTop = before.top + share * ((after?.top ?? before.top) - before.top);
}

async function highlightBlock(code: Element): Promise<void> {
  const fence = [...code.classList].find((name) => name.startsWith("language-"));
  const language = fence && languageForFence(fence.slice("language-".length));
  if (!language) {
    return;
  }
  const shiki = await highlighter();
  await loadGrammar(shiki, language);
  // Spans alone: the block's surface is the preview's, not the theme's editor background.
  code.innerHTML = shiki.codeToHtml(code.textContent ?? "", {
    lang: language,
    theme: highlightTheme(),
    structure: "inline"
  });
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
 * repository.
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
  const segments = decoded.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const segment of decoded.split("/")) {
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
