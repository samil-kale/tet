import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/dist-test/**", "**/node_modules/**"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module"
      }
    }
  },
  // The process borders, as lint rules rather than prose (see "Agent-specific vs shared code" in
  // CLAUDE.md): each folder under src/ is one process, and `shared/` the only thing they may
  // import from one another. A violation here used to surface at runtime — a `ReferenceError`
  // in the git utility process, an electron require in the CLI bundle — or not at all.
  {
    files: ["src/renderer/**", "src/preload/**", "src/cli/**", "src/shared/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["**/main", "**/main/**"], message: "Main-process code; go through src/shared." }
          ]
        }
      ]
    }
  },
  {
    // The git utility process (git-host.ts) and the CLI run without electron; `shared/` runs in
    // every process. None of them may import it, and the first two may import nothing from the
    // rest of main either — git-client.ts is the main-process side of that boundary.
    files: ["src/main/git/git.ts", "src/main/git/git-host.ts", "src/cli/**", "src/shared/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [{ name: "electron", message: "Runs outside electron's main process." }],
          patterns: [
            // A regex, since glob negation does not take a `..` segment: anything one or two
            // levels up that is not `shared`.
            { regex: "^\\.\\./(?!shared(/|$))(?!\\.\\./shared(/|$))", message: "Only src/shared and this folder." }
          ]
        }
      ]
    }
  },
  {
    files: ["**/esbuild.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        require: "readonly",
        module: "readonly",
        __dirname: "readonly",
        process: "readonly",
        console: "readonly"
      }
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off"
    }
  }
);
