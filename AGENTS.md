# AGENTS.md

## What this is

TET is a git workspace for coding agents: Electron + React + xterm.js, several repositories open
at once, each with its own git pane and its own agent and shell terminals. Git is for navigation
and control of the repository state; the work happens in the terminals, so anything git can't do
in two clicks belongs in an agent or a shell, not in a new dialog.

This file holds rules of conduct, cross-file invariants and where things live. A reason that fits
one file is a comment at that site, not an entry here. Adding here means cutting.

References: **GitHub Desktop** for the git half (shapes, not scope); **VS Code** for the UI —
classic layout, Dark Modern's palette, tab semantics, theme names; **Monaco** for the editor tab.

## Do not restart the app yourself

Agents run *inside* TET, as terminal tabs; killing the Electron process kills your own session.
Build and typecheck freely, but ask the user to restart — and before anything that tears down a
project's terminals.

## Where things live

- `src/` is one folder per process — `main/`, `renderer/`, `preload/`, `cli/` — plus `shared/`,
  the only folder imported across them (`no-restricted-imports` in `eslint.config.mjs`).
- `src/main/`: `git/` (the git process and everything talking to it),
  `terminals/` (pty, sessions, hooks), `control/` (`tet-ctl`), `ipc/` (one registrar per `TETApi`
  group, each taking only the singletons it touches), `agents/`, `providers/`; flat is the app
  itself — window, settings, sbx.
- `src/renderer/`: `terminal/` (xterm, split view, link providers), `git/` (the side pane's git
  view), `files/` (its other one: the Explorer tree, the SEARCH pane, Seti's file icons),
  `diff/` (the editor tab: monaco + shiki), `sidebar/`, `dialogs/`, `ui/`; flat is the shell —
  `App`, `Startup`, the stylesheets, `shortcuts.ts`.
- Each agent is a folder under `src/main/agents/`, described by one `AgentDefinition` (`agent.ts`
  documents every field). Shared code imports only the registry (`agents/index.ts`) and that type.
  A new agent is a new folder, one registry entry, and one case in `AgentIcon`
  (`src/renderer/ui/agent-icons.tsx`, the only agent-specific code outside `agents/`).
- `tet.json` in a repository's root describes the project and travels with it: saved `commands`,
  the Explorer view and `sbx`. Read defensively (`src/main/tet-json.ts`): missing or malformed
  means nothing configured.

## Never assume the agents behave alike

Claude Code, Codex, opencode and pi are four products in the same kind of tab, alike in nothing:
readiness, how Ctrl+C quits, the right mouse button, colors, turn signals, resize redraw. So
anything about how a CLI is driven is an `AgentDefinition` field with a value per agent,
**measured through this same pty** — never taken from docs, source or another agent — and
commented there with the measurement.

## Never touch the user's agent configuration

Everything TET generates lives under `~/.tet` (`data-root.ts`) and is pointed at from outside.
`prepareSpawn` and `prepareSandboxSpawn` are the only places an agent writes anything.

- Claude Code: a generated `--settings` file; never `~/.claude/settings.json`.
- Codex: `-c key=value` for that one process; never `~/.codex/config.toml` or `hooks.json`.
- opencode: `OPENCODE_CONFIG_DIR` (additive) and `OPENCODE_TUI_CONFIG`; never an `opencode.json`.
- pi: a generated extension via `-e`; never `PI_CODING_AGENT_DIR`.

## Cross-platform

Must work on Windows, Linux and macOS; no OS-specific behaviour without an equivalent for the
others.

- Paths through `path.join`; every spawn through `resolveCommand` (`src/main/terminals/pty.ts`),
  never a shell.
- A generated file PowerShell reads gets a UTF-8 BOM; a generated `sh` script is LF; anything
  written into a script is quoted with `shellSingleQuote` (`src/main/script-text.ts`).
- A hook command runs under whichever shell the agent picks: keep it a bare
  `tet-ctl hook <event>`.
- A file another process reads (hook settings, opencode records) is written beside the target and
  renamed into place.

## Git

- Git is never reimplemented and never run from the renderer. `src/main/git/git.ts` wraps the CLI
  in its own `utilityProcess` (`git-host.ts`, via `git-client.ts`): nothing there imports electron,
  everything crossing the boundary survives a structured clone.
- Starting git is the cost, so count invocations: anything added to the refresh path must earn its
  process (the budget is commented in `repository.ts`).
- `Repository` is the single source of truth for the git pane and the terminals; every action goes
  through `Repository.runAction` (renderer: `BranchActions.run`).
- Remote commands run with `NETWORK_ENV`. **TET writes into no credential helper itself**: a login
  typed into tet reaches git through askpass (`GitLoginStore.run`), and git stores it in the
  user's helper; where there is none, tet keeps it sealed in `~/.tet/git-logins.json`.
- tet never diffs: it hands monaco's inline diff editor two texts (`Repository.readFile`).
- A linked worktree is a project of its own, indented under its main worktree's row
  (`Project.mainPath`) and listed in the branch tree's WORKTREES (`RepositoryState.worktrees`) —
  both read off the disk, never stored. A worktree and its branch are one: made together at the
  default branch, named, renamed and deleted together, and never switched. Its base is tet's own
  `branch.<name>.base` (`git.ts`'s `worktreeAdd`); tet creates worktrees in `~/.tet/worktrees`
  (`projects.ts`, `sbx.ts`).

**Scope.** Everything the git pane does fits in a context menu, an icon button or a question. Of
that, GitHub Desktop's set: the branch tree (branches, remotes, tags, stashes), checkout, per-file
diff, discard, `.gitignore`, fetch/pull/push, commit of all changes or the selection, stash of all,
worktrees (add, rename, delete), clone (GitHub/GitLab via `GitProvider`). Where Desktop differs
from git's defaults, follow Desktop. The project row's entries are repository-wide and never touch
the working tree — a worktree's own row excepted, which is that tree.

Don't add without being asked: staging or per-line staging, history or graph, cherry-pick, revert,
squash, reorder, bisect, submodules, conflict resolution beyond aborting, side-by-side text diff,
discarding single lines, pull with rebase, force push. A command needing a list, a message field
or a per-line decision is for an agent.

## UI rules

- **Layout**: projects in the left sidebar; the tab strip is one project's terminals plus its
  editor tabs — VS Code's preview rule, one preview tab per project (`editor-tab.ts`). Git and
  files are not tabs but one side pane toggled from the strip.
- **Split view**: up to four panes in fixed presets, reached only by dragging a tab onto a snap
  zone. Every rule is in `src/renderer/terminal/pane-layout.ts`, the state in `App`.
- **Everything the user is told is a notice** — `notify()` (`src/renderer/ui/Notices.tsx`; main
  sends `app:notice`) — **unless a dialog on screen says it** (below). No other view keeps a
  message of its own; a status (marks, progress bar) is not a notice.
- **Every question is `confirm`/`prompt` from `Dialog.tsx`**, asked by the view offering the
  action; the main process asks nothing, no native dialogs. Ask only before something
  irreversible. Card dialogs are drawn in `DialogFrame`. The one exception: an agent's
  `env-request`, answered in `EnvDialog`, one at a time (`environment.ts`).
- **A dialog on screen says what concerns it; prefer this to a notice.** Words alone, no mark,
  coloured by what it is. A failure belongs where the answer was typed: under that field
  (`Field`'s `error`); in a row of a list as the error mark's tooltip beside it (`RowMark`, the
  one mark); else left in the button row, level with the buttons (`DialogFrame`'s `error`) where
  the fields are several or across tabs — what was typed is held so it can be corrected, and it
  is git's own words for a name it will not take, never tet's guess at them.
  What the unsaved edits as a whole lead to goes in the same place (`DialogFrame`'s `message`),
  e.g. `RestartNote` while they reach running tabs only once restarted. A notice is for what has
  no dialog up to carry it; a `confirm`
  has no field, so it notifies.
- To get this, **a question runs its own answer** (`PromptOptions.submit`): the dialog stays up
  while the action runs, so what runs it hands the failure back instead of notifying it
  (`git/run-action.ts`). A new verb a dialog calls answers its failure rather than sending
  `app:notice`.
- **Nothing is written until Save**; Cancel and Escape drop edits. A setting reaches an agent at
  its setup (`AgentPaths`), so it applies to projects opened afterwards.
- **One progress indicator per pane** (`ProgressBar.tsx`): a new slow reason feeds the existing
  bar. In a dialog that bar is `DialogFrame`'s `busy`, so a busy state held by a nested view is
  lifted to the view owning the frame.
- **The keyboard belongs to the terminal**: tet's key handler runs before xterm and takes nothing
  an agent could have received. Check every new shortcut against `src/renderer/shortcuts.ts`. No
  window shortcut closes a tab.
- **The renderer**: terminal output never goes through React state — xterms and editors live
  outside React (`terminal-views.ts`, `editor-views.ts`). The views under `App` are memoized: hand
  them stable props (`useCallback`, `useMemo`, `identity.ts`).
- **Anything that changes the box xterm measures refits the pty**: hide with `visibility`, frame
  with an overlay, resize only once dragging settles.

### Look

- Colors only from `--vscode-*` variables under VS Code's own names (`src/renderer/themes/`),
  except shiki's syntax colors. A theme is one stylesheet plus an entry in `src/shared/themes.ts`.
- A color VS Code has no name for is a `--tet-*` variable, always used with its `--vscode-*`
  fallback and set only by the theme that needs it — the exception, not the way to theme.
- Shared sizes are stated once, in `styles.css`'s `.app`; check the neighbouring view before
  inventing one.
- Icons come from Lucide first (`icons.tsx`). The Explorer's file icons are generated by
  `scripts/file-icons.js` — re-run, never edit.
- Icons and marks are monochrome. The one accent is `--vscode-focusBorder`, 1px for anything that
  marks or points. Exceptions: git status letters, the error mark, the Explorer's file icons.
- Row hover is `--vscode-list-hoverBackground`, action button hover
  `--vscode-toolbar-hoverBackground`.
- When two things that should look identical don't, measure them (`getComputedStyle` on the built
  stylesheet) instead of guessing.

## Turns and session marks

A tab and its project row show *working* (spinner), *waiting for an answer* (question mark) or
*finished out of sight* (speech bubble); on a tab they replace the agent icon, ranked error/missing
> waiting > working > finished.

- **Nothing is read off the terminal or a file.** Every agent reports its turn over the control
  channel as `tet-ctl hook <event>`, addressed by `TET_TAB_ID`: Claude Code and Codex as a hook
  command, opencode's plugin and pi's extension by posting the same request.
- The main process sets the state (`ProjectSessionManager.hookEvent`); the renderer decides what is
  shown and clears what was seen (`App.markedTabs`).
- A session is asked to quit (`quitPresses`) before it is killed — a hard kill skips a CLI's exit
  handlers.

## The control channel: `tet-ctl`

Lets an agent ask the app for what the filesystem and git can't give (theme, projects, tabs). A
second transport onto the logic behind `ipc.ts`, never a second implementation. Contract and
verbs: `src/shared/control.ts`; server: `src/main/control/control-server.ts`; CLI:
`src/cli/tet-ctl.ts`.

- `restart-app` passes `--confirm` only when the user asked. `restartRequired` is relayed to the
  user, never acted on.
- Agents learn of `tet-ctl` once per session: `systemPrompt`
  (`src/main/agents/system-prompt.ts`), appended to each agent's system prompt, never replacing the
  user's instructions.
- **Environment variables** (`src/main/environment.ts`): tokens and passwords an agent needs, typed
  only into TET's dialog (`env-request`), never the chat; kept encrypted by `safeStorage`, global, and
  set in every tab at its start (`buildEnv`), over what the machine sets itself — said in a notice.
  A running tab takes them up only when restarted: the dialog's Save restarts the asking one.
  None in a sandbox, and the verbs refused *and* unmentioned there — not in `help`, not in its
  system prompt.
- A caller's project and tab ids count only with the token made for them
  (`control-token.ts`): a terminal gets its tab's token, never the run's.
- `tabs-send` and `tabs-output` answer only for a tab of the caller's own project
  (`ownProjectOnly`). `tabs-send` never from inside a sandbox; `tabs-output` does, host tabs of
  that project included — by design.
- **Direction of travel**: every setting in `settings-get` becomes settable through `tet-ctl`. A
  new or extended setting comes with an *offer* to add its verb (`ControlVerb` entry, handler,
  `control.test.ts` case) — the user decides what an agent may change.

## sbx: agent tabs in a Docker sandbox

Opt-in per project (`sbx` in `tet.json`), for every agent but the shell. `src/main/sbx.ts` drives
the `sbx` CLI; its comments are the record of what was measured.

- **Never falls back to the host**: when sbx isn't ready, a sandboxed tab stays in `error` — the
  host would bypass an organization's policy.
- **sbx alone is enough**: an agent missing on the host still starts in the sandbox
  (`AgentRuntime.sbxOnly`).
- The sandbox never sees the agent's own config directory; sessions are read through host mounts,
  so the same listing code serves both.
- Generated setup targets where it runs, not `process.platform` (`HookTarget`).
- **tet.json holds what was applied.** Save checks each row against sbx's policy (hosts through
  `sbx policy check`, paths and knowledge through the rules `sbx-policy.ts` evaluates) and against
  this machine (a path exists, a port is free, a value is stored). A row that fails, or that sbx
  refuses while applying, is neither saved nor applied; the rest goes through. One check for the
  dialog, `sbx-set-*` and a session's start (`readSbxProblems`).
- **The dialog checks live** whatever can be checked, and marks a failing row with the error mark
  saying what is wrong — never that it will not be saved.
- **A session's start applies tet.json as it stands and never writes it.** What the policy forbids
  or this machine lacks is skipped and told in one notice per dialog tab, its rows listed
  (`Couldn't set hosts:` … `Forbidden by governance`): how a user learns that governance took over.

## Startup

`src/main/requirements.ts` checks git, the agents and sbx before the workspace opens; with none
available, `RequirementsDialog` is a wall and **installs nothing**. `process.env.PATH` is rewritten
before that check (`augmentAgentPath`) and everything spawned inherits it.

## npm scripts

- `npm run compile`, `npm run typecheck`, `npm run lint`
- `npm test` — compile, then node's test runner over `dist-test/`, one file per seam; nothing looks
  into the window. `app.test.ts` starts the real app on a throwaway profile (needs a display,
  `xvfb-run` on Linux); `install.test.ts` runs only with `TET_INSTALL_TEST=1` (it writes shortcuts
  and the PATH entry for the account).
- `npm start` — typecheck, compile, launch (see "Do not restart the app yourself").
  `--simulate=git,claude` shows the requirements dialog, `--simulate=sbx-mode` a machine with
  only git and sbx; `--user-data-dir=<dir>` gives a run its own profile.
- `npm run dist` — package this platform's archives into `release/`.
- The Linux side is testable from Windows in WSL: clone onto the Linux filesystem, `npm install`
  there, drive the app through `tet-ctl`.

## Releasing

When asked for a release, run it:

0. Ask the user for the version number (AskUserQuestion) — never pick patch/minor/major yourself;
   a published version can't be taken back once an install has updated to it.
1. Write the release's section at the top of `CHANGELOG.md` — `## <version> (<date>)`, then a
   handful of bullets, read off `git log <last tag>..HEAD`: a bold title of a few words, then one
   or two short sentences. **Written against the last release, not against the commits**: a
   feature born and refined since the tag is one bullet saying it is there, never the steps it
   took. Few bullets: only what a user would notice, the smaller repairs gathered in a closing
   **Fixes** bullet. Out entirely: refactors, docs, fixes to unreleased work, agent version bumps,
   keyboard and menu details. Commit it on its own (`changelog for <version>`), before
   `npm version`, which refuses a dirty tree.
   A section is its GitHub Release's notes, so a release edited by hand there is copied back into
   `CHANGELOG.md`: the published notes are the text, tet's file follows.
2. `npm version patch` (or `minor` / `major`), then `git push && git push --tags`.

The tag push runs `.github/workflows/build.yml`, which publishes the GitHub Release only when every
platform passed. tet ships as archives installed by `scripts/install.sh`/`install.ps1` — no
installer, no npm package (reasons in `electron-builder.yml`). An update is put in place only after
tet quits, never mid-session.
