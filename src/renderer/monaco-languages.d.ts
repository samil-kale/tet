// monaco-editor ships no declarations for its per-language definitions; `conf` is the one export
// read (see LANGUAGE_CONFIGURATIONS in diff/editor.ts).
declare module "monaco-editor/languages/definitions/*" {
  import type { languages } from "monaco-editor";
  export const conf: languages.LanguageConfiguration;
}
