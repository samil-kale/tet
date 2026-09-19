import DOMPurify from "dompurify";
import { marked } from "marked";
import { highlighter, highlightTheme, languageForFence, loadGrammar } from "./diff-highlight";

/**
 * A Markdown file as its preview tab shows it (VS Code's "Open Preview"): GitHub-flavoured, with
 * the raw HTML a README carries, sanitized — the page holds `window.tet`. `<style>` and `style`
 * would reach the whole window, not just the preview, and a `<form>` would navigate it away.
 * `srcset` goes too, so every image passes `resolveImage`: a `<picture>` falls back to its `<img>`.
 */
const SANITIZE = { FORBID_TAGS: ["style", "form"], FORBID_ATTR: ["style", "srcset"] };

/**
 * The preview of the Markdown file at `path`, in an inert document that has loaded nothing: code
 * blocks colored by shiki, repository images replaced by `loadImage`'s data URL. https images stay
 * as they are (the CSP's `img-src`); any other source is dropped, so `file:` never reaches the disk.
 */
export async function renderMarkdown(
  text: string,
  path: string,
  loadImage: (path: string) => Promise<string | undefined>
): Promise<Document> {
  const html = DOMPurify.sanitize(await marked.parse(text, { gfm: true }), SANITIZE);
  const doc = new DOMParser().parseFromString(html, "text/html");
  await Promise.all([
    ...[...doc.querySelectorAll("pre > code")].map((code) => highlightBlock(code)),
    ...[...doc.querySelectorAll("img")].map((img) => resolveImage(img, path, loadImage))
  ]);
  return doc;
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
  loadImage: (path: string) => Promise<string | undefined>
): Promise<void> {
  const src = img.getAttribute("src") ?? "";
  if (/^(https:|data:image\/)/i.test(src)) {
    return;
  }
  img.removeAttribute("src");
  const target = resolveLink(path, src);
  const url = target === undefined ? undefined : await loadImage(target);
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
