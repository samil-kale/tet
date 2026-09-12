import { buildMonacoColors } from "../terminal/theme";
import { highlighter, loadGrammar, THEME } from "./diff-highlight";
import type { languages } from "monaco-editor";
import type { HighlighterCore } from "shiki/core";

/**
 * `monaco-core.ts`, not monaco's `editor.main`: colouring goes through the diff view's shiki
 * instance (`@shikijs/monaco`), so no language service is loaded and no Monarch tokenizer is
 * registered. Nothing here is evaluated until an editor is opened.
 */
export type Monaco = typeof import("./monaco-core");

let monacoPromise: Promise<Monaco> | undefined;

/** Loads monaco once, sharing the promise across every `DiffEditor` mount. */
export function loadMonaco(): Promise<Monaco> {
  if (!monacoPromise) {
    // Set once, before the first editor. `getWorker`, not `getWorkerUrl`: monaco makes a module
    // worker from the latter, which fails to start from a `file://` origin.
    (self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
      getWorker: () => new Worker("./editor.worker.js")
    };
    monacoPromise = import("./monaco-core");
  }
  return monacoPromise;
}

/**
 * Comment tokens, brackets, auto-closing pairs, on-enter rules and folding markers per grammar
 * (`GRAMMARS` in diff-highlight.ts), read off monaco's own language definitions: shiki only
 * colours, and without these toggle comment, bracket matching and auto-closing do nothing. Spelled
 * out per import for esbuild, like `GRAMMARS`; a grammar monaco has no definition for gets none.
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

/** Languages already wired into monaco. */
const registered = new Set<string>();
/** Whether `applyChrome` has run and still stands — false again after `shikiToMonaco` re-themes. */
let chromeApplied = false;

/**
 * Wires a language into monaco through shiki, so a token reads the same color here as in the
 * diff view. `shikiToMonaco` only sees languages loaded and registered at call time, so it
 * re-runs per new grammar, and each run redefines the theme from shiki's colors — `applyChrome`
 * must follow every run. It must run at least once even for plaintext (`language: null`): an
 * unknown theme name makes monaco fall back to its built-in light theme.
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
    // @shikijs/monaco is typed against `monaco-editor-core`, not `monaco-editor`'s re-export of
    // the same API.
    shikiToMonaco(shiki, monaco as never);
    chromeApplied = false;
  }
  if (!chromeApplied) {
    await applyChrome(monaco, shiki);
    chromeApplied = true;
  }
}

/**
 * Turns shiki's theme into a monaco one. `defineTheme` only inherits from monaco's built-in
 * bases, not from another custom theme, so this rebuilds shiki's rules through the same
 * `textmateThemeToMonacoTheme` that `@shikijs/monaco` uses. The editor surface is already
 * patched with tet's `--vscode-*` values by `loadTheme` (`diff-highlight.ts`); `buildMonacoColors`
 * adds the chrome shiki has no notion of — menus, inputs, lists.
 *
 * Must resolve before `monaco.editor.create`, or the editor paints once in monaco's own colors.
 */
async function applyChrome(monaco: Monaco, shiki: HighlighterCore): Promise<void> {
  const { textmateThemeToMonacoTheme } = await import("@shikijs/monaco");
  const base = textmateThemeToMonacoTheme(shiki.getTheme(THEME));
  monaco.editor.defineTheme(THEME, { ...base, colors: { ...base.colors, ...buildMonacoColors() } });
  monaco.editor.setTheme(THEME);
}

/**
 * Options for the one editor the dialog has, 13px/18px and stripped of everything a code editor
 * offers that this one does not: no bracket-pair colors, no suggestions, no sticky scroll, no
 * minimap. The diff half is `diffEditorOptions`; both go into the same construction call.
 */
export function editorOptions(fontFamily: string): Record<string, unknown> {
  return {
    theme: THEME,
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
 * The diff half of the same editor. Inline, never two columns — a side-by-side text diff is one of
 * the things the git half deliberately does not do — and the whole file rather than hunks, which is
 * what leaves the overview ruler beside the scrollbar as the way to find the changes: it is drawn
 * into its own strip there, and a click on it scrolls like a click on the scrollbar itself.
 *
 * Whitespace-only differences never count (`ignoreTrimWhitespace`), and the hunk boundaries are
 * monaco's (`advanced`), not git's. Left at its default on purpose: `renderGutterMenu`, whose
 * "Revert Block" button takes one block back in the editor — a save away from disk, and never a
 * git discard; `maxFileSize`, whose 50 MB our own 4 MB ceiling keeps out of reach; and
 * `renderMarginRevertIcon`, which inline mode ignores outright.
 *
 * Several of these are monaco's defaults too, and they are spelled out anyway: each one is a
 * decision this dialog rests on, and a default is not a promise across upgrades.
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
