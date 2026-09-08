<p align="center">
  <img src="src/renderer/icon.png" alt="TET" width="128" />
</p>

<p align="center"><em>"Welcome home, Jack."</em></p>

<h1 align="center">TET</h1>

<p align="center">
  <strong>A desktop workspace for coding agents.</strong>
</p>

<p align="center">
  <a href="https://github.com/samil-kale/tet/releases/latest"><img src="https://img.shields.io/github/v/release/samil-kale/tet?style=flat-square&color=blue" alt="Release"></a>
  <a href="https://github.com/samil-kale/tet/actions/workflows/build.yml"><img src="https://img.shields.io/github/actions/workflow/status/samil-kale/tet/build.yml?style=flat-square&label=build" alt="Build"></a>
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey?style=flat-square" alt="Platform">
  <img src="https://img.shields.io/badge/built%20with-Electron%20%2B%20React%20%2B%20xterm.js-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron">
</p>

<p align="center">
  <a href="https://github.com/samil-kale/tet/releases/latest"><strong>Download</strong></a> &bull;
  <a href="#get-started"><strong>Build from source</strong></a> &bull;
  <a href="CLAUDE.md"><strong>Architecture notes</strong></a>
</p>

---

<p align="center">
  <img src="docs/tet.gif" alt="TET; terminals and git for several projects at once" width="860" />
</p>

---

## Why

I've spent more than 15 years working in IDEs, usually with a clear favourite. But as coding
agents became part of my workflow, I spent less time editing code directly and more time moving
between agent sessions. The editor became a place to review the result, mostly through the git
diff.

That created a different set of problems. Which session just finished? Which one is waiting for
an answer? Which project should I review next?

TET is built around that workflow. It keeps agents, terminals and repository state visible in
one place, tells you when a session needs attention, and keeps the diff one click away. It also
handles the small things that are awkward in a plain terminal, such as dropping files and images
straight into an agent session.

---

## Features

### Real terminals, several agents

**Claude Code**, **opencode**, **Codex CLI** and **pi** run as first-class terminal tabs. These are
the actual CLIs in real ptys, not wrapped chat interfaces. TET uses each agent's own session state
to show whether a turn is **working**, **waiting for an answer**, or **finished out of sight**.
You can list, resume, rename and delete previous sessions from the tab menu, drop files or images
onto a terminal, and Ctrl-click paths in the output to open them.

### Multiple terminals, one glance

Split a project's terminals into up to four panes. Drag a tab to a snap zone to create a split;
empty panes collapse automatically. Keep an agent, a development server and a shell visible at
the same time instead of cycling through tabs.

### The git pane

Open the git pane from the tab strip to keep the repository and a terminal on screen together.
Check out branches, fetch, pull, push, commit all changes, discard files and update `.gitignore`
without leaving the workspace. You can also clone repositories from GitHub or GitLab.

### A diff dialog that's also an editor

Double-click a changed file or Ctrl-click a path in a terminal to open it in a full-window diff.
Image changes are shown visually, and hidden context can be expanded on demand. The same view
includes a lightweight Monaco editor for quick fixes without leaving TET.

### Notifications you can act on

Get a desktop notification when a turn finishes or needs input. Project rows keep the same state
visible inside TET, so you can immediately find sessions that are **waiting** or **finished out
of sight**.

### Saved commands per project

Save project-specific commands in the sidebar and run them in their own terminal tabs. Commands
are stored in `tet.json` at the repository root, so they can travel with the project and be
committed.

### An agent can drive TET

Every terminal tab has access to `tet-ctl`, a small CLI for controlling the surrounding app. An
agent can inspect open projects and their git state, manage projects and terminal tabs, run saved
commands, and read or change TET's settings. It also receives the path to the project's shell
context, so recent terminal output does not have to be copied into the prompt.

### Sandboxed agents

Enable a Docker sandbox for any project from **SBX Settings**. **Claude Code** and **Codex** then
run inside the container while keeping the same tabs, turn tracking and notifications. You
control which folders are available and can include your skills, plugins and instruction files.
Authentication stays inside the sandbox, so no agent credentials or trust settings are shared
with the host.

---

## Get started

### Download

**[Download the latest release](https://github.com/samil-kale/tet/releases/latest)** for Windows,
Linux (AppImage or `.deb`) or macOS. Windows and AppImage builds install updates when you quit the
app. Updates are never forced while terminal sessions are running.

### Build from source

```bash
git clone https://github.com/samil-kale/tet.git
cd tet
npm install
npm start
```

### Requirements

TET requires **`git`** on your `PATH` and **at least one supported agent**: Claude Code,
opencode, Codex CLI or pi. A startup check tells you if anything is missing.

---

## How it works

TET is built with Electron, React and xterm.js. It uses your local `git` CLI in a separate process
instead of reimplementing git, so repository operations do not interfere with terminal input.

Agents run as their real CLIs in real ptys. TET does not infer their state from terminal output;
each agent reports its turns through its own integration.
**Your Claude Code, Codex, opencode and pi configuration is never read or modified.**

## Contributing

Issues and pull requests are welcome. Before opening a pull request, run `npm run typecheck`,
`npm run lint` and `npm test`. App tests on Linux require a display such as `xvfb-run`.

## License

[MIT](LICENSE)
