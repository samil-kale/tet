import { buildMonacoColors } from "../terminal/theme";
import { highlighter, loadGrammar, THEME } from "./diff-highlight";
import type { HighlighterCore } from "shiki/core";

/**
 * monaco-editor's own "editor.main" pulls in ~80 Monarch languages plus full CSS/HTML/JSON/
 * TypeScript language services, each wanting a worker of its own — everything `monaco-core.ts`
 * leaves out on purpose, since colouring goes through the same shiki instance the diff view uses
 * instead (`@shikijs/monaco`). Both this module's dynamic import and the language services it
 * would otherwise pull in stay unevaluated until an editor is actually opened.
 */
export type Monaco = typeof import("./monaco-core");

let monacoPromise: Promise<Monaco> | undefined;

/** Loads monaco once, sharing the promise across every `CodeEditor` mount. */
export function loadMonaco(): Promise<Monaco> {
  if (!monacoPromise) {
    // Must be set before the first editor is created, and only once — later assignments would
    // race an already-starting worker. `getWorker` rather than `getWorkerUrl`: a recent monaco
    // build makes a module worker from the latter, which can fail to start from a `file://`
    // origin; a classic worker from `getWorker` does not.
    (self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
      getWorker: () => new Worker("./editor.worker.js")
    };
    monacoPromise = import("./monaco-core");
  }
  return monacoPromise;
}

/** One language registered at a time is enough for a re-run of `shikiToMonaco` below — see it. */
const registered = new Set<string>();
/** Whether `applyChrome` has run and still stands — false again after `shikiToMonaco` re-themes. */
let chromeApplied = false;

/**
 * Wires a language into monaco through shiki, so a token reads the same color here as in the
 * diff view: `shikiToMonaco` only sees languages loaded into shiki *and* registered with monaco
 * at the moment it runs, so it has to run again after every newly loaded grammar — which also
 * redefines the theme from shiki's own colors, wiping `applyChrome`'s override. Hence the fixed
 * order below. A language seen before skips all of that — nothing new for shiki to see, so a
 * re-run would only redo identical theme work on every mount. What can never be skipped is the
 * first `applyChrome`: without it the theme name `editorOptions` passes to `create` is unknown
 * to monaco, which silently falls back to its built-in *light* theme — why this is called for
 * a plaintext file too (`language: null`), which has no grammar to wire but still needs the
 * theme to exist.
 */
export async function ensureLanguage(monaco: Monaco, language: string | null): Promise<void> {
  const shiki = await highlighter();
  if (language && !registered.has(language)) {
    await loadGrammar(shiki, language);
    monaco.languages.register({ id: language });
    registered.add(language);
    const { shikiToMonaco } = await import("@shikijs/monaco");
    // @shikijs/monaco types itself against the `monaco-editor-core` package rather than
    // `monaco-editor`'s own re-export of the identical API — structurally the same shape, but TS
    // sees two different nominal origins for the same interfaces.
    shikiToMonaco(shiki, monaco as never);
    chromeApplied = false;
  }
  if (!chromeApplied) {
    await applyChrome(monaco, shiki);
    chromeApplied = true;
  }
}

/**
 * Turns shiki's theme into a monaco one. `defineTheme` only inherits from monaco's own built-in
 * bases (`vs-dark`, ...), not from another custom theme, so this rebuilds the same rules shiki
 * already computed — the exact translation `@shikijs/monaco` does internally, exposed as
 * `textmateThemeToMonacoTheme`. The editor surface (background, selection, widgets...) comes
 * along already patched with tet's own `--vscode-*` values, since `diff-highlight.ts`'s
 * `loadTheme` patches shiki's theme with them before this ever reads it; `buildMonacoColors`
 * only adds the chrome shiki has no notion of — menus, inputs, lists.
 *
 * Awaited by `ensureLanguage`, deliberately: this used to fire the import and move on, so
 * `monaco.editor.create` below could run — and paint the editor once in monaco's own colors —
 * before this ever resolved. On any colored open `@shikijs/monaco` is already loaded by the
 * time this runs; only a plaintext-first open pays the one import here instead.
 */
async function applyChrome(monaco: Monaco, shiki: HighlighterCore): Promise<void> {
  const { textmateThemeToMonacoTheme } = await import("@shikijs/monaco");
  const base = textmateThemeToMonacoTheme(shiki.getTheme(THEME));
  monaco.editor.defineTheme(THEME, { ...base, colors: { ...base.colors, ...buildMonacoColors() } });
  monaco.editor.setTheme(THEME);
}

/**
 * Options shared by every editor, tuned so Diff and Edit read as one tool rather than two:
 * matching font metrics (`.diff-body`'s own 13px/18px), no bracket-pair colors (the diff has
 * none), and a plain quick-edit surface — no suggestions, no sticky scroll, no minimap. Easy to
 * turn back on individually if that turns out to be missed.
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
