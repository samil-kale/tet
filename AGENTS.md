# AGENTS.md

## What this is

TET is a git workspace for coding agents: Electron + React + xterm.js, several repositories open
at once, each with its own git lane and its own agent and shell tabs. Git is for navigation
and control of the repository state; the work happens in the tabs, so anything git can't do
in two clicks belongs in an agent or a shell, not in a new dialog.

This file holds rules of conduct, cross-file invariants and where things live. A reason that fits
one file is a comment at that site, not an entry here. Adding here means cutting.

Comments, here and in code, say what holds and why, in a sentence: never how it was found, what
was measured, history, dates, version numbers or links. An agent's tested version is its
`install.verifiedVersion` alone.

References: **GitHub Desktop** for the git half (shapes, not scope); **VS Code** for the UI —
classic layout, Dark Modern's palette, tab semantics, theme names; **IntelliJ** where VS Code has
no answer or the git lane's tree is concerned — the commit view's checkboxes, tree headers,
toolbar spacing, its themes, its font (JetBrains Mono for terminals and editor); **Monaco** for the editor tab.

## Do not restart the app yourself

Agents run *inside* TET, as terminal tabs; killing the Electron process kills your own session.
Build and typecheck freely, but ask the user to restart — and before anything that tears down a
project's tabs.

## Where things live

- `src/` is one folder per process — `main/`, `renderer/`, `preload/`, `cli/` — plus `shared/`,
  the only folder imported across them (`no-restricted-imports` in `eslint.config.mjs`), and only
  for what two processes use; its types lie by area in `shared/types/`, imported from the area's
  file.
- `src/main/` is layered: each area imports its own layer's areas it is allowed and every layer
  below, never one above — per area in `eslint.config.mjs` (`MAIN_LAYERS`), bottom first:
  0. `util/`: helpers of no area — the platform, starting processes, a module in a
     `utilityProcess` of its own (git, the Explorer's walk and search), logging, reading `.git`
     without git.
  1. `store/`: what TET keeps and reads back — projects, settings, environment variables,
     `tet.json`, the data folder's layout — and what resolves against it: a repository's or
     worktree's folder, the saved theme, pasted content. A store of one area stays in it
     (`sbx-local.ts`, `providers/accounts.ts`).
  2. The areas, apart from each other but `sbx/` using `agents/`: `git/` (the git process and
     everything talking to it), `agents/` (each agent and what drives one: hooks, readiness, PATH,
     the install check, asking), `sbx/` (the `sbx` CLI), `providers/`, `update/` (the auto-update),
     `browser/` (the browser tabs' pages, the CDP proxy onto each, and Playwright driving them in a
     `utilityProcess` of its own).
  3. `terminals/`: pty, sessions, where a tab runs and the side it runs on (`TabSide`), its
     control token.
  4. `ctl/` (`tet-ctl`): drives the tabs through `ControlTerminals`; the caller's side
     (`CallerSide`) extends the tab's.
  5. The wiring: `ipc/` (the `TETApi` handlers, registrars by area, each taking only the
     singletons it touches) and, flat, the startup (`main.ts`, `uncaught.ts`), the window
     (`window.ts`), `projects.ts` and `requirements.ts`.

  Files that belong together are a folder; one that stands alone stays flat in its layer. No
  folder for its own sake. A new folder or flat file joins a layer in `eslint.config.mjs`, or lint
  refuses to run.
- Every IPC channel is typed in `src/shared/ipc.ts`, off `TETApi`, and used only through its
  wrappers — `handle`/`on`/`once` (`src/main/ipc/channels.ts`) and `window.ts`'s `send` in main,
  `invoke`/`send`/`subscribe` in the preload — never a bare `ipcMain`, `ipcRenderer` or
  `webContents.send` call with a string.
- `src/renderer/` is layered the same way (`RENDERER_LAYERS`), bottom first:
  0. Flat helpers of no view (`platform.ts`, `paths.ts`, `identity.ts`, `resolved-ref.ts`,
     `shortcuts.ts`) and `themes/` (the stylesheets and the colors built from them).
  1. `ui/`: views and hooks of no feature — dialogs' frame, fields, menus, the tree row and the
     tree it lists, icons.
  2. `editor/`: the editor tab — monaco + shiki, the tab's model and opening a file in one.
  3. `tabs/`: the tab area — panes, split view, the terminals (xterm, link providers), hosting
     editor and browser tabs beside them (`pane-tab.ts` tells the three apart).
  4. `git/`: running a git action from the views above it (`run-action.ts`), and the questions and
     login every one of them asks alike.
  5. `lanes/` and `dialogs/`, apart from each other. A lane is a folder of `lanes/` — `projects/`
     (the projects and the COMMANDS), `git/` (the branch tree and the changes), `files/` (the
     Explorer tree, the SEARCH section, Seti's file icons) — and imports no other lane; beside them,
     their state (`use-lanes.ts`).
  6. The shell, flat: `App`, `Startup`, `main.tsx`, `styles.css`, and what feeds `App` from main
     (`use-ref-feeds.ts`). `assets/` holds the app icon, for the window and the packages, and the fonts the app ships
     with their licenses (`fonts/`).
- Each agent is a folder under `src/main/agents/`, described by one `AgentDefinition` (`agent.ts`
  documents every field), grouped by what it can do — `install`, `terminal`, `run`, `ask`,
  `sessions`, `turns`, `host`, `sandbox` — each group present whole or not at all: whether an agent
  can do something is whether it has the group (`hasSandbox`), never a list of ids. Shared code
  never imports an agent's own folder: only the registry (`agents/index.ts`), `agent.ts`'s types
  and `hasSandbox`, and the agent-neutral files beside them (`ask.ts`, `system-prompt.ts`,
  `agent-path.ts`, …). A new agent must fit the data model (below) and is
  a new folder and one registry entry, nothing else: its icon is data in its definition (`icon`),
  which the window draws, and no code outside `agents/` names an agent (user-facing text may) but
  the shell, which TET itself runs saved commands and plain terminals in. What a new agent needs
  that no group covers extends the groups, never a branch on its id.
- **A project is its repository and its worktrees** — the words for them, in code, texts and
  comments alike. The repository is the folder the user opened, holding `.git`; never call it a
  worktree (nor "main worktree"), and there is no noun for both: where one of them is meant — where
  tabs, git and the Explorer run — it is addressed by a `ProjectRef { projectId, worktree? }`
  (without `worktree`: the repository), resolved to its folder and name as a `ResolvedRef`, and
  said as "the repository or a worktree". A worktree has no id of its own; one string
  (`refKeyOf`, a `refKey` where held) only where a single key is unavoidable. A bare `key` is a
  worktree's folder key alone. The one whose tabs are shown is the active one (`activeRef`).
- A project needs git — a folder without it is refused. Its id is `tet.id` in the repository's own
  git config (`projects.ts`'s `resolveProjectId`), shared by its worktrees; what TET keeps of it is
  laid out in the data model below.
- `tet.json` in a repository's root describes the project and travels with it: saved `commands`,
  the Explorer's `folders` and excludes and `sbx`. Read defensively (`src/main/store/tet-json.ts`): missing means
  nothing configured, broken never does — a project whose file is broken is neither added nor
  opened at start (kept, with all TET has of it, until added again), and one broken while open
  counts as its last readable version, said in a notice. Nothing writes over a broken file. A
  worktree has none of its own: it takes its project's (`configRoot`) and its SBX settings, forwards
  none of the ports, and changes nothing of it — its row, Explorer and COMMANDS offer no settings,
  `tet-ctl` refuses them.

## Data model: `~/.tet`

Everything TET keeps lives here (`data-root.ts`, `project-dirs.ts`). The layout is fixed: every
change, and every agent added, fits it. The one file TET writes elsewhere is sbx's first-run
marker (`Platform.sbxFirstRunMarker`), which keeps sbx's one-time wizard out of a tab. Chromium's
own profile stays in Electron's `userData` (`data-root.ts`), the browser tabs' with it: a
worktree's tabs share a partition of their own, cleared when the worktree goes and its folder
deleted at the next start; the repository's share the global one.

```
~/.tet/
  settings.json  environment.json  projects.json  sbx-local.json  *-accounts.json  git-logins.json
  errors.log
  bin/                             tet-ctl, first on every tab's PATH
  askpass/                         for TET's own git runs only
  update/
  config/<agent>/                  a host tab's setup, once per agent (HostSetups)
  projects/<id>/                   id: the repository's `tet.id`
    drops/                         pasted or dropped content without a path, for host tabs
    downloads/                     what the browser tabs' pages downloaded
    sandboxes/repository/<agent>/  the repository's sandbox of the agent, mounted whole
      sessions/                    the host side of its session mounts
      handovers/                   another agent's session a tab here takes over, copied
      drops/                       pasted or dropped content without a path, for its tabs
    sandboxes/<key>/<agent>/       a worktree's
    worktrees/<key>/               a worktree TET made
```

- **Machine-wide or per project, nothing between.** The top level holds what is global or secret;
  `projects/<id>/` only what a sandbox may see, since sbx is granted it whole — never a setting, a
  token or an sbx value. Removing a project deletes its folder.
- **A sandbox sees its agent folder, and nothing else of `~/.tet`** — but the worktree it runs in,
  and a worktree or path handed to it (dropped, or by `worktree-agent-merge`), mounted as a drop.
  What a sandboxed tab needs from TET lies in `sandboxes/<repository|key>/<agent>/`, mounted whole;
  nothing of TET's gets a mount of its own (the one exception in the sbx section).
- **One thing, one name, on both sides.** What host and sandboxed tabs both keep is a folder of the
  same name: `projects/<id>/<name>/` for the project's host tabs (`config/<agent>/` if it knows no
  project), `<agent folder>/<name>/` for sandboxed ones.
- **Split only where a sandbox forces it.** Repository, worktree and agent divide `sandboxes/`
  alone, since each is its own sandbox; a folder beneath `projects/<id>/` or an agent folder is
  flat, its entries kept apart by their names (one subfolder per entry where it goes as a whole,
  as `handovers/`).
- **What exists is handed over, never copied.** A host tab gets the original path. A path dropped
  into a sandboxed tab outside its sight is mounted rw at its container path, never written into
  `tet.json`, and held until TET quits (every start's `mountAll` is handed it); a notice says it
  was mounted, or that governance refuses it. `worktree-agent-merge` hands a conflicted worktree to
  the repository tab that merges it the same way, and deleting a worktree releases every such mount
  of its folder (`releaseDropped`). Only what has no path of its own (a browser's drop, a pasted
  image) is written, into `drops/` on either side; a handover copies what sits in another agent's
  store, which no sandbox may see.
- **A store written by a Save someone waits on writes before it changes** (`writeJson`,
  `json-file.ts`): a failure reaches the one who saved — in the dialog, or `tet-ctl`'s answer —
  and the store keeps what the disk has. Only a write nobody waits on, or a cleanup that must not
  stop what it cleans up after, logs instead (`logFailure`).
- **`settings.json` is one object per tab of the settings dialog**, named by the tab
  (`AppSettings`, `src/shared/types/settings.ts`): a new setting joins its tab's object, never the
  top level; a tab that stores nothing has none (Environment keeps `environment.json`). The dialog
  holds no setting of a project: those are `tet.json`'s, edited where they show. `withSettings`
  merges each object by its keys, and `normalize` (`store/settings.ts`) reads every key back
  defensively, with its default.
- **A host setup knows no project.** `host.prepare` is handed no project path and writes only into
  `config/<agent>`: one set of files serves every repository and worktree, rewritten once when a
  setting in it changes.
- **Sessions stay the agent's own.** TET lists them from the agent's own store, per repository or
  worktree (`SessionProvider`), and keeps no list of them of its own.
- **A sandbox is read without starting it.** Its setup lies in its `sandboxes/…/<agent>` folder,
  its sessions reach the host through `SandboxSessions.mounts` into `sessions/`, listed by the same
  code as the host's.
- **An agent that cannot fit is not added**: one needing project data on the host, session records
  kept by TET, or a running process to list its sessions. Bending the model for one agent is the
  user's call.

## Never assume the agents behave alike

Claude Code, Codex and pi are three products in the same kind of tab, alike in nothing:
readiness, how Ctrl+C quits, the right mouse button, colors, turn reports, resize redraw, how a
pasted path is quoted (`quotePath`). So anything about how a CLI is driven is an `AgentDefinition`
field with a value per agent (or what its `host.prepare` returns, e.g. the fullscreen env that
makes a resize redraw in place), found through this same pty for that agent, never taken from
another. The one exception is the right mouse button, decided per click by the terminal's mouse
mode (`terminal-views.ts`), not per agent.

## Never touch the user's agent configuration

Everything TET generates for an agent lives under `~/.tet` (the data model above) and is pointed
at from outside, each side — host and sandbox — handed only its own folder, pasted or dropped
content without a path included (`drops/`).
`host.prepare` and `sandbox.prepare` are the only places an agent writes configuration;
beyond them it touches only its own sessions: when the user renames or deletes one, and every one
of a worktree it deleted, once its folder is gone (`removeAllSessions`).

- Claude Code: a generated `--settings` file; never `~/.claude/settings.json`.
- Codex: `-c key=value` for that one process; never `~/.codex/config.toml` or `hooks.json`.
- pi: a generated extension via `-e`; never `PI_CODING_AGENT_DIR`.

## Cross-platform

Must work on Windows, Linux and macOS; no OS-specific behaviour without an equivalent for the
others.

- **What differs between them is a `Platform` member** (`src/shared/platform.ts`: `WINDOWS`, `MAC`,
  `LINUX`), named by what it means (`pathsIgnoreCase`, `spawnsThroughCmd`, `appBundle`), never by
  which OS it is. Main reads `PLATFORM` (`host-platform.ts`), the window its own
  (`renderer/platform.ts`); nothing else asks for `process.platform` or `navigator.platform`, and
  the id is data alone (tet.json's `os`, the app's info) — `install.test.ts`, testing each OS's own
  installer, alone branches on it. A new difference extends the interface.
- Paths through `path.join`; every agent, shell tab and `sbx` spawn through `resolveCommand`
  (`src/main/util/process.ts`), never `shell: true`.
- Every HTTP request goes through Electron's `net.fetch`, never the global `fetch`: only
  Chromium's stack applies the machine's proxy and certificate store. Code the tests run under
  node takes it as a parameter defaulting to `net.fetch` (`fetchHttpsImage`). A request that reads
  a redirect instead of following it uses `net.request`, the same stack: `net.fetch` throws on
  `redirect: "manual"` (the update check's `latestVersion`).
- A generated `sh` script is LF, and anything written into it is quoted with `shellSingleQuote`
  (`src/main/util/generated-file.ts`).
- A hook command runs under whichever shell the agent picks: keep it a bare
  `tet-ctl hook <event>`.
- A file another process reads (hook settings, launchers) is written beside the
  target and renamed into place.

## Read structure, never messages

What a CLI tells TET is read from its exit code or its `--json` (`sbx policy ls --json`'s
`organization`), never from the words of an error or of human-facing output: those change with
the version and the locale. Text is matched only where the tool offers nothing else (git has no
error codes: `AUTH_FAILURES`, under `LC_ALL=C`), said in a comment at that site.

## Git

- Git is never reimplemented and never run from the renderer. `src/main/git/git.ts` wraps the CLI
  in its own `utilityProcess` (`git-host.ts`, via `git-client.ts`): nothing in `git.ts` or
  `git-host.ts` imports electron, everything crossing the boundary survives a structured clone.
- Starting git is the cost, so count invocations: anything added to the refresh path must earn its
  process (the budget is commented at `git.ts`'s `readState`).
- `Repository` is the single source of truth for the git lane and the tabs; every git command
  that changes an open repository goes through `Repository.runAction` (renderer:
  `git/run-action.ts` — `useBranchActions` for branch commands, `useFileAct` for the changes list
  and the Explorer). Reads run beside it, and so does the periodic fetch, which actions wait on.
- Remote commands run with `NETWORK_ENV`. **TET writes into no credential helper itself**: a login
  typed into TET reaches git through askpass (`GitLoginStore.run`), and git stores it in the
  user's helper; where there is none, TET keeps it sealed in `~/.tet/git-logins.json`.
- TET never diffs: it hands monaco's diff editor two texts (`Repository.readFile`).
- **A linked worktree is a worktree and belongs to its project; it is not a project.** It only
  behaves like one in places (its own row, tabs and git lane) — never design from "a worktree is a
  project". TET makes its worktrees at `~/.tet/projects/<id>/worktrees/<key>`; the key is
  given once and never changes, and every worktree TET made opens with its project, listed under
  its row (`Project.worktrees`) and in the branch tree's WORKTREES (`RepositoryState.worktrees`,
  `WorktreeInfo.key`), both read off the disk. One made elsewhere (plain `git worktree add`) has
  no key: shown greyed, never opened, never renamed or deleted by TET. A worktree
  and its branch are one: made together at the default branch (`worktreeBase`), named by the
  branch, deleted together, and never switched; renaming it renames the branch alone, its folder
  and tabs stay. Its base is TET's own `branch.<name>.base` (`git.ts`'s `worktreeAdd`).
  Removing a project deletes the worktrees TET made, with their branches.

**Scope.** Everything the git lane does fits in a context menu, an icon button or a question. Of
that, GitHub Desktop's set: the branch tree (branches, remotes, tags, stashes), checkout, branch
create/rename/delete, tag create/delete, merge and rebase onto a branch, abort, per-file diff, discard,
`.gitignore`, fetch/pull/push, commit of the checked changes (IntelliJ's checkboxes, no
staging), the commit graph (GRAPH: VS Code's "Auto" — HEAD, its upstream and the default branch — read-only,
a commit's files and their diffs against its first parent, searched by message, author or path), stash of all and apply/pop/drop, remote URL, worktrees (add, rename, delete), init and
clone (GitHub/GitLab via `GitProvider`), and a commit message suggested by an installed agent.
Where Desktop differs from git's defaults, follow Desktop. The project row's entries are 
repository-wide and never touch the working tree — a worktree's own row excepted, which is that 
tree, and its merge into the base, run where the base is checked out.

Don't add without being asked: staging or per-line staging, history beyond the graph, cherry-pick, revert,
squash, reorder, bisect, submodules, conflict resolution beyond aborting,
discarding single lines, pull with rebase, force push. A command needing a list, a message field
or a per-line decision is for an agent.

## UI rules

- **Layout**: the lanes on the left: the projects (each with its worktrees, and the COMMANDS), git
  and files — none of them a tab. The strip's toggles drive the one free lane, one at a time; a
  lane pinned from its headers' menu stays out beside it, its toggle gone until unpinned, and moves
  by dragging its header (`use-lanes.ts`). Pins and order are settings (`appearance.lanes`), set in
  the window or by `tet-ctl`, never in the dialog; widths and the free lane are the window's
  layout storage. The tab strip is the agent, shell, browser and editor
  tabs of the repository or a worktree — VS Code's preview rule, one preview tab each
  (`editor-tab.ts`).
- **A browser tab's page is main's view, drawn above TET's own page** (`browser-tabs.ts`), which
  is itself a transparent view filling the window (`window.ts`): the tab's box only says where
  (`BrowserHost`). Under a dialog, and wherever something floats over a page — a menu, the notices,
  a tab dragged over the panes — TET's page is raised above it, transparent beneath every live page
  (`browser-raised`), so the page stays live and what floats lies over it: what floats says so
  (`useFloatsOver`, `window-covered.ts`), or the page hides it. A page takes its own keys and clicks
  but the window's shortcuts and its pane's focus, which main reads there and hands on. Never
  persisted.
- **Section titles are the screen's, code names the code's**: PROJECTS `ProjectList`, COMMANDS
  `CommandList`, BRANCHES `BranchTree` (its header's button swaps it for GRAPH `CommitGraph`), LOCAL CHANGES `ChangesList`, SEARCH `FileSearch`,
  EXPLORER `Explorer`; each title heads a `Section`, drawn by `ProjectList` and `CommandList`
  themselves and by `GitLane` and `FilesLane` around the others, never a "pane".
- **Split view**: up to four panes in fixed presets, reached only by dragging a tab onto a snap
  zone. Every rule is in `src/renderer/tabs/pane-layout.ts`, the state in
  `use-project-layouts.ts`, called from `App`.
- **A diff withholds every preview beside the editor** — Markdown's, and any added later
  (`previewWithheld`): it is hidden, its toggle, shortcut and menu entry disabled, and its own
  setting kept, so it shows again once the diff is off.
- **Everything the user is told is a notice** — `notify()` (`src/renderer/ui/Notices.tsx`; main
  sends `app:notice`) — **unless a dialog on screen says it** (below). No other view keeps a
  message of its own but the SEARCH section, whose failure stands in its header as VS Code's does:
  it follows each keystroke; a status (marks, progress bar) is not a notice.
- **Every question is `confirm`/`prompt` from `Dialog.tsx`**, asked by the view offering the
  action; the main process asks nothing, no native message boxes. Ask only before something
  irreversible — removing a project asks only when it takes worktrees along; its own data goes
  unasked. Card dialogs are drawn in `DialogFrame`. The two exceptions: an agent's
  `env-request`, answered in `EnvDialog`, one at a time (`env-requests.ts`), and a browser tab's
  page asking for an HTTP login, asked by its tab (`BrowserHost`).
- **`DialogFrame` draws every dialog's button row**: Cancel with × and Escape (`onCancel`; a wall
  has none), the `actions`, and the `primary` button, which Enter runs from anywhere in the dialog
  unless it cannot go. One that cannot says why as its tooltip (`blocked`), unless an empty field
  already shows it (`disabled`). The focus goes to the open tab's first field, on opening and on
  each tab switch; a hint (`dialog-detail`) stands under the fields it explains.
- **A dialog on screen says what concerns it; prefer this to a notice.** Words alone, no mark,
  coloured by what it is. A failure belongs where the answer was typed: under that field
  (`Field`'s `error`); in a row of a list as the error mark's tooltip beside it (`RowMark`, the
  one mark; on a dialog tab, `DialogTab.mark`); else left in the button row, level with the
  buttons (`DialogFrame`'s `error`) where the fields are several or across tabs — what was typed
  is held so it can be corrected, and it is git's own words for a name it will not take, never
  TET's guess at them. A list that could not be loaded shows its failure in its place
  (`DialogError`).
  What the unsaved edits as a whole lead to goes in the same place (`DialogFrame`'s `message`),
  e.g. `RestartNote` while they reach running tabs only once restarted. A notice is for what has
  no dialog up to carry it; a `confirm`
  has no field, so it notifies.
- To get this, **a question runs its own answer** (`useSubmit`; a prompt's `PromptOptions.submit`):
  the dialog stays up while the action runs, so what runs it hands the failure back instead of
  notifying it (`git/run-action.ts`). A new verb a dialog calls answers its failure rather than
  sending `app:notice`.
- **What a dialog runs finishes before it goes — unless stopping it leaves nothing behind.** Each
  run is one of two kinds, decided by what a stop would leave:
  - *Held* (the default; `DialogFrame`'s `locked`): anything that changes state in steps or is
    not killed — a Save, a git command, a store, a sign-out. Cancel and × are disabled, Escape
    does nothing and the body's fields are disabled with them, so nothing is left half done,
    edited under the run, or answered into a closed dialog.
  - *Stopped*: a run a stop leaves as if it never started — it changes nothing, or what it changes
    happens whole or not at all — and that waits on something outside TET (a browser, an agent, a
    provider's API). It runs the bar but holds no Cancel: Cancel kills it where it can
    (`DialogFrame`'s `abort`, a prompt's `PromptOptions.abort`) and its answer is dropped.

  A new run is held unless it meets both conditions; a dialog's Save is always held.
- **A follow-up question comes after its run** (`runWithFollowUp`): an action answering
  `needsConfirmation` ends there, its bar and lock released, and a yes runs the confirmed action
  anew — a bar shows TET working, never TET waiting on the user.
- **Nothing is written until Save**; Cancel and Escape drop edits. The exception is the SBX
  dialog's Docker sign-in and sign-out and the Add Repository dialog's account adding and
  removal and namespace pick, which act at once. A setting reaches an agent at its setup
  (`AgentPaths`), so it applies to tabs started afterwards; the theme and the idle reminder
  redo the host setup, once per agent (`HostSetups`).
- **A section of typed rows never says it is empty** (`RowSection`): it shows one blank row to
  type into, on opening and once the last is removed (`atLeastOne`), and Save drops a blank row.
  Only rows a picker adds (the SBX paths) get a line saying there are none.
- **One progress indicator per section** (`ProgressBar.tsx`, `Section`'s `busy`): a new slow
  reason feeds the existing bar. In a dialog that bar is `DialogFrame`'s `busy`, so a busy state
  held by a nested view is lifted to the view owning the frame (`hold`). No spinners for progress:
  the one spinner is a session's working mark. The one determinate bar is the update download's,
  in its notice (`showProgress`), which runs the indeterminate one while the update is prepared.
- **The keyboard belongs to the terminal**: TET's key handler runs before xterm and takes nothing
  an agent could have received. Check every new shortcut against `src/shared/shortcuts.ts`. No
  window shortcut closes a tab.
- **The renderer**: terminal output never goes through React state — xterms and editors live
  outside React (`terminal-views.ts`, `editor-views.ts`). The views under `App` are memoized: hand
  them stable props (`useCallback`, `useMemo`, `identity.ts`).
- **Anything that changes the box xterm measures refits the pty**: hide with `visibility`, frame
  with an overlay, resize only once dragging settles.

### Look

- Colors only from the themes' `--tet-*` variables, named by VS Code's color ids. The layer, its
  rules and exceptions, and how a VS Code theme becomes a TET theme: `src/renderer/themes/THEMES.md`.
- Shared sizes are stated once, in `styles.css`'s `.app`; check the neighbouring view before
  inventing one.
- Icons come from Lucide first (`icons.tsx`). The file icons are generated by
  `scripts/file-icons.js` — re-run, never edit.
- Icons and marks are monochrome. The one accent is `--tet-focusBorder`, 1px for anything that
  marks or points. Exceptions: git status letters,
  the error mark, a notice's severity icon, an editor tab's unsaved dot, the file icons. A theme
  whose own mark colour differs sets it in place of the accent (`THEMES.md`).
- Row hover is `--tet-list-hoverBackground`, action button hover
  `--tet-toolbar-hoverBackground`.
- A disabled control is dimmed, never recolored (opacity 0.4, the default cursor): every new
  control gets that state with it.
- When two things that should look identical don't, measure them (`getComputedStyle` on the built
  stylesheet) instead of guessing.

## Turns and tab marks

A tab and its project row show *working* (spinner), *waiting for an answer* (question mark) or
*finished out of sight* (speech bubble); on a tab they replace the agent icon, ranked error/missing
> waiting > working > finished.

- **Nothing is read off the terminal or a file.** Every agent reports its turn over the control
  channel as `tet-ctl hook <event>`, addressed by `TET_TAB_ID`: Claude Code and Codex as a hook
  command, pi's extension by posting the same request. The one exception: no
  agent's hook fires for a turn the user cut short, so reconcile ends a turn by the agent's own
  session record (`AgentSessionInfo.turnEndedAt`) — never starts one, never marks.
- The main process sets the state (`TabSessionManager.hookEvent`); the renderer decides what is
  shown (`useTabMarks`) and clears what was seen (`terminals.seen`).
- A tab is asked to quit (`terminal.quitPresses`) before it is killed — a hard kill skips a
  CLI's exit handlers.

## The control channel: `tet-ctl`

Lets an agent ask the app for what the filesystem and git can't give (theme, projects, tabs). A
second transport onto the same singletons `ipc/` is handed (`Repository`, the session managers,
`projects.ts`), never a second implementation of what they do; a verb may combine them where the
window has no counterpart (`worktree-agent-merge`, `tabs-output`). Contract and verbs:
`src/shared/ctl.ts`; server: `src/main/ctl/ctl-server.ts`; handlers: `ctl-verbs.ts`
and the `ctl-*-verbs.ts` beside it, on what `ctl-verb.ts` gives them all (`ControlDeps`,
`ControlTerminals`, `resolveCallerRef`); CLI: `src/cli/tet-ctl.ts`.

- `app-restart` passes `--confirm` only when the user asked. `restartRequired` is relayed to the
  user, never acted on.
- **The browser verbs** (`ctl-browser-verbs.ts`) drive a browser tab's page through Playwright
  (`browser-automation.ts`), connected over the CDP proxy (`cdp-proxy.ts`) that makes that one page
  a whole browser to it: the agent sees neither the window nor another tab. A page's content is
  someone else's, said in every answer carrying it. A browser tab is this machine's: no verb answers
  in a sandbox, and its system prompt never mentions them.
- Agents learn of `tet-ctl` once per session: `systemPrompt`
  (`src/main/agents/system-prompt.ts`), appended to each agent's system prompt (Codex: its
  `SessionStart` hook's added context), never replacing the user's instructions.
- **Environment variables** (`src/main/store/environment.ts`): tokens and passwords an agent
  needs, typed only into TET's dialog (`env-request`), never the chat; kept in the clear (every tab
  gets them anyway), global, and set in every tab at its start (`pty.ts`'s `buildEnv`), over what
  the machine sets itself — said in a notice. A running tab takes them up only when restarted: the
  dialog's Save restarts the asking one. None in a sandbox, and the verbs refused *and* unmentioned
  there — not in `help`, not in its system prompt.
- A caller is a project, a worktree (`TET_WORKTREE`, its key) and a tab; its ids count only with
  the token made for them (`ctl-token.ts`): a terminal gets its tab's token, never the run's.
- **Where a caller runs is its side** (`ControlSide`, `src/shared/ctl-side.ts`; in the main
  process the tab's `TabSide`, `terminals/tab-side.ts`, and the caller's `CallerSide` extending it,
  `ctl/caller-side.ts`), set by its tab's place and read back off its token: which verbs
  answer and how far, what `tet-ctl help` and the system prompt mention, the variables its tab
  gets, the tabs, projects and files it reaches. Nothing else asks whether a caller is sandboxed; a
  new difference extends the side.
  Without flags a verb acts on the caller's repository or worktree, `--project` alone on a
  project's repository, `--worktree` on one of its worktrees (`resolveCallerRef`).
- `tabs-keys` and `tabs-output` answer only for a tab of the caller's own project, its repository or
  any worktree (`ownProjectOnly`). **From a sandbox, whatever runs in a sandbox of its project**:
  the worktree verbs and every tab verb reach its repository and every worktree (`ownProject`), a
  tab verb only a tab running in a sandbox (`CallerSide.reachesTab`) — a host tab is the machine's,
  and its output may print the host's control token — and a tab it opens runs in one too; what acts
  on this machine (its settings, projects, environment, the SBX settings but `sbx-get` and the
  variables, a saved command, restarting TET) is refused; the other verbs answer for the caller's
  own repository or worktree only. **Refuse a sandbox only what it cannot do itself**: where it
  already can and `tet-ctl` doing it changes nothing beyond that, the verb answers there.
- **Direction of travel**: every setting in `settings-get` becomes settable through `tet-ctl`. A
  new or extended setting comes with an *offer* to add its verb (`ControlVerb` entry, handler,
  `ctl.test.ts` case) — the user decides what an agent may change.

## sbx: agent tabs in a Docker sandbox

Opt-in per project (`sbx` in `tet.json`), for every agent but the shell. `src/main/sbx/` drives
the `sbx` CLI.

- **Where a tab runs is its `TabPlace`** (`src/main/terminals/tab-place.ts`): decided at each start
  (`resolvePlace`), until then by where its session lives; each agent's runtime holds a `host` one,
  and a `sandbox` one where it has the sandbox group. Everything that differs between host and
  sandbox — paths as the tab sees them, drops, listing and operating on sessions, the side it calls
  from, the spawn — is a member of it, implemented by `HostPlace` (a saved command's `CommandPlace`
  extends it) and `SandboxPlace`; nothing else asks where a tab runs, and a new difference extends
  the interface.
- **Never falls back to the host**: when sbx isn't ready, a sandboxed tab stays in `error` — the
  host would bypass an organization's policy.
- **sbx alone is enough**: an agent missing on the host still starts in the sandbox
  (`AgentRuntime.sbxOnly`).
- The sandbox never sees the agent's own config directory; sessions are read through host mounts, so
  the same listing code serves both. Of `~/.tet` it sees only the `sandboxes/…/<agent>` folder of
  its repository or worktree and what the data model excepts, and a worktree's sandbox is its own
  (its workspace, the worktree's folder, is fixed at `sbx create`); under governance one rule,
  `~/.tet/projects/**`, allows TET's folders and its worktrees. TET's own live mounts are folders of
  that `sandboxes/…/<agent>` folder alone; the one exception is a worktree's repository `.git`
  (`worktreeMountSpecs`), without which git fails there. The user's grants (Allowed paths,
  knowledge) and a path the user drops (data model) are theirs, not TET's; so is a worktree
  `worktree-agent-merge` hands over, taken as a drop.
- Generated setup targets where it runs, not the host's platform (`HookTarget`).
- **tet.json holds what was applied.** Save checks each row against sbx's policy (hosts through
  `sbx policy check` under governance, paths and knowledge through the rules `sbx-policy.ts`
  evaluates) and against this machine (a path exists, a port is free, a value is stored). A row
  that fails, or that sbx refuses while applying, is neither saved nor applied; the rest goes
  through. A Save sbx cannot answer for (a listing fails, a sandbox will not start) stops before
  changing anything — could-not-say is no refusal. One check for the dialog, `sbx-set-*` and a
  session's start (`readSbxProblems`).
- **The dialog checks live** whatever can be checked, and marks a failing row with the error mark
  saying what is wrong — never that it will not be saved.
- **A session's start applies tet.json as it stands and never writes it.** What the policy forbids
  or this machine lacks is skipped and told in one notice per dialog tab and reason, its rows
  listed (`Could not set hosts:` … `Forbidden by governance`): how a user learns that governance
  took over.

## Startup

`src/main/requirements.ts` checks git, the agents and sbx before the workspace opens; without git,
or with neither an agent nor sbx (`--allow-shell-only` lets the shell suffice), `RequirementsDialog`
is a wall and **installs nothing**. `process.env.PATH` is rewritten before that check
(`augmentAgentPath`) and everything spawned inherits it.

## npm scripts

- `npm run compile`, `npm run typecheck`, `npm run lint`, `npm run format` (Prettier; `format:check` in CI)
- `npm test` — compile, then node's test runner over `dist-test/`. `test/` mirrors `src/`: one
  file per area or per seam within one, a new test going beside what it tests; `e2e/` runs the
  real thing, `helpers/` serves them all, and `lint.test.ts` holds `eslint.config.mjs`'s rules to
  what they must let through and refuse. Nothing looks into the window. `e2e/app.test.ts` starts
  the real app on a throwaway profile (needs a display, `xvfb-run` on Linux); `e2e/agents.test.ts`
  runs only with `TET_AGENT_TEST=1` or `TET_SBX_TEST=1`; `e2e/install.test.ts` only with
  `TET_INSTALL_TEST=1` after `npm run dist` (on Windows it writes shortcuts and the PATH entry for
  the account).
- `npm start` — typecheck, compile, launch (see "Do not restart the app yourself").
  `npm start -- --simulate=git,claude` shows the requirements dialog, `--simulate=sbx-mode` a
  machine with only git and sbx; `--user-data-dir=<dir>` gives a run its own profile;
  `--hide-window` never shows the window (local test runs).
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
   keyboard and menu details. A bullet whose change came in another developer's merged pull
   request (`gh pr list --state merged`, its author not the repository's owner) thanks them at
   its end: `Thanks @<login> (#<pr>).` Commit it on its own (`changelog for <version>`), before
   `npm version`, which refuses a dirty tree.
   A section is its GitHub Release's notes, so a release edited by hand there is copied back into
   `CHANGELOG.md`: the published notes are the text, TET's file follows.
2. `npm version patch` (or `minor` / `major`), then `git push && git push --tags`.

The tag push runs `.github/workflows/build.yml`, which publishes the GitHub Release only when every
platform passed. TET ships as archives installed by `scripts/install.sh`/`install.ps1` — no
installer, no npm package (reasons in `electron-builder.yml`). An update is put in place only after
TET quits, never mid-session.
