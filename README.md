<p align="center">
  <img src="src/renderer/icon.png" alt="TET" width="128" />
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
  <a href="https://github.com/samil-kale/tet/releases/latest"><strong>Download</strong></a> &bull;
  <a href="#get-started"><strong>Build from source</strong></a>
</p>

---

## Lightweight by design

Use Claude Code, Codex, OpenCode or Pi, or all four together.

TET deliberately does only a few things. Tasks that take one or two clicks belong in TET.
For everything else, you have an agent or a shell. The agent does the work; Git is for navigation
and control.

TET gives you the real agent CLIs, with a few quality-of-life features around them. It never
changes your agents' configuration or installs plugins.

---

<p align="center">
  <img src="docs/tet.gif" alt="TET; terminals and git for several projects at once" width="860" />
</p>

---

## Why

tldr: IDEs are dead. Why show the code when the prompt is the thing you are working with?

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
  an agent session.
- The git pane handles branches, fetch, pull, push, commit, discard and `.gitignore`. A changed
  file opens in a full-window diff with visual image changes, expandable context and a small
  Monaco editor. Repositories can be cloned from GitHub or GitLab.
- Desktop notifications and project marks point to sessions that need attention.
- `tet-ctl` lets an agent inspect the workspace and git state, manage projects and tabs, run saved
  commands, change TET's settings and read recent shell context.
- A project can run **Claude Code**, **OpenCode**, **Codex CLI** or **Pi** in a Docker sandbox.

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

TET requires **`git`** on your `PATH`. It also needs either a supported agent on the host
(Claude Code, OpenCode, Codex CLI or Pi) or **`sbx`**. `sbx` alone is enough.
A startup check tells you if anything is missing.

---

## Contributing

Issues and pull requests are welcome. [CLAUDE.md](CLAUDE.md) contains the notes used when working
on the codebase. Before opening a pull request, run `npm run typecheck`, `npm run lint` and
`npm test`. App tests on Linux require a display such as `xvfb-run`.

## License

[MIT](LICENSE)
