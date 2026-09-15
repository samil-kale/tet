import { buildMonacoColors } from "../terminal/theme";
import { highlighter, highlightTheme, loadGrammar, switchHighlightTheme } from "./diff-highlight";
import type { languages } from "monaco-editor";
import type { HighlighterCore } from "shiki/core";

/**
 * `monaco-core.ts`, not `editor.main`: shiki colors (`@shikijs/monaco`), so no language service or
 * Monarch tokenizer is loaded. Evaluated only once an editor opens.
 */
export type Monaco = typeof import("./monaco-core");

let monacoPromise: Promise<Monaco> | undefined;

/** One monaco for every project's editor (`editor-views.ts`). */
export function loadMonaco(): Promise<Monaco> {
  if (!monacoPromise) {
    // `getWorker`, not `getWorkerUrl`: the latter makes a module worker, which fails from `file://`.
    (self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
      getWorker: () => new Worker("./editor.worker.js")
    };
    monacoPromise = import("./monaco-core");
  }
  return monacoPromise;
}

/**
 * Monaco's language configurations (comments, brackets, auto-closing, folding) per `GRAMMARS` entry:
 * shiki only colors, and without these toggle comment, bracket matching and auto-closing do nothing.
 * One import each for esbuild; a grammar monaco has no definition for gets none.
 */
const LANGUAGE_CONFIGURATIONS: Record<string, () => Promise<{ conf: languages.LanguageConfiguration }>> = {
  bat: () => import("monaco-editor/languages/definitions/bat/bat.js"),
  c: () => import("monaco-editor/languages/definitions/cpp/cpp.js"),
  cpp: () => import("monaco-editor/languages/definitions/cpp/cpp.js"),
  csharp: () => import("monaco-editor/languages/definitions/csharp/csharp.js"),
  css: () => import("monaco-editor/languages/definitions/css/css.js"),
  dart: () => import("monaco-editor/languages/definitions/dart/dart.js"),
  docker: () => import("monaco-editor/languages/definitions/dockerfile/dockerfile.js"),
  go: () => import("monaco-editor/languages/definitions/go/go.js"),
  graphql: () => import("monaco-editor/languages/definitions/graphql/graphql.js"),
  html: () => import("monaco-editor/languages/definitions/html/html.js"),
  ini: () => import("monaco-editor/languages/definitions/ini/ini.js"),
  java: () => import("monaco-editor/languages/definitions/java/java.js"),
  javascript: () => import("monaco-editor/languages/definitions/javascript/javascript.js"),
  jsx: () => import("monaco-editor/languages/definitions/javascript/javascript.js"),
  kotlin: () => import("monaco-editor/languages/definitions/kotlin/kotlin.js"),
  less: () => import("monaco-editor/languages/definitions/less/less.js"),
  lua: () => import("monaco-editor/languages/definitions/lua/lua.js"),
  markdown: () => import("monaco-editor/languages/definitions/markdown/markdown.js"),
  "objective-c": () => import("monaco-editor/languages/definitions/objective-c/objective-c.js"),
  "objective-cpp": () => import("monaco-editor/languages/definitions/objective-c/objective-c.js"),
  perl: () => import("monaco-editor/languages/definitions/perl/perl.js"),
  php: () => import("monaco-editor/languages/definitions/php/php.js"),
  powershell: () => import("monaco-editor/languages/definitions/powershell/powershell.js"),
  proto: () => import("monaco-editor/languages/definitions/protobuf/protobuf.js"),
  python: () => import("monaco-editor/languages/definitions/python/python.js"),
  r: () => import("monaco-editor/languages/definitions/r/r.js"),
  ruby: () => import("monaco-editor/languages/definitions/ruby/ruby.js"),
  rust: () => import("monaco-editor/languages/definitions/rust/rust.js"),
  scala: () => import("monaco-editor/languages/definitions/scala/scala.js"),
  scss: () => import("monaco-editor/languages/definitions/scss/scss.js"),
  shellscript: () => import("monaco-editor/languages/definitions/shell/shell.js"),
  sql: () => import("monaco-editor/languages/definitions/sql/sql.js"),
  swift: () => import("monaco-editor/languages/definitions/swift/swift.js"),
  terraform: () => import("monaco-editor/languages/definitions/hcl/hcl.js"),
  tsx: () => import("monaco-editor/languages/definitions/typescript/typescript.js"),
  typescript: () => import("monaco-editor/languages/definitions/typescript/typescript.js"),
  xml: () => import("monaco-editor/languages/definitions/xml/xml.js"),
  yaml: () => import("monaco-editor/languages/definitions/yaml/yaml.js")
};

const registered = new Set<string>();
/** False again after `shikiToMonaco` re-themes. */
let chromeApplied = false;

/**
 * Wires a language into monaco through shiki. `shikiToMonaco` sees only languages registered at call
 * time, so it re-runs per grammar and redefines the theme each time — `applyChrome` must follow. It
 * runs even for plaintext (`null`): an unknown theme name falls back to monaco's light theme.
 */
export async function ensureLanguage(monaco: Monaco, language: string | null): Promise<void> {
  const shiki = await highlighter();
  if (language && !registered.has(language)) {
    const [, definition] = await Promise.all([loadGrammar(shiki, language), LANGUAGE_CONFIGURATIONS[language]?.()]);
    monaco.languages.register({ id: language });
    if (definition) {
      monaco.languages.setLanguageConfiguration(language, definition.conf);
    }
    registered.add(language);
    const { shikiToMonaco } = await import("@shikijs/monaco");
    // @shikijs/monaco is typed against `monaco-editor-core`, not `monaco-editor`'s re-export.
    shikiToMonaco(shiki, monaco as never);
    chromeApplied = false;
  }
  if (!chromeApplied) {
    await applyChrome(monaco, shiki);
    chromeApplied = true;
  }
}

/**
 * Shiki's theme as a monaco one. `defineTheme` inherits only from built-in bases, so shiki's rules
 * are rebuilt through `@shikijs/monaco`'s `textmateThemeToMonacoTheme`. The editor surface is
 * patched by `loadTheme` (`diff-highlight.ts`); `buildMonacoColors` adds the chrome shiki lacks.
 * Must resolve before `monaco.editor.create`, or the editor paints once in monaco's own colors.
 */
async function applyChrome(monaco: Monaco, shiki: HighlighterCore): Promise<void> {
  const { textmateThemeToMonacoTheme } = await import("@shikijs/monaco");
  const theme = highlightTheme();
  const base = textmateThemeToMonacoTheme(shiki.getTheme(theme));
  monaco.editor.defineTheme(theme, { ...base, colors: { ...base.colors, ...buildMonacoColors() } });
  monaco.editor.setTheme(theme);
}

/**
 * Switches shiki and monaco to theme `id`, once its stylesheet is applied. `setTheme` is global, so
 * open editors follow. `shikiToMonaco` re-runs if it ran before: its token provider knows only the
 * themes loaded then. A monaco not loaded yet picks the theme up on load.
 */
export async function switchEditorTheme(id: string): Promise<void> {
  await switchHighlightTheme(id);
  if (!monacoPromise) {
    return;
  }
  const [monaco, shiki] = await Promise.all([monacoPromise, highlighter()]);
  if (registered.size > 0) {
    const { shikiToMonaco } = await import("@shikijs/monaco");
    shikiToMonaco(shiki, monaco as never);
  }
  await applyChrome(monaco, shiki);
  chromeApplied = true;
}

/** The editor tab's options, stripped of suggestions, minimap and the like. See `diffEditorOptions`. */
export function editorOptions(fontFamily: string): Record<string, unknown> {
  return {
    theme: highlightTheme(),
    fontFamily,
    fontSize: 13,
    lineHeight: 18,
    automaticLayout: true,
    minimap: { enabled: false },
    stickyScroll: { enabled: false },
    bracketPairColorization: { enabled: false },
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    renderLineHighlight: "line",
    scrollBeyondLastLine: false,
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    quickSuggestions: false,
    wordBasedSuggestions: "off"
  };
}

/**
 * The diff half. Inline — a side-by-side text diff is deliberately not offered — and the whole file,
 * not hunks, so the overview ruler beside the scrollbar is how changes are found (a click scrolls).
 * Whitespace-only changes never count; hunk boundaries are monaco's (`advanced`), not git's. tet
 * never diffs: it hands monaco two texts. The modified (right-hand) side is the editable one.
 *
 * Left at default on purpose: `renderGutterMenu` (its "Revert Block" edits the buffer, a save away
 * from disk, never a git discard); `maxFileSize` (50 MB, beyond our 4 MB ceiling);
 * `renderMarginRevertIcon` (ignored inline). Defaults below are spelled out: each is a decision the
 * tab rests on, and a default is no promise across upgrades.
 */
export function diffEditorOptions(): Record<string, unknown> {
  return {
    renderSideBySide: false,
    ignoreTrimWhitespace: true,
    diffAlgorithm: "advanced",
    hideUnchangedRegions: { enabled: false },
    renderOverviewRuler: true,
    originalEditable: false
  };
}
