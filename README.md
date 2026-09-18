<p align="center">
  <img src="src/renderer/assets/icon.png" alt="TET" width="128" />
</p>

<p align="center"><em>"Welcome home, Jack."</em></p>

<h1 align="center">TET</h1>

<p align="center">
  <strong>An agent IDE.</strong>
</p>

<p align="center">
  <a href="https://github.com/samil-kale/tet/releases/latest"><img src="https://img.shields.io/github/v/release/samil-kale/tet?style=flat-square&color=blue" alt="Release"></a>
  <a href="https://github.com/samil-kale/tet/actions/workflows/build.yml"><img src="https://img.shields.io/github/actions/workflow/status/samil-kale/tet/build.yml?style=flat-square&label=build" alt="Build"></a>
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey?style=flat-square" alt="Platform">
</p>

<p align="center">
  <a href="#install"><strong>Install</strong></a> &bull;
  <a href="#get-started"><strong>Build from source</strong></a>
</p>

---

## Lightweight by design

Use Claude Code, Codex, OpenCode or Pi, or all four together.

TET deliberately does only a few things. Tasks that take one or two clicks belong in TET.
For everything else, you have an agent or a shell. The agent does the work; Git is for navigation
and control. TET gives you the real agent CLIs, with a few quality-of-life features around them.

**TET never changes your agents' configuration**

---

<p align="center">
  <img src="docs/tet.gif" alt="TET; terminals and git for several projects at once" width="860" />
</p>

---

## Why

**TLDR**: IDEs are dead. Why show the code when the prompt is the thing you are working with?

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

## What it does

- **Claude Code**, **OpenCode**, **Codex CLI** and **Pi** run in terminal tabs. TET
  shows when a turn is working, waiting or finished out of sight.
- A project's terminals can be split into up to four panes. Files and images can be dropped into
  an agent session. So you can burn through tokens even faster.
- The git pane handles branches, fetch, pull, push, commit, discard and `.gitignore`. A changed
  file opens in an editor tab as an inline diff you can edit.
- Desktop notifications and project marks point to sessions that need attention. Because let's be
  real: you're watching YouTube.
- With the `tet-ctl` interface, your agent can control TET autonomously. So you can watch even more
  YouTube.
- A project can run **Claude Code**, **OpenCode**, **Codex CLI** or **Pi** in a Docker sandbox.
  This won't stop AI from taking over the world, but at least you can say you tried.

---

## Worktrees for parallel work

Yes, yes... of course it supports worktrees. Why wouldn't it?
Create a Git worktree from TET when you want an agent to work on a separate branch without
disturbing your current files. The worktree opens as its own project, with its own agent and shell
tabs, while remaining grouped under the main repository in the sidebar.

TET treats the worktree and its branch as one: create, rename and delete them together, then merge
the branch back into the branch it started from. Worktrees live under `~/.tet/worktrees`, outside
your repository, so parallel tasks stay separate without extra clones.

---

## First-class SBX support ([Docker Sandboxes](https://docs.docker.com/ai/sandboxes/))

For when you're paranoid — or the company you work for is...
Enable SBX for a project, and Claude Code, Codex, OpenCode and Pi each run in a persistent, isolated
microVM for that repository.
The agent does not even have to be installed on the host: `sbx` alone is enough.

Sandboxed tabs behave like native TET tabs. Sessions can be resumed, renamed and deleted; turn
marks, desktop notifications and `tet-ctl` continue to work across the sandbox boundary.

**SBX Settings** keeps the boundary explicit and project-specific. Choose which skills, plugins,
instruction files and additional paths enter the sandbox, with read-only or read-write access;
forward development ports; and allow only the network hosts the project needs. The configuration
lives in the repository's `tet.json`.

---

## Get started

### Install

**macOS / Linux**

```sh
curl -fsSL https://raw.githubusercontent.com/samil-kale/tet/development/scripts/install.sh | sh
```

**Windows** (PowerShell)

```powershell
irm https://raw.githubusercontent.com/samil-kale/tet/development/scripts/install.ps1 | iex
```

Then start TET from the Start menu, the desktop icon, or by typing `tet`.

The script installs TET for your user alone: `~/Applications/TET.app` on macOS,
`~/.local/share/tet` on Linux, `%LOCALAPPDATA%\Programs\TET` on Windows. Run it again to
reinstall.

### Requirements

TET always requires:

* `git`

In addition, at least one of the following must be available:

* Claude Code
* Codex CLI
* OpenCode
* Pi
* `sbx`

The startup check tells you what is missing.

### Build from source

```bash
git clone https://github.com/samil-kale/tet.git
cd tet
npm install
npm start
```

---

## Contributing

Issues and pull requests are welcome, except those from Hans. Hans can go to hell.
[CLAUDE.md](CLAUDE.md) contains the notes used when working on the codebase. Before opening
a pull request, run `npm run typecheck`, `npm run lint` and `npm test`.
App tests on Linux require a display such as `xvfb-run`.

## License

[MIT](LICENSE)
