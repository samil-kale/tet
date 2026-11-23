const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");
// Only `npm test` and `npm run dist` (whose archives CI install-tests) run the tests: a start or a
// watch would rebundle every test file for nothing.
const tests = process.argv.includes("--tests");
const tsconfig = path.join(__dirname, "tsconfig.json");
const dist = path.join(__dirname, "dist");
const distTest = path.join(__dirname, "dist-test");

// esbuild only bundles, it never typechecks: an unimported identifier becomes a global and the app
// dies on load with a ReferenceError. Hence `npm start` runs the typecheck first.
const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  treeShaking: true,
  legalComments: "none",
  tsconfig,
};

/** Everything electron's node runs: main, the utility hosts, preload, the CLIs, the tests. */
const node = { ...common, platform: "node", target: "node22", format: "cjs" };

/** The window's two bundles: the renderer is ES modules, split where it `import()`s; the editor's
 *  worker (a classic one, see editor.ts) stays one script. */
const browser = { ...common, platform: "browser", target: "chrome130" };

/** @type {import('esbuild').BuildOptions} */
const mainConfig = {
  ...node,
  entryPoints: [path.join(__dirname, "src", "main", "main.ts")],
  outfile: path.join(dist, "main.js"),
  // electron (and its original-fs) is provided by the runtime; node-pty is a native addon and
  // cannot be bundled.
  external: ["electron", "original-fs", "node-pty"],
};

/** Fails the build where anything in a bundle imports electron: resolvable as an npm package, it
 *  would be bundled in without a word, whatever eslint.config.mjs's list of files holds. */
/** @type {import('esbuild').Plugin} */
const noElectron = {
  name: "no-electron",
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, ({ importer }) => ({
      errors: [{ text: `${path.relative(__dirname, importer)} imports electron, in a bundle that runs without it` }],
    }));
  },
};

/** A module for a utilityProcess: git's CLI wrapper or the Explorer's walk and search.
 *  These modules run without electron (eslint.config.mjs). */
/** @returns {import('esbuild').BuildOptions} */
function hostConfig(folder, name) {
  return {
    ...node,
    entryPoints: [path.join(__dirname, "src", "main", folder, `${name}-host.ts`)],
    outfile: path.join(dist, `${name}-host.js`),
    plugins: [noElectron],
  };
}

/** The scripts under src/cli, each bundled on its own for plain node, nothing from electron in
 *  them: `tet-ctl`, which an agent runs from a terminal (see src/main/ctl/ctl-launcher.ts), and
 *  `tet-update`, which a new version's binary runs once tet has quit
 *  (src/main/update/auto-update.ts), each under tet's own electron as node. */
/** @returns {import('esbuild').BuildOptions} */
function cliConfig(name) {
  return {
    ...node,
    entryPoints: [path.join(__dirname, "src", "cli", `${name}.ts`)],
    outfile: path.join(dist, `${name}.js`),
  };
}

/** The window's preload under src/preload. */
/** @returns {import('esbuild').BuildOptions} */
function preloadConfig(name) {
  return {
    ...node,
    entryPoints: [path.join(__dirname, "src", "preload", `${name}.ts`)],
    outfile: path.join(dist, `${name}.js`),
    external: ["electron"],
  };
}

/** esbuild emits the CSS of a lazy chunk beside it and nothing loads it: of the chunks, only the
 *  editor's own (monaco-core, which editor.ts links before importing it) has CSS the page needs. The
 *  language definitions carry monaco's shared CSS again; it is dropped, and a lazy chunk with CSS the
 *  page has neither in the entry's nor in monaco-core's fails the build. */
/** @type {import('esbuild').Plugin} */
const lazyCss = {
  name: "lazy-css",
  setup(build) {
    build.onEnd((result) => {
      if (!result.metafile) {
        return;
      }
      // The metafile names a CSS output by its file alone; a chunk's is named like its script.
      const outputs = Object.entries(result.metafile.outputs)
        .filter(([file]) => file.endsWith(".css"))
        .map(([file, output]) => ({ name: path.basename(file), inputs: Object.keys(output.inputs) }));
      const monaco = outputs.find(({ name }) => name.startsWith("monaco-core-"));
      const shown = new Set(outputs.filter(({ name }) => name === "renderer.css" || name === monaco?.name).flatMap(({ inputs }) => inputs));
      for (const { name, inputs } of outputs) {
        if (name === "renderer.css") {
          continue;
        }
        const lost = inputs.filter((input) => !shown.has(input));
        if (lost.length > 0) {
          throw new Error(`${name} is CSS of a lazy chunk nothing loads: ${lost.join(", ")}`);
        }
        if (name === monaco?.name) {
          fs.copyFileSync(path.join(dist, name), path.join(dist, "monaco-core.css"));
        }
        fs.rmSync(path.join(dist, name), { force: true });
        fs.rmSync(path.join(dist, `${name}.map`), { force: true });
      }
    });
  },
};

/** @type {import('esbuild').BuildOptions} */
const rendererConfig = {
  metafile: true,
  plugins: [lazyCss],
  ...browser,
  format: "esm",
  splitting: true,
  entryPoints: { renderer: path.join(__dirname, "src", "renderer", "main.tsx") },
  outdir: dist,
  // Beside the entry, so a font's url in a chunk resolves against the page like the entry's own.
  chunkNames: "[name]-[hash]",
  // monaco's CSS pulls in codicon.ttf, and styles.css the Explorer's seti.woff and the app's fonts;
  // without a loader for them the build fails outright.
  loader: { ".ttf": "file", ".woff": "file", ".woff2": "file" },
};

/** The editor's own web worker (tokenization, etc. off the main thread) — see editor.ts. */
/** @type {import('esbuild').BuildOptions} */
const editorWorkerConfig = {
  ...browser,
  entryPoints: [require.resolve("monaco-editor/editor/editor.worker.js")],
  format: "iife",
  outfile: path.join(dist, "editor.worker.js"),
};

/** The tests, for node's own runner (`npm test`). Bundled like the CLI, so a test imports the
 *  source the way the app does, without a loader of its own. */
/** @type {import('esbuild').BuildOptions} */
const testConfig = {
  ...node,
  // test/ mirrors src/ (main/, renderer/, shared/) plus e2e/, and dist-test/ mirrors test/.
  entryPoints: [path.join(__dirname, "test", "**", "*.test.ts")],
  outbase: path.join(__dirname, "test"),
  outdir: distTest,
  // node-pty (native) cannot be bundled; esbuild finds its own binary relative to its package, and
  // main/agents.test.ts compiles pi's generated extension with it. electron is a stub: node's runner
  // has none (helpers/ finds the binary through its own require).
  alias: { electron: "./test/helpers/electron-stub.js", "original-fs": "node:fs" },
  external: ["node-pty", "esbuild"],
};

function copyStaticAssets() {
  fs.mkdirSync(dist, { recursive: true });
  fs.copyFileSync(path.join(__dirname, "src", "renderer", "index.html"), path.join(dist, "index.html"));
  for (const file of ["icon.png", "icon.ico"]) {
    fs.copyFileSync(path.join(__dirname, "src", "renderer", "assets", file), path.join(dist, file));
  }
  // The OFL lets the fonts ship only with their license.
  for (const file of ["Inter-OFL.txt", "JetBrainsMono-OFL.txt"]) {
    fs.copyFileSync(path.join(__dirname, "src", "renderer", "assets", "fonts", file), path.join(dist, file));
  }
}

async function build() {
  // What electron-builder packages is dist/ whole (electron-builder.yml's `files`), so a production
  // build must not carry a development build's source maps along.
  if (production) {
    fs.rmSync(dist, { recursive: true, force: true });
  }
  // `npm test` runs every file in dist-test/, so a test deleted or renamed in test/ must not keep
  // running from its old build.
  if (tests) {
    fs.rmSync(distTest, { recursive: true, force: true });
  }
  copyStaticAssets();

  const configs = [
    mainConfig,
    hostConfig("git", "git"),
    hostConfig("git", "explorer"),
    cliConfig("tet-ctl"),
    cliConfig("tet-update"),
    preloadConfig("preload"),
    rendererConfig,
    editorWorkerConfig,
    ...(tests ? [testConfig] : []),
  ];
  if (watch) {
    const contexts = await Promise.all(configs.map((config) => esbuild.context(config)));
    await Promise.all(contexts.map((context) => context.watch()));
  } else {
    await Promise.all(configs.map((config) => esbuild.build(config)));
  }
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
