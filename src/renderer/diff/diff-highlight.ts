import {
  createHighlighterCore,
  type HighlighterCore,
  type LanguageRegistration,
  type ThemedToken,
  type ThemeRegistration
} from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { resolveTheme, type ThemeDefinition } from "../../shared/themes";
import { buildShikiColors } from "../terminal/theme";
import type { DiffLine, FileDiff } from "../../shared/types";

/** Syntax colors for the diff, through Shiki. Per-token colors are the one thing not from a
 *  --vscode-* variable: a theme assigns them per grammar scope and Shiki hands them back per
 *  token. The theme is the token half of the one picked in Settings (Dark Modern's tokens come
 *  from Dark+, Light Modern's from Light+); its editor-surface colors are patched in `loadTheme`. */
export const THEME = resolveTheme(window.tet.initialTheme).shikiTheme;

/** One import per theme, spelled out: esbuild can only bundle an import whose path it can read
 *  off the call — the same reason GRAMMARS below is a map rather than a template. */
const THEME_MODULES: Record<ThemeDefinition["shikiTheme"], () => Promise<{ default: ThemeRegistration }>> = {
  "dark-plus": () => import("@shikijs/themes/dark-plus"),
  "light-plus": () => import("@shikijs/themes/light-plus")
};

/** Loads `THEME` and patches its editor-surface colors with tet's own --vscode-* values, so
 *  shiki's theme — and monaco's, layered on it in editor.ts — draw tet's chrome. */
async function loadTheme(): Promise<ThemeRegistration> {
  const { default: theme } = await THEME_MODULES[THEME]();
  return { ...theme, colors: { ...theme.colors, ...buildShikiColors() } };
}

/** The grammars tet bundles: what an agent's repository plausibly holds, not all two hundred
 *  Shiki ships, the renderer being one file with no code splitting. Anything missing shows
 *  uncolored. Each is imported lazily — esbuild keeps a dynamic import in its own module and
 *  evaluates it when awaited, so an unopened language costs parse time, not startup. */
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

/** File extension, lowercased, to the grammar that colors it. */
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
/** One load per grammar, kept as the promise so two files of a kind don't race it. */
const grammars = new Map<string, Promise<void>>();

/** The one shiki instance, shared with the editor (see editor.ts): one theme, `THEME`, and
 *  grammars loaded lazily. */
export function highlighter(): Promise<HighlighterCore> {
  core ??= createHighlighterCore({
    themes: [loadTheme()],
    langs: [],
    // The JavaScript engine, not oniguruma: that pulls in a wasm binary, which a single-file
    // bundle can only carry base64-encoded. "forgiving" skips patterns it cannot express.
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

/** The grammar a path's extension colors as — shared by the diff view and the editor. */
export function languageForPath(filePath: string): string | undefined {
  const name = filePath.slice(filePath.lastIndexOf("/") + 1).toLowerCase();
  return EXTENSIONS[name.slice(name.lastIndexOf(".") + 1)];
}

/** A run of lines that were contiguous in one version of the file, and their code. */
interface Block {
  /** Index in the diff's line list for each line of `code`, in order. */
  indices: number[];
  code: string;
}

/** A diff holds fragments of two versions of a file, interleaved: as written, the old and the
 *  new half of a changed line read as consecutive code, which goes wrong wherever a construct
 *  spans lines. So each hunk is tokenized twice, once as the file was and once as it is;
 *  context lines are in both passes and take the colors of the second. */
function blocksOf(lines: readonly DiffLine[]): Block[] {
  const blocks: Block[] = [];
  let old: Block = { indices: [], code: "" };
  let fresh: Block = { indices: [], code: "" };

  const flush = (): void => {
    blocks.push(old, fresh);
    old = { indices: [], code: "" };
    fresh = { indices: [], code: "" };
  };
  const push = (block: Block, index: number, text: string): void => {
    block.code += block.indices.length === 0 ? text : `\n${text}`;
    block.indices.push(index);
  };

  lines.forEach((line, index) => {
    if (line.type === "hunk") {
      // The lines around a hunk header are not adjacent in the file, so nothing carries over.
      flush();
      return;
    }
    if (line.type !== "add") {
      push(old, index, line.text);
    }
    if (line.type !== "del") {
      push(fresh, index, line.text);
    }
  });
  flush();

  return blocks.filter((block) => block.indices.length > 0);
}

/** Colors a diff, one token list per line. Lines the grammar had nothing to say about stay
 *  undefined and render as plain text; undefined means nothing could be colored at all. */
export async function highlightDiff(diff: FileDiff): Promise<(ThemedToken[] | undefined)[] | undefined> {
  const language = languageForPath(diff.path);
  if (!language) {
    return undefined;
  }

  try {
    const shiki = await highlighter();
    await loadGrammar(shiki, language);
    const colored: (ThemedToken[] | undefined)[] = [];
    for (const block of blocksOf(diff.lines)) {
      const { tokens } = shiki.codeToTokens(block.code, { lang: language, theme: THEME });
      // One array per line of the block, but only if the tokenizer split it the way it was
      // joined: a mismatch leaves those lines plain instead of coloring them out of step.
      if (tokens.length === block.indices.length) {
        block.indices.forEach((index, line) => (colored[index] = tokens[line]));
      }
    }
    return colored;
  } catch (error) {
    console.error("[tet] could not highlight the diff:", error);
    return undefined;
  }
}
