import { buildMonacoColors } from "../terminal/theme";
import { highlighter, loadGrammar, THEME } from "./diff-highlight";
import type { HighlighterCore } from "shiki/core";

/**
 * `monaco-core.ts`, not monaco's `editor.main`: colouring goes through the diff view's shiki
 * instance (`@shikijs/monaco`), so no language or language service is loaded. Nothing here is
 * evaluated until an editor is opened.
 */
export type Monaco = typeof import("./monaco-core");

let monacoPromise: Promise<Monaco> | undefined;

/** Loads monaco once, sharing the promise across every `CodeEditor` mount. */
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
    await loadGrammar(shiki, language);
    monaco.languages.register({ id: language });
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
 * Options shared by every editor, matched to the diff view: `.diff-body`'s 13px/18px font
 * metrics, no bracket-pair colors, no suggestions, no sticky scroll, no minimap.
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
