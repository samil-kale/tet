import {
  createHighlighterCore,
  type HighlighterCore,
  type LanguageRegistration,
  type ThemeRegistration
} from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { resolveTheme, type ThemeDefinition } from "../../shared/themes";
import { baseName } from "../files/explorer-tree";
import { buildShikiColors } from "../terminal/theme";

/** The shiki theme coloring the editor (monaco has no grammars, see monaco-core.ts). Token colors
 *  are the one thing not from a --vscode-* variable; this is the token half of the Settings theme
 *  (Dark Modern's from Dark+, Light Modern's from Light+), its surface patched in `loadTheme`. */
let theme = resolveTheme(window.tet.initialTheme).shikiTheme;

/** The current shiki theme, and monaco's, named after it. */
export function highlightTheme(): ThemeDefinition["shikiTheme"] {
  return theme;
}

/** Spelled out: esbuild bundles only an import whose path it can read off the call (as GRAMMARS). */
const THEME_MODULES: Record<ThemeDefinition["shikiTheme"], () => Promise<{ default: ThemeRegistration }>> = {
  "dark-plus": () => import("@shikijs/themes/dark-plus"),
  "light-plus": () => import("@shikijs/themes/light-plus"),
  "github-dark-default": () => import("@shikijs/themes/github-dark-default"),
  "github-light-default": () => import("@shikijs/themes/github-light-default"),
  dracula: () => import("@shikijs/themes/dracula"),
  // A JSON import is typed literally, and one color here is an array ThemeRegistration rejects.
  "dark-slate": () => import("../themes/dark-slate.json") as unknown as Promise<{ default: ThemeRegistration }>,
  "dark-intellij": () => import("../themes/dark-intellij.json") as unknown as Promise<{ default: ThemeRegistration }>,
  "light-intellij": () => import("../themes/light-intellij.json") as unknown as Promise<{ default: ThemeRegistration }>,
  "light-gameboy": () => import("../themes/light-gameboy.json") as unknown as Promise<{ default: ThemeRegistration }>
};

/** Shiki theme `name` with its editor surface patched from tet's --vscode-* values, for shiki and
 *  the monaco theme built on it (editor.ts). */
async function loadTheme(name: ThemeDefinition["shikiTheme"]): Promise<ThemeRegistration> {
  const { default: registration } = await THEME_MODULES[name]();
  return { ...registration, colors: { ...registration.colors, ...buildShikiColors() } };
}

const themeListeners = new Set<() => void>();
/** Bumped by every switch: one overtaken while its theme loads names nothing. */
let themeSwitches = 0;

/** Fires once a switched theme is loaded — for what shiki colored at render, the Markdown preview. */
export function subscribeHighlightTheme(listener: () => void): () => void {
  themeListeners.add(listener);
  return () => themeListeners.delete(listener);
}

/**
 * Switches to theme `id` once its stylesheet is applied. Reloaded even under a known name: the
 * patched surface colors are read off the stylesheet at load. `highlightTheme()` names it only once
 * loaded: a preview rendering meanwhile would ask shiki for a theme it doesn't have yet.
 */
export async function switchHighlightTheme(id: string): Promise<void> {
  const next = resolveTheme(id).shikiTheme;
  const switchSeq = ++themeSwitches;
  if (core) {
    await (await core).loadTheme(loadTheme(next));
  }
  if (switchSeq !== themeSwitches) {
    return;
  }
  theme = next;
  themeListeners.forEach((listener) => listener());
}

/** What a repository plausibly holds, not every one Shiki ships: the renderer is one file, no code
 *  splitting. Anything else is uncolored. Lazy, so an unopened language costs parse, not startup. */
const GRAMMARS: Record<string, () => Promise<{ default: LanguageRegistration[] }>> = {
  bat: () => import("@shikijs/langs/bat"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  css: () => import("@shikijs/langs/css"),
  dart: () => import("@shikijs/langs/dart"),
  docker: () => import("@shikijs/langs/docker"),
  dotenv: () => import("@shikijs/langs/dotenv"),
  go: () => import("@shikijs/langs/go"),
  graphql: () => import("@shikijs/langs/graphql"),
  groovy: () => import("@shikijs/langs/groovy"),
  html: () => import("@shikijs/langs/html"),
  ini: () => import("@shikijs/langs/ini"),
  java: () => import("@shikijs/langs/java"),
  javascript: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  json5: () => import("@shikijs/langs/json5"),
  jsx: () => import("@shikijs/langs/jsx"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  less: () => import("@shikijs/langs/less"),
  lua: () => import("@shikijs/langs/lua"),
  make: () => import("@shikijs/langs/make"),
  markdown: () => import("@shikijs/langs/markdown"),
  "objective-c": () => import("@shikijs/langs/objective-c"),
  "objective-cpp": () => import("@shikijs/langs/objective-cpp"),
  perl: () => import("@shikijs/langs/perl"),
  php: () => import("@shikijs/langs/php"),
  powershell: () => import("@shikijs/langs/powershell"),
  properties: () => import("@shikijs/langs/properties"),
  proto: () => import("@shikijs/langs/proto"),
  python: () => import("@shikijs/langs/python"),
  r: () => import("@shikijs/langs/r"),
  ruby: () => import("@shikijs/langs/ruby"),
  rust: () => import("@shikijs/langs/rust"),
  scala: () => import("@shikijs/langs/scala"),
  scss: () => import("@shikijs/langs/scss"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  sql: () => import("@shikijs/langs/sql"),
  swift: () => import("@shikijs/langs/swift"),
  terraform: () => import("@shikijs/langs/terraform"),
  toml: () => import("@shikijs/langs/toml"),
  tsx: () => import("@shikijs/langs/tsx"),
  typescript: () => import("@shikijs/langs/typescript"),
  vue: () => import("@shikijs/langs/vue"),
  xml: () => import("@shikijs/langs/xml"),
  yaml: () => import("@shikijs/langs/yaml")
};

/** Lowercased extension to grammar. */
const EXTENSIONS: Record<string, string> = {
  bash: "shellscript",
  bat: "bat",
  c: "c",
  cc: "cpp",
  cfg: "ini",
  cjs: "javascript",
  cmd: "bat",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  cts: "typescript",
  cxx: "cpp",
  dart: "dart",
  dockerfile: "docker",
  env: "dotenv",
  go: "go",
  gql: "graphql",
  gradle: "groovy",
  graphql: "graphql",
  groovy: "groovy",
  h: "c",
  hcl: "terraform",
  hpp: "cpp",
  htm: "html",
  html: "html",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  json5: "json5",
  jsonc: "json",
  jsx: "jsx",
  kt: "kotlin",
  kts: "kotlin",
  less: "less",
  lua: "lua",
  m: "objective-c",
  makefile: "make",
  md: "markdown",
  mjs: "javascript",
  mm: "objective-cpp",
  mts: "typescript",
  perl: "perl",
  pl: "perl",
  pm: "perl",
  php: "php",
  proto: "proto",
  ps1: "powershell",
  psm1: "powershell",
  properties: "properties",
  py: "python",
  r: "r",
  rb: "ruby",
  rs: "rust",
  scala: "scala",
  scss: "scss",
  sh: "shellscript",
  sql: "sql",
  swift: "swift",
  tf: "terraform",
  tfvars: "terraform",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  vue: "vue",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "shellscript"
};

let core: Promise<HighlighterCore> | undefined;
/** Promises, so two files of one kind don't race the load. */
const grammars = new Map<string, Promise<void>>();

/** The one shiki instance, shared with editor.ts; grammars load lazily. */
export function highlighter(): Promise<HighlighterCore> {
  core ??= createHighlighterCore({
    themes: [loadTheme(theme)],
    langs: [],
    // Not oniguruma: its wasm would ride base64 in the single-file bundle. "forgiving" skips
    // patterns the JS engine cannot express.
    engine: createJavaScriptRegexEngine({ forgiving: true })
  });
  return core;
}

export function loadGrammar(shiki: HighlighterCore, language: string): Promise<void> {
  let pending = grammars.get(language);
  if (!pending) {
    pending = shiki.loadLanguage(GRAMMARS[language]());
    grammars.set(language, pending);
  }
  return pending;
}

export function languageForPath(filePath: string): string | undefined {
  const name = baseName(filePath).toLowerCase();
  const extension = name.slice(name.lastIndexOf(".") + 1);
  // Own keys only, as `languageForFence`: "a.constructor" is no language.
  return Object.hasOwn(EXTENSIONS, extension) ? EXTENSIONS[extension] : undefined;
}

export function isMarkdown(filePath: string): boolean {
  return languageForPath(filePath) === "markdown";
}

/** A Markdown fence's info string, a grammar's name ("typescript") or an extension ("ts"). */
export function languageForFence(info: string): string | undefined {
  const name = info.trim().split(/\s/)[0].toLowerCase();
  // Own keys only: `in` would take "constructor" for a grammar.
  return Object.hasOwn(GRAMMARS, name) ? name : Object.hasOwn(EXTENSIONS, name) ? EXTENSIONS[name] : undefined;
}
