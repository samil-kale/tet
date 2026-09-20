/**
 * Generates src/renderer/files/file-icons.ts, the Explorer's file marks, and copies Seti's font
 * beside it as src/renderer/files/seti.woff:
 *
 *   node scripts/file-icons.js <VS Code's resources/app>
 *
 * The marks are Seti's — VS Code's default file icon theme, read from the installation along with
 * the language each built-in extension claims a file for, since Seti maps most files by language
 * id. They are resolved the way VS Code resolves an icon theme: the file name, then each extension
 * from the longest, then the language. A mark is a glyph of Seti's font and its color, named by
 * Seti's palette; a file Seti leaves on its default icon gets no mark, and a Seti grey or white is
 * a mark in its own color.
 *
 * Re-run it on a VS Code upgrade and read the diff.
 */
const fs = require("node:fs");
const path = require("node:path");

const [vscodeApp] = process.argv.slice(2);
if (!vscodeApp) {
  console.error("usage: node scripts/file-icons.js <VS Code's resources/app>");
  process.exit(1);
}
const extensions = path.join(vscodeApp, "extensions");
const outDir = path.join(__dirname, "..", "src", "renderer", "files");

/** Seti's palette to the color classes styles.css draws in the theme's terminal colors. */
const PALETTE = {
  "#519aba": "blue",
  "#8dc149": "green",
  "#cbcb41": "yellow",
  "#e37933": "orange",
  "#cc3e44": "red",
  "#a074c4": "purple",
  "#f55385": "pink"
};

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const lowerKeys = (map) => Object.fromEntries(Object.entries(map ?? {}).map(([key, value]) => [key.toLowerCase(), value]));

const setiDir = path.join(extensions, "theme-seti", "icons");
const seti = readJson(path.join(setiDir, "vs-seti-icon-theme.json"));
const setiTheme = { names: lowerKeys(seti.fileNames), extensions: lowerKeys(seti.fileExtensions), languages: seti.languageIds };

// The language each built-in extension claims a file for, by name or by extension; the first
// claim wins. `filenamePatterns` are not read.
const languageNames = {};
const languageExtensions = {};
for (const dir of fs.readdirSync(extensions)) {
  const manifest = path.join(extensions, dir, "package.json");
  if (!fs.existsSync(manifest)) {
    continue;
  }
  for (const language of readJson(manifest).contributes?.languages ?? []) {
    for (const name of language.filenames ?? []) {
      languageNames[name.toLowerCase()] ??= language.id;
    }
    for (const extension of language.extensions ?? []) {
      languageExtensions[extension.toLowerCase().replace(/^\./, "")] ??= language.id;
    }
  }
}

/** Every extension VS Code tries for a name, longest first: `a.spec.ts` is `spec.ts`, then `ts`. */
function suffixes(name) {
  const segments = name.split(".");
  return segments.slice(1).map((_, index) => segments.slice(index + 1).join("."));
}

function languageOf(name) {
  return languageNames[name] ?? suffixes(name).map((suffix) => languageExtensions[suffix]).find(Boolean);
}

function iconOf(name) {
  const byExtension = suffixes(name).map((suffix) => setiTheme.extensions[suffix]).find(Boolean);
  const language = languageOf(name);
  return setiTheme.names[name] ?? byExtension ?? (language && setiTheme.languages[language]);
}

/** [glyph, color?], or null for no mark. */
function markOf(name) {
  const icon = iconOf(name);
  if (!icon || icon === seti.file) {
    return null;
  }
  const { fontCharacter, fontColor } = seti.iconDefinitions[icon];
  // `\E001`, CSS's escape, as the character itself.
  const glyph = String.fromCodePoint(parseInt(fontCharacter.slice(1), 16));
  const color = PALETTE[fontColor?.toLowerCase()];
  return color ? [glyph, color] : [glyph];
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The tables hold only what the lookup could not work out from a shorter key: an extension whose
// mark differs from its next shorter extension's, a name whose mark differs from its extensions'.
const fileExtensions = new Map();
const firstExtension = (candidates) => {
  const suffix = candidates.find((candidate) => fileExtensions.has(candidate));
  return suffix === undefined ? null : fileExtensions.get(suffix);
};
const byExtensions = (name) => firstExtension(suffixes(name));
const allExtensions = new Set([...Object.keys(setiTheme.extensions), ...Object.keys(languageExtensions)]);
for (const extension of [...allExtensions].sort((a, b) => a.split(".").length - b.split(".").length)) {
  const mark = markOf(`x.${extension}`);
  if (!same(mark, firstExtension(suffixes(`x.${extension}`).slice(1)))) {
    fileExtensions.set(extension, mark);
  }
}
const fileNames = new Map();
const allNames = new Set([...Object.keys(setiTheme.names), ...Object.keys(languageNames)]);
for (const name of allNames) {
  const mark = markOf(name);
  if (!same(mark, byExtensions(name))) {
    fileNames.set(name, mark);
  }
}

// The lookup Explorer.tsx does, checked against the full resolution on every key read.
const lookup = (name) => (fileNames.has(name) ? fileNames.get(name) : byExtensions(name));
for (const name of [...allNames, ...[...allExtensions].flatMap((extension) => [`x.${extension}`, `.${extension}`, `a.b.${extension}`])]) {
  if (!same(lookup(name), markOf(name))) {
    throw new Error(`the tables disagree with the resolution for ${name}`);
  }
}

/** A mark as source text, its glyph escaped: a private-use character reads as nothing in an editor. */
const markSource = (mark) =>
  mark === null
    ? "null"
    : `[${mark.map((part, index) => (index === 0 ? `"\\u${part.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}"` : JSON.stringify(part))).join(", ")}]`;

const vscodeVersion = readJson(path.join(vscodeApp, "package.json")).version;
const sorted = (map) => [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

const lines = [
  `// Generated by scripts/file-icons.js from VS Code ${vscodeVersion}'s Seti theme and language list. Do not`,
  "// edit; re-run the script.",
  "//",
  "// Seti (github.com/jesseweed/seti-ui): MIT.",
  "",
  `export type FileMarkColor = ${[...new Set(Object.values(PALETTE))].map((color) => JSON.stringify(color)).join(" | ")};`,
  "",
  "/** A glyph of seti.woff, and its color if Seti gives it one. */",
  "export type FileMark = readonly [glyph: string, color?: FileMarkColor];",
  "",
  "/** Lowercased extension, without its leading dot, to its mark; null for none. */",
  "export const FILE_EXTENSIONS: Record<string, FileMark | null> = {",
  ...sorted(fileExtensions).map(([key, mark], index) => `  ${JSON.stringify(key)}: ${markSource(mark)}${index < fileExtensions.size - 1 ? "," : ""}`),
  "};",
  "",
  "/** Lowercased file name to its mark, where it differs from its extensions'; null for none. */",
  "export const FILE_NAMES: Record<string, FileMark | null> = {",
  ...sorted(fileNames).map(([key, mark], index) => `  ${JSON.stringify(key)}: ${markSource(mark)}${index < fileNames.size - 1 ? "," : ""}`),
  "};",
  ""
];
fs.writeFileSync(path.join(outDir, "file-icons.ts"), lines.join("\r\n"));
fs.copyFileSync(path.join(setiDir, "seti.woff"), path.join(outDir, "seti.woff"));
console.log(`${fileExtensions.size} extensions, ${fileNames.size} names`);
