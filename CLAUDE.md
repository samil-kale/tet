# CLAUDE.md

## What this is

TET is a git workspace for coding agents: Electron + React + xterm.js, several repositories
open at once, each with its own git pane and its own set of agent and shell terminals.

Git is there for navigation and control of the repository state. **The actual work happens in the
terminals**, so anything git can't do in two clicks belongs in an agent or a shell, not in a new
dialog.

## Do not restart the app yourself

Agents run *inside* TET, as terminal tabs. Killing the Electron process kills the session you
are running in, mid-turn. Build and typecheck freely, but ask the user to restart and report back.
The same goes for anything that tears down a project's terminals.

## Where it came from

**`sbc-vsc-agents`** (sibling directory, private) is the direct ancestor: two VS Code extensions
docking `claude` and `opencode` into the sidebar as real terminals. Most of the terminal half of
TET ports its `shared/`; its `CLAUDE.md` records *why* — read it before changing any of them:

- session listing, resume, rename, delete, and the reconcile loop adopting a session id a CLI has
  only just persisted (`src/agents/*/sessions.ts`, `src/main/session-manager.ts`)
- how each agent is driven: Claude Code is a plain CLI reading `<uuid>.jsonl` transcripts off disk;
  opencode is client/server and **everything** goes through the one server TET runs
  (`src/agents/opencode/server.ts`) — never its CLI or its SQLite file
- `extractTitle`'s precedence rules for Claude Code session titles — a regression there silently
  shows the wrong tab title with nothing to catch it
- the modifier-gated terminal link providers (`src/renderer/links/`)
- OS notifications and the `background_tasks` stop guard (`src/main/os-notify.ts`,
  `src/agents/claude/hooks.ts`)
- the `--vscode-*` theming layer

Not ported: the VS Code editor context — feeding an agent what's open or under the cursor — and the
diagnostic quick fix; TET's own editor (see "Editing", below) is a plain look-and-fix surface with
nothing like that to feed. What survives is the shell transcript in `src/main/shell-context.ts` — a
capped file the agent is pointed at, not an excerpt inlined into every prompt.

**GitHub Desktop** is the reference for the git half — Electron + TypeScript, so its repository
models and git paths translate directly; crib the shapes, not the scope. **VS Code** is the UI
reference (tab semantics, close actions, theme names, the sash) — the **classic** layout and Dark
Modern's palette, not the pill-shaped Modern UI. **Monaco** is in (see "Editing", below) — as the
diff dialog's own file editor, not a richer diff; the diff itself is still `DiffView`'s own unified
render. Not adopted yet: **Octokit**/**GitBeaker** for the providers.

## The layout

- projects live in the left sidebar; the tab strip is one project's terminals only
- git is **not** a tab. The strip's git toggle button slides out a pane between navigation and
  terminals — branches over changed files, nothing else — and stays out until pressed again
  (`usePaneToggle`, remembered like a pane size), so a terminal and the repository stay on screen
  together
- one git pane for all projects; unlike terminals, it holds nothing a project loses by switching
  away
- the diff is a **dialog** over the whole window, opened by double-clicking a changed file,
  ctrl-clicking a path in a terminal, or the "Browse files" button, which reopens whichever file
  the dialog last showed for that project (`localStorage`, keyed by project id under the same
  `tet.layout.` namespace the split layout uses — see "Split view" — since which file it reopens
  is a window fact, not a repository one). It carries the changed files down its left side — the same
  `ChangesList` the git pane's LOCAL CHANGES is (filter, selection, context menu), with a plain
  click and ↑/↓ switching the file, so the next diff doesn't mean closing and double-clicking
  again. Its own LOCAL CHANGES header carries only "Discard all" (`confirmDiscard`, shared out of
  `ChangesList.tsx` rather than duplicated) — not commit-all or stash-all, the git pane's other
  two: both name what they do to the *repository*, which reads oddly next to a dialog otherwise
  about one file. Gated on its own `acting` alone: unlike the git pane there is no BRANCHES section
  beside it a fetch/pull/push could be running from while the dialog is up, since it covers the
  whole window. The dialog takes keyboard focus while up and hands it back on close: xterm swallows
  every key it is given, so the arrows would otherwise go to the terminal a path was
  ctrl-clicked in. `DiffDialog` and `SettingsDialog` are deliberately not part
  of `Dialog.tsx`: that file is for questions, built around a form with two buttons
- git commands go in an ordinary terminal tab, not a console of the pane's own
- panes between all of that are draggable (`src/renderer/components/Sash.tsx`)

## Split view

One project's terminals can be split into up to four panes, each with a tab strip and terminal
stack of its own — VS Code's editor groups, cut down to **five fixed presets** (single, two
columns, three columns, two columns with the right one split, 2×2) picked from a menu on pane
"a"'s strip, not a freely nestable tree: nobody splits into a dozen, and a fixed set is
one `switch` in `TerminalsPane` instead of a tree, a generic sash composition and a "which pane
did you mean" for every action. `src/renderer/pane-layout.ts` holds the model and every rule about
it; `TerminalsPane` lays the panes out; `Pane` is one of them, the strip-and-stack that
`TerminalsPane` used to be by itself. The first pane (always top-left) carries one row of plain
icon buttons — git toggle, browse-files, layout picker, settings, in that order — all on pane "a"
regardless of preset, so a split layout's right edge carries none of them. The progress bar is a
bundle of its own again, on neither: it
follows whichever pane the slow thing is actually in — see "One progress indicator per pane".

- **The layout lives in `App`, not in `TerminalsPane`** (`layouts: Record<projectId,
  ProjectLayout>`): preset, focused pane, which pane each tab is in, each pane's active tab. Not
  for tidiness — three things outside the pane need it: the tab shortcuts (Ctrl+Shift+./, cycle
  the *focused pane's* tabs; a new tab lands there), and `markedTabs`/`waitingTabs`/`seen`,
  which leave out "the tab on screen" — with a split, that is one tab *per pane*
  (`visibleTabIds`), and two views applying that rule would be two chances to disagree.
- **A tab belongs to exactly one pane**, assigned lazily: a tab nobody has placed goes to
  whichever pane is focused when it is first seen (`normalizeLayout` writes that down so it stops
  following the focus), a moved tab (dragged onto a pane, or "Move to …" in its context menu) is
  written explicitly. There is one xterm per tab (`terminal-views`), so the same tab in two
  panes at once is deliberately not a thing.
- **`normalizeLayout` is the one place a layout is reconciled with the tab list**, run in an
  effect on every push. It tells "closed" from "not created yet" by the previous list: a pane's
  active tab that has left the list picks its neighbour (VS Code's rule), one that was never in
  it is left alone, since a tab just activated can be ahead of its own push. `tabPane` entries
  for tabs in neither list are kept on purpose — see persistence.
- **Dividers are fractions, not pixels** (`useDividerFraction`): a pixel size is only right for
  the room it was dragged in, and a split has to stay proportional as the window, the sidebar or
  the git pane change that room. `renderGrid` multiplies the share by `.panes-grid`'s live
  measurement on every render, so an even split needs no rescaling and no "was this ever
  dragged" — the default *is* the even split. The measurement is seeded synchronously in a
  `useLayoutEffect` (a `ResizeObserver` callback is asynchronous by spec), so a project restored
  straight into a split paints its first frame right. A drag comes back from `Sash` in pixels and
  is turned into a share of the same room, through the same bounds. Switching the preset back to
  "single" resets every divider to its own default share — "single" is the one preset that never
  renders a `Sash` at all, so it's the natural "start over" point rather than a reset action of its
  own; switching between two *split* presets leaves every divider alone, since each already keeps
  its own share independently.
- **What survives a restart**: the preset, the focused pane, the divider shares, and which pane
  each tab is in — that last keyed by **session id**, not tab id (`serializeLayout`; the
  descriptor carries `sessionId` for exactly this). A tab created during a run is `new-N`, an id
  handed out from zero at every start; it comes back, if at all, under its agent's session id,
  which is what a restored tab uses as its tab id anyway. Only tabs with a session are written, so
  the file never names an id the next run could give to a different tab, and never grows past
  the tabs that exist. **Not** persisted: each pane's active tab (a stale one — a session
  deleted between runs — would leave its pane waiting for a tab that never comes; a pane opening
  on its most recently used session is what the single strip always did) and any focus frame (a
  frame around the focused pane was tried and taken out; the only frame is the drag-over one,
  drawn the way a file dragged over a terminal is).
- **Two things about writing it back**, both learned the hard way: the layout is loaded on
  first sight of a project (`layoutOf`), not when the project list arrives, because a tab push
  can beat that list and a layout built for it would have overwritten the restore; and nothing is
  written for a project until its bootstrap has once reported not starting (`settledProjects`),
  because tabs arrive agent by agent while it lists sessions and a write in that window, trimmed
  to what had arrived, would drop every pane whose session came later — permanently, if the app
  was quit before the rest came.
- **A tab moved between panes gets a new host** (`TerminalHost` remounts under the other pane),
  so `attachTerminal` moves the existing xterm element rather than calling `open()` again — which
  silently no-ops once opened — and `TerminalHost` attaches an existing view whether or not the
  tab is active there, so it never sits in an unmounted container taking output. A pane that loses
  its own active tab this way (dragged out, or "Move to …") falls back to whichever tab sat right
  before it in that pane's own order — the one before wins over VS Code's nearest-right-else-left
  rule, since the tab hasn't closed, only left — or the first of what's left if it was that pane's
  own first tab, or nothing once the pane has no tabs of its own left at all. A tab landing past
  its strip's visible width, new or newly activated, scrolls itself into view rather than sitting
  reachable only by hand.
- **Keyboard focus follows the focused pane** (`Pane`'s `focused` prop): only that pane focuses
  its terminal when the project comes on screen or its selection changes — with every pane doing
  it, the last one would win, and a tab closed elsewhere would pull the cursor away. Separate from
  the refit, since a focus change alone must not resize the pty. Clicking anywhere in a pane
  focuses it, in the capture phase — xterm stops mousedown from bubbling once a TUI turns on mouse
  tracking.
- The layout preset icons in `icons.tsx` were drawn without the `getBBox` audit the file calls
  for; re-measure them before trusting their extent.

## Nothing starts without git and an agent

`src/main/requirements.ts` checks both before anything opens: git via `git.isAvailable()`, and
every agent with `versionArgs` — the shell has none, keeping it out. The renderer asks
(`startup:check`), and passing is what starts the app: `main.ts` doesn't open stored projects when
ready, `openWorkspace` does, from that handler. A machine missing something watches no repository
and spawns no terminal — `Startup` shows `RequirementsDialog` instead of mounting `App`.

The `--version` result is remembered (`isAgentInstalled`): install status is a machine fact, so
each project's runtime doesn't re-spawn every agent's check on open — on win32 through `cmd.exe`,
two processes each. Only the dialog's own re-check always spawns.

The dialog is a wall, not a question — no Escape — and **it installs nothing**: no command works on
all three platforms, most need elevation or a shell, and a program installed while the dialog
stands is still missing from this process's PATH — only a restart picks that up, and the dialog
says so.

On a machine with everything installed the dialog is unreachable, so `--simulate` names commands to
report missing anyway: `npm start -- --simulate=git,claude`.

## Git

Git is never reimplemented. `src/main/git.ts` wraps the local CLI: `git()` resolves for *any* exit
code — callers decide what it means — and rejects only if git itself couldn't start. Never run git
from the renderer.

All of `git.ts` runs in its own `utilityProcess` (`git-host.ts`), reached from the main process
through `git-client.ts` — a proxy whose properties are the module's own functions, so
`git.readState(path)` reads like the import it replaced. Two rules: nothing may import electron (a
plain node process), and everything crossing the boundary must survive a structured clone — hence
an image as a data URL and an error as its message.

The split adds a call that can *reject*: a failed command is in the return value, but a git process
that *dies* takes every in-flight call with it. `Repository` catches that at each entry point and
turns it into the shape callers already handle — an error in the state, `ok: false`, an empty list.
The client restarts the process on the next call.

`Repository` (`src/main/repository.ts`) is the single source of truth for both the git pane and the
terminals, so a branch switched in a terminal shows up in the UI on its own. It watches the working
directory, debounces and throttles bursts, and only emits when state actually changed — the watcher
fires for plenty of no-op edits. Diffs load on file selection, never up front.

**Everything the git pane can do fits in a context menu, an icon button or a question.** That
limits the *views*, not git: a command needing a checkbox list, a message field, or conflict
resolution is one the pane doesn't offer. Of what fits, we take GitHub Desktop's set — today the
branch tree (branches, remotes, tags, stashes) with per-ref menus, checkout, status, per-file diff,
discard, `.gitignore`, fetch/pull/push, "commit all" (one message asked, `add --all` then `commit`
— the whole list or nothing, no staging), and cloning from the add-repository dialog. Cloning brought
GitHub and GitLab with it, behind one `GitProvider` interface (authenticate, list repositories,
resolve a clone URL) under `src/providers/`. Providers stay out of the local git layer — once
cloned, everything goes back through the CLI.

Every action goes through `Repository.runAction`, one at a time per repository, refreshing after —
two actions would race for the same index lock. Discarding and ignoring go through it too, since a
discard context menu doesn't know a fetch is running and `git restore` wants the same lock. The
renderer mirrors this in `App`'s `branchAction`: one project's tree and sync buttons stop offering
actions while one runs, and the git pane's own BRANCHES bar shows it (see "One progress indicator
per pane"). `BranchActions.run` is the one way in — a view asks its own question first (it knows
the remote, the branch, the file count), then hands over a label and the call.

Two things the tree needs cost no extra git process. `readRefs` asks `for-each-ref` for `%(symref)`
alongside the name, empty except for `<remote>/HEAD` — that's `defaultBranch`, and "Update from..."
merges its *remote-tracking* copy, since auto-fetch keeps that current while local `main` may lag;
tags are one more argument to the same call. `state.operation` — the merge/rebase git stopped
mid-way, which "Abort" needs — is three `stat` calls in the git directory.

A remote's url is read once on project open and again after `.git/config` changed — where a remote
is added or repointed, here or in a terminal (`Repository.loadRemoteUrls`) — then merged into every
emitted state: it changes about never, so the refresh path spends its processes elsewhere. The merge
(`Repository.emit`) also lists a configured remote `for-each-ref` can't see yet — an empty clone, a
`git remote add` before the first fetch — since without it there'd be nothing to push to, and puts
`origin` first: `remotes[0]` is the remote every command that names one uses, and `for-each-ref`
sorts, so `backup` would otherwise beat it.

The project row carries repository-wide entries (open in terminal, show in file manager, copy path,
view on host, change remote url, close) — nothing touches the working tree there; those actions
live in the git pane, where their target is on screen. "Open in terminal" is a shell tab in this
window, created and brought to front like any other.

### Talking to a remote

Every command reaching a remote — fetch, pull, push, force push, deleting a branch/tag remotely,
pushing a tag — runs with `NETWORK_ENV`, all aimed at stopping git from asking a question:
`GIT_TERMINAL_PROMPT=0`, an empty `GIT_ASKPASS` (unset, git falls back to the terminal the other var
avoids), and `ssh -oBatchMode=yes` — the last only where the user has configured no ssh of their
own (`GIT_SSH`, `GIT_SSH_COMMAND`, `core.sshCommand`, read once per repository), since
`GIT_SSH_COMMAND` outranks all three and a plink or `ssh -i` setup would otherwise fail from here
alone. There's no console to answer in, and a command waiting for an answer that can't come holds
the repository's one action slot open indefinitely. Credentials come from the user's credential
helper or a provider token, or not at all — TET writes nothing into that machine-wide helper.

`LC_ALL=C` pins git's own messages so `runNetwork` can match two of them (`could not read Username`/
`Password`, `Authentication failed`) into `authRequired` — there's no exit code for it, every fatal clone error
is 128, and an unpinned `LANG=de_DE` machine would answer in German and match nothing. A repository
git can't find stays out of that list on purpose: GitHub/GitLab answer 404 for both a private repo
and a typo, so credentials would be a guess.

`authRequired` is what the add-repository dialog's clone acts on: the clone runs with no
credentials, and only when it comes back short does `CloneAuth` appear — accounts for *this host* on
one side of a switch, a token on the other, never both. A typed token is validated and stored as an
account on the way through. An ssh url never gets there, since a missing key fails with a message
none of the patterns match — the truth, as no token would have helped.

Ahead/behind are read from the `git status --branch` header a refresh already asks for
(`main...origin/main [ahead 1, behind 2]`), not a separate `rev-list`. `[gone]` counts as no
upstream.

Each repository also fetches by itself every ten minutes (GitHub Desktop's interval), **silently**
on failure — a remote with no credentials entered would otherwise notice six times an hour for
something nobody asked. A fetch the user pressed a button for reports like anything else. It does
not take the action slot: an action clicked while it runs (an unreachable host can take a minute to
time out) waits for it in `runAction` rather than being refused for a command nobody started.

A refresh the user's own action asks for runs *after* the one already underway, not merely joins
it: a commit's `add --all` wakes the watcher while the `commit` still runs, and that refresh reads a
staged, uncommitted tree — coming back only through the schedule left the pane showing it for two
seconds after the progress bar had stopped.

The branches header carries three buttons — fetch, pull, push — and push doubles as GitHub Desktop's
"publish" for a branch the remote's never seen (`--set-upstream`). Pull with rebase and force push
were offered once and taken out with the old branch bar; a rebase and its force push are exactly
the kind of command that belongs in an agent's terminal, where the conflict is visible.

### The diff

A diff is read with `--ignore-all-space` only while the dialog's whitespace toggle is on, and
synthesised for an untracked file (git has nothing to compare). The view
reads its own file for shown lines on demand. A hunk header with a non-empty gap above it gets an
unfold button; opening it asks `repo:file-lines` for exactly those lines — context lines are
identical in both versions, so the working tree is the only source and git isn't run again. The end
of a file is never a gap, since nothing in a diff says how far past the last hunk it goes. Opening a
gap rebuilds the `FileDiff` the view renders, so Shiki colors the new lines with the rest.

An image is not "Binary file." — `readDiff` recognises it by extension and hands both versions to
the renderer as data URLs; the committed one goes through `git show HEAD:<path>` read as a *buffer*,
since utf8 would mangle every byte. SVG stays out of that list: git diffs it as the text it is.

### Editing

The diff dialog doubles as a plain code editor — a pencil icon toggles Diff/Edit for a diffable
file, and Edit is the only mode for a file with nothing to diff (a tree file the changes list never
named). `CodeEditor.tsx` mounts one Monaco model for the dialog's whole time on that file: `path`
and `content` are read once, at mount, never re-synced under the user — `DiffDialog` only mounts it
once it already has the right file's content and unmounts it the moment another file is chosen — a
look-and-fix surface, not a multi-file editing session.

`monaco-core.ts` reproduces `editor.main.js`'s own import list minus every one of its ~80 Monarch
languages and every language *service* — find, folding, bracket matching and the rest of the plain
editing contributions stay, format, rename, completions, hover, diagnostics and go-to-definition go,
since nothing here registers a provider for any of them. Re-diff it against
`node_modules/monaco-editor/editor/editor.main.js` on a monaco upgrade, since that file isn't a
public API. Coloring goes through the same shiki instance and theme the diff view already uses
(`ensureLanguage` in `editor.ts`, wired in via `@shikijs/monaco`), so a token reads identically in
both places; `applyChrome` then layers tet's own `--vscode-*` colors on top, since monaco's
`defineTheme` can only inherit from its own built-in themes, not from shiki's. The worker is loaded
through `getWorker`, not the newer `getWorkerUrl` — a module worker built from the latter can fail
to start from a `file://` origin.

Saving goes through `Repository.writeFile`, guarded by the mtime the file was read at: a save
landing after an outside edit (an agent, a terminal) is refused rather than clobbering it. An
outside edit arriving while the file sits *clean* in the editor is instead folded into the model in
place (`DiffDialog`'s own effect, keyed on `version`), so undo history and the cursor survive — left
alone entirely while dirty, since the user's own unsaved edit wins until they act on it themselves.

Keybindings are a curated preset (`keybinding-presets.ts`, one per popular editor/IDE, chosen in the
Files tab of Settings) layered over tet's own defaults (`keybindings.ts`) — trimmed to the commands
this reduced contribution set actually registers: line comment/delete/copy/move, multi-cursor,
fold/unfold, find/replace. Left out on purpose: chord bindings (`parseKeyCombo` only understands one
combo per command) and every provider-dependent command — format, rename, organize imports — since
there is no language server behind any of them. No format command exists yet as a result; adding one
is a separate question of what would drive it, not a gap in the keybinding table.

### Where we follow GitHub Desktop rather than git's default

- Discarding is not `git checkout --`: a file HEAD doesn't know is moved to the trash
  (`shell.trashItem`), not deleted, so it stays recoverable. `git restore --source=HEAD --staged
  --worktree` covers everything else, index and worktree in one command; a rename needs both paths
  since only the old one is in HEAD.
- Deleting a branch is `git branch -D`. `-d` would refuse an unmerged feature branch with a message
  this pane doesn't show; the risk is what the question says out loud instead.
- A `stash@{n}` is a position, not an identity: dropping one renumbers the rest, so nothing holds a
  ref across a refresh. Rows act on the last refresh's report, and all three stash commands refresh
  after themselves.

### What the git view deliberately does not do

Built at some point and taken back out, so don't re-add without being asked: a commit UI with
per-file/per-line staging (what stayed is "commit all", a button and a message prompt); history, graph, cherry-pick, revert, squash, reorder; bisect, submodules;
conflict resolution beyond aborting; side-by-side diff; discarding single lines. A git command
needing a list, a message or a per-line decision is exactly what an agent should be asked to do,
where the answer, the conflict and the fix are all visible.

PRs and CI status are still open. Provider accounts aren't a login of the pane's either — they live
in the add-repository dialog, the one place talking to a host rather than a repository.

### Keep git off the main process, and count its invocations

Each of these was paid for once and measured; the numbers are in the comment at each site.

- Git stays in its own process — added to the main process it puts typing lag back one command at a
  time, since that process also relays pty output and has to stay responsive.
- Starting git is what costs, so count *invocations*. `readState` gets by with two (`git status
  --branch` reports branch and changes; only detached HEAD needs a third); anything added to the
  refresh path has to earn its process — `readStashes` is the third one a refresh spends.
  `listIgnored` (the Explorer's `excludeGitIgnore`) is deliberately *not* on that path: one
  process per listing of the Explorer tree, and only when a project opted in.
- A refresh finding events waiting goes back through `scheduleRefresh` rather than re-running at
  once — the immediate path bypassed the debounce and turned a busy working tree into an unbroken
  chain of git processes.
- `readStatus` runs `git --no-optional-locks status`: without it, writing the index back is itself a
  filesystem event that schedules the refresh that writes it again. Don't fix that with another
  entry in `isIgnoredEvent`.
- `src/main/event-loop-monitor.ts` runs every session, writing stalls to `event-loop.log` in
  `userData` only — the app is usually started from a shortcut, where a console line goes nowhere.
  Not behind a switch on purpose, so a stall is noticed while working rather than while looking for
  it. The file is rewritten at every start. `logSlow` names a block directly rather than leaving it
  to a stall sample's "ran last" guess, for work whose own duration is worth knowing regardless of
  whether it happened to line up with a sample — `Repository.emit`'s `JSON.stringify` of the next
  state (labeled `"emit"`, since it runs after the git process a refresh started has already
  finished) and a session listing's per-line `JSON.parse` during reconcile.

## Saved commands

The sidebar's lower half is a project's saved shell commands, living under a `commands` key in a
`tet.json` in the repository's own root (`src/main/commands.ts`), not TET's `userData` —
they describe the project, so they travel and can be committed, which also means the file shows up
as untracked until someone commits or ignores it. The key was `actions` before a rename; nothing
reads that spelling now, so such a file looks unconfigured and the wand fills it again.

A saved command is a command line plus, where not obvious, a `name`, a `cwd` and an `env` — a plain
string when none of those is needed, an object once one is (`{"command": "npm run build", "cwd":
"web"}`). `name` is a label only: the row shows it *instead of* the command line, a tooltip away.
The command is what you'd type standing in that folder — `npm run build`, not `npm run build
--prefix web`.

`env` exists because no syntax writes a variable *into* a command that works everywhere:
`PROFILE=DEVELOPMENT java -jar target/app.jar` is POSIX PowerShell reads as a command name, and
`java -jar` has no flag for it either. So it's a field set on the process (`SpawnOptions
.envOverride`), and it outranks the machine's inherited environment — the one case where the user's
own default loses, because they wrote it next to the command.

The `+` dialog asks for all of them; "Edit..." is the same dialog pre-filled. It doesn't ask about
`shell`, which is carried over rather than dropped — editing must not quietly change how a command
starts. The environment field is written the way you'd type it (`PROFILE=DEVELOPMENT PORT=8080`),
and `parseEnv`/`formatEnv` read/write it with the same `splitCommand` the command goes through, so
`NAME="a b"` means the same everywhere — why both live in `src/shared/`. `prompt` carries the
optional fields as `extras`; `name` is one of them even though `valueIndex` places it above the
command, since only the answer's own field can hold the dialog back.

**Running one opens a terminal tab for it.** The tab's *process is the command*, in its own
directory, ending when the command does — nothing buffered or summarised, which is what a build
needs. The tab is labelled with `name` if the command has one, the command line otherwise — a
shell tab has no session to take a title from — and closing it kills the process like any other
terminal.

**There is no shell in between.** `splitCommand` reads the saved line as a program plus arguments,
started directly — the same on every machine, and why `env` is a field: with no shell to interpret
anything, a pipe, redirection, `&&`, `$(...)` and `$VAR` don't work, on either platform. Quotes
group one argument and are dropped; a backslash is literal, since a Windows path is full of them.
Where the line goes on Windows is `resolveCommand`'s call (`src/main/pty.ts`): a native `.exe`
starts as itself, a `.cmd` shim (`mvn`, `npm`) goes through `cmd.exe`, and a spaced argument survives
both (measured, not assumed).

An operator surviving the split as its own word (`&&`, `|`, `>`, ...) is refused with a notice
naming it, rather than passed to the program — `rm x && y` would ask `rm` to delete two files called
`&&` and `y`. Such a line comes from a file written for a shell, so it must fail loudly. The way out
is `"shell": true`, handing the line to `AgentDefinition.runArgs` — the same shell project shell tabs
use, `-NoProfile -Command` on win32, `-c` elsewhere. That entry then only works where it was
written, which is why the wand's prompt deliberately omits it: what an agent writes into a
repository should run everywhere.

Either way `createCommandTab` is `createTab` with a program, arguments, a directory and an
environment, so a saved command's terminal shares the lazy spawn, output batching and close path of
every other tab.

A tab opened from outside the terminals pane — a saved command's, or a project row's shell — is
brought to front through `App.showTab`, which activates it in the pane it lives in (the focused
one, for a tab never placed) — a one-off write into the layout, not a prop the pane re-applies:
the tab list changes on every status update, and re-applying a selection would drag the user back
out of whatever they moved to.

Because a saved command's process ends every run, `TerminalSession` tells the two apart by exit
code: `stopped` for a clean one (or anything TET killed), `error` only for a process that failed
on its own. **Nothing draws the difference yet** — the tab strip marks both `.tab.inactive`.
Worth doing, deliberately still open — don't invent the look.

Reading a `tet.json` that's missing, unparseable or oddly shaped is simply no commands — it's
the user's file, and half of it being someone else's isn't a reason to throw. A project with no
`tet.json` **at all** gets its commands looked up straight away, unasked — nobody's set it up
here. So `readCommands` returns `null` for a missing file and `[]` for one that's empty on purpose —
a list someone emptied stays empty. Runs at most once per project per session, guarded by a ref.

The array's order is the screen order — no separate field, since two records of the same thing
drift apart. Rows reorder by dragging, like the project list, through `useDragReorder`
(`src/renderer/components/drag-reorder.ts`), which also holds the drag details (own MIME type per
list, insertion index off the event, the strip below the last row). The wand slots new entries in
behind the last command running the same tool (`mergeCommands`); a drag outranks that, since it only
decides where something *new* lands.

The wand beside `+` asks an agent to fill the list — the first installed one with `askArgs`, in
`AGENTS`' own order (claude, opencode, codex), given `SUGGEST_PROMPT`. That prompt is deliberately
concrete about where commands hide, since a model told only "find the commands" answers with what
it'd type in a generic project of that kind. It also asks for the *start* command, the one nobody
writes down. The reply is expected as a JSON array, read as the first bracketed run in it, since
"answer with nothing but" still tends to arrive fenced. No cap on how many come back, but the
prompt asks for judgement — the commands a developer types, not the lifecycle hooks and CI scripts
a `package.json` is half full of — and that has to stay unambiguous: saying "prefer what's run by
hand" and "list all of them" at once let a model pick either. What comes back is added without
review — a wrong entry is one
right-click from deletion.

One `CommandList` serves every project, so anything it starts must name the project it asked about
— the wand can run for minutes, and its answer belongs to that project, not whichever is on screen
when it returns. Projects being looked up are kept as a set; the result only shows if that project
is still the one on screen.

## Explorer

The diff dialog's Explorer tree (`Explorer.tsx`, fed by `Repository.listExplorer`) is configured
from the same `tet.json` as the commands, shaped like a VS Code `.code-workspace`: `folders` at
the top level, the rest nested under a `settings` object keyed by VS Code's own dotted names —
they are VS Code's behaviours, read by `readExplorerView` in `commands.ts` as defensively as the
commands and handed to the renderer *inside* the `ExplorerListing`, so the tree gets data and
configuration in one read and never parses the file itself:

- `folders` — `[{"path": "src/main/frontend", "name": "frontend"}, {"path": "."}]`, VS Code's
  multi-root workspace: one top-level node per entry, labelled `name` or the folder's own name,
  open by default, overlap allowed (`.` contains `src/main/frontend` again). Each file is listed
  once; the renderer builds one subtree per root, keyed `<rootIndex>:<path>` so the same file
  under two roots folds and scrolls independently, and reveals a selection in the *innermost*
  root containing it (VS Code's `getWorkspaceFolder`). The walk covers only the outermost roots.
  Missing or empty means the whole repository as one tree — an empty explorer is useless, so
  removing the last root deletes the key rather than leaving `[]`.
- `settings["files.exclude"]` — a map glob → `true`, matched with `path.matchesGlob`
  against the **repository-relative** path of every entry during the walk (so `**/node_modules`
  hides them at any depth, `node_modules` only the top-level one); a matched folder is not
  entered. Repository-relative rather than per-root, as VS Code does it, so the menu entry and
  the file mean the same path. `.git` is hidden regardless.
- `settings["explorer.excludeGitIgnore"]` — default off: one `git ls-files --others
  --ignored --exclude-standard --directory` per listing (see "count its invocations"), files and
  collapsed directories skipped by the same walk.
- `settings["explorer.compactFolders"]` — **default on**: a folder whose only child is a
  folder becomes one row (`src/main/java`), applied last on what is shown — after the filter — the
  row being the innermost folder for folding, reveal and the menu. Roots are never compacted.
- `settings["explorer.sortOrder"]` — default `default`; `modified` is the one value that costs,
  a `stat` per entry, so mtimes are only read for it.

Three of these are reachable from the tree's context menu, all writing `tet.json` through
`commands.ts`'s `patchSetting`-style helpers and reported like create/rename/delete
(`GitActionResult`, the LOCAL CHANGES bar): "Add Folder to Workspace" on a folder (the first add
writes `.` down alongside it, VS Code's move when a single-folder window gets a second), "Remove
Folder from Workspace" on a root, "Exclude from Files" on a folder or file (the exact path as
pattern). `name` and the three `settings` entries are file-only — as in VS Code, whose own
Explorer offers none of them either. The watcher already reports every write of `tet.json` as
`commands:changed`, so the dialog re-lists on it whoever wrote the file.

## Settings

One dialog for everything TET keeps about *itself* rather than a repository — the one button in
the window belonging to neither a project nor a pane. It sits right of the layout picker, in the
`.tab-strip-actions` of pane "a" (see "Split view"), handed down the same way as `onPresetChange` —
beside the git toggle regardless of preset. An ordinary `.icon-button`, the same as the git toggle
and layout picker beside it. It lived at the title bar's end once, drawn as a platform window
control; the title bar is now the app's name and the drag region alone.

It asks nothing — a switch applies the moment it's flipped, like VS Code's own settings — so one
button closes it. Tabbed (Notifications, Shortcuts, Files, Info) with the add-repository dialog's
own strip (`.dialog-tabs`), which is why neither dialog has a `.dialog-title`: the selected tab
names what's under it. Height is fixed to the fullest tab so switching doesn't resize under the
pointer. Shortcuts just lists `shortcuts.ts`'s own table (see "The keyboard belongs to the
terminal") — nothing there to flip. Files carries the diff dialog's Explorer settings (the three
`tet.json` entries its tree's own context menu also writes — see "Explorer") *and* the editor's
keybinding preset picker in one tab rather than two, since both are about how that dialog reads or
is worked in for a project; the preset half renders even with no project open, since unlike the
Explorer settings it isn't per-project (it lives in `settings.json`, not `tet.json`). Info reads
`app:info` once, on open.

Values live in a `settings.json` in TET's `userData` (`src/main/settings.ts`), written whole
from memory and read back defensively — a wrong-typed key falls back to its default rather than
reaching an agent as `undefined`.

**A setting reaches an agent through `AgentPaths`**, handed over rather than imported, so the
persisted copy stays the only one. Read in `pathsFor`, i.e. at `prepareSpawn` — the honest limit of
a switch: Claude Code reads its generated `--settings` file at startup, opencode's notifier is built
around the event stream when its server comes up, so an agent gets its notification setup once and
can't be reached afterwards. A change applies to projects opened after it — a Claude or Codex
runtime is prepared once per project, and re-preparing it under running tabs would leave a gap in
which no marker watcher stands — and the dialog says so.

Deliberately not in there: marks on a tab that finished out of sight or is waiting on an answer.
Neither is a notification to turn off, but how such a session is found again (see that section).

## Everything the user is told is a notice

`notify(severity, message)` from `src/renderer/components/Notices.tsx` is the only way to say
something to the user — no exceptions, no view keeps a message of its own, nothing written into the
pane where it happens. A plain function, not a prop or hook — modelled on VS Code's
`window.showErrorMessage` — so anything that fails reports without a threaded callback. The main
process uses the same channel: `app:notice` carries a `Notice`, handed straight to `notify`.

All three severities behave the same: a notice disappears after 8 seconds or on click, whichever
comes first — `error` and `warning` no longer stand until dismissed by hand. An identical message
already standing is dropped, not stacked. They sit over the window's bottom right corner rather
than the column with everything else — arriving must not resize panes underneath — and only the
messages themselves take the pointer.

Not a notice: a status — a tab colored for an uninstalled agent, the progress bar, the head shown
next to a project's name. Those are conditions a view draws for as long as they hold.

Nor a *question*. `src/renderer/components/Dialog.tsx` puts both kinds, built like `notify`: a plain
function anything can call, with one `Dialogs` next to `Notices` drawing whatever's pending.
`confirm` resolves to whether the user went through, and whether the one optional checkbox was
ticked. `prompt` resolves to a name or null — renaming a session goes through it, focus landing
selected in its field. One question at a time; the overlay blocks a second. Naming something inline
was tried and reverted: a tab's too narrow for a name, and a field committing on blur loses what was
typed to a stray click.

The main process asks nothing — `repo:delete-branch` and `repo:discard` just do it; the question
lives in the view offering the action, which knows the remote or the file count. Electron's native
`dialog.showMessageBox` isn't used: it looks like the OS in an app that otherwise looks like VS
Code.

Only ask before something irreversible. A question always answered the same way isn't worth asking.

## One progress indicator per pane

Not one per project, and not one shared bar for the whole window: every pane that can be slow
carries its own `.progress-bar`, showing only what is happening in *it*, never a reason that
belongs to another — a terminal pane's own agent starting, the git pane's own branch command or
file action, the diff dialog's own read. What is slow is drawn where it is happening, not
centralised out of habit; a single spot for the whole app was tried first and read as "something,
somewhere" instead of pointing at the one thing actually running. One component serves all of them:
`ProgressBar` (`src/renderer/components/ProgressBar.tsx`), dropped into whichever header or bar
around it declares `position: relative` (a pane's own tab strip, a `.section-header`,
`.diff-dialog-bar`), so every pane's bar looks identical without a rule of its own. Its bit is a
fixed number of pixels moving at a fixed number of pixels per second — measured width, derived
duration — not VS Code's 2%-of-the-width recipe, which made a narrow section's worm a third the
length of a wide pane's and a third as fast once several stood side by side. Never add a second
inside one pane — a new slow reason there is a new condition feeding the one it already has, not a
bar beside it.

- **Terminal panes**: `Pane`'s `showProgress` prop — a new agent starting in it, a runtime being
  prepared, a CLI not yet past its first frame (`TerminalDescriptor.starting`, read off
  `session-manager.ts`'s per-tab indicator count — `acquireIndicator`/`releaseIndicator` take a
  `tabId` where one exists, a count and not a flag because a tab's setup and its first frame
  overlap and a tab can be put back after a failed close — surfaced through `App`'s
  `marks[…].starting` and `TerminalsPane`'s `startingHere`). The one reason with no tab of
  its own to point a pane at — the session listing at bootstrap, before any tab exists yet —
  falls to pane "a" instead (`TerminalsPane`'s `externalBusy`).
- **The git pane**: two bars of its own, one per section, because its two headers are two
  different kinds of action — `GitPane`'s `branch.busy` (checkout, branch/tag create/rename/delete,
  stash apply/pop/drop, merge, rebase, abort, fetch/pull/push: everything routed through
  `BranchActions.run`) under BRANCHES, and its own local `acting` (commit all, stash push, discard, ignore —
  everything routed through its own `act`, since they start from the changed-file list this
  section owns) under LOCAL CHANGES. Stashing changes goes through `act` rather than `branch.run`
  for exactly that reason, even though it used to share the tree's lock.
- **The diff dialog**: its own `busy` state under `.diff-dialog-bar`, fed by `DiffView`'s `onBusy`
  (reading the diff, then colouring it) — no longer bubbled up to `App` at all. Since the bar
  reports it, `DiffView` itself writes no "Loading..." of its own — it just goes empty while one
  of the two is running.
  The changed-file pane beside it has a bar of its own under its LOCAL CHANGES header, for a
  discard-all or an ignore started from that list — a different pane, a different reason.
- **The command list**: its own bar under COMMANDS, for the wand reading the project — the wand's
  icon used to turn into a spinner instead; taken back out once every other action button in a
  pane with its own bar (fetch, pull, push, stash) stayed a plain icon and only dimmed, which is
  what an action button disabled for being underway rather than idle does everywhere else now.

**A spinner in place of an icon is not a second one of these.** The bar is about the pane; a
spinner is about the one thing the icon already stands for. `SpinnerIcon` with the `spinning` class
takes that icon's place, never a slot beside it — a tab's agent icon while its session works a
turn (`TerminalDescriptor.busy`) is the one case left now that the wand's own bar took over from
its icon. The project row is the one place a spinner stands alone, having no icon to replace.

## Both ends of a turn

A session says whether it's *working*, *stopped for an answer*, or *finished out of sight* — one
mechanism read at three points of the same turn, drawn both on the tab and its project's row, so a
project off-screen still shows what its sessions are doing:

- **working**: a spinner, for as long as the turn runs.
- **waiting on you**: a question mark. The turn's open but nothing's moving — a permission prompt,
  an elicitation, or an `AskUserQuestion`. Unlike the bubble this is not a one-off notice: it states
  a fact that stays true for as long as the turn stands open, so it is only hidden — not cleared —
  while the tab is in front of the user, and comes back the moment it no longer is, still unanswered.
  `hasBusyTab` (`App.tsx`) excludes a tab that is also waiting, and the tab's own spinner
  (`Pane`) checks the same, so a stopped session never spins anywhere — not in the project row
  beside its question mark, and not on the tab in front of the user, where the question mark is
  hidden and the spinner would otherwise step in for it. A stopped session is precisely *not*
  working, the more useful of the two truths.
- **finished out of sight**: a speech bubble. One shape for one thing — a sidebar bell was tried and
  reverted, since two glyphs for the same condition read as two conditions. Goes away when the tab's
  in front of the user; a one-off notice of a turn that already ended, unlike the still-standing fact
  a question is.

In the project row all three are buttons stepping through their sessions one press at a time. The
bubble empties its list as it goes, since a seen session stops being marked; a watched session keeps
working, so the spinner instead keeps a cursor per project (`App.busyCursor`, a ref — changes what
the next press does, not what's shown) and wraps around. The question mark's list shrinks the same
way while its session stays in view, but is not itself the source of truth — it comes back on its
own once the tab is no longer on screen and the turn still hasn't moved.

**On a tab all three take the agent icon's place** rather than a slot of their own — the tab is only
as wide as its label. One slot means a ranking: **waiting > working > finished** — a session stopped
on a question is precisely *not* working, the more useful of the two truths, and working outranks
finished because a newer turn's mark still shows once it stops. In the sidebar, with no icon to
replace, all three sit next to each other left of the close button. All are `--vscode-focusBorder`
under one `.session-mark` rule — three states of one thing must not read as three kinds of thing.

**Whether a question is *shown* is decided in `App`**, beside the bubble's rule (`waitingTabs` next
to `markedTabs`) and for the same reason — the main process holds the state but not which tab is on
screen, and two views applying the rule themselves would be two chances to disagree.

**Nothing here is read off the terminal.** Each agent knows when its own turn starts, stalls and
ends, and `AgentPaths.onSessionBusy` / `onSessionWaiting` / `onSessionFinished` say so:

- opencode reports `session.status` (`busy`, then `session.idle`) on the event stream TET's
  already subscribed to; `subscribe` carries `properties.sessionID` and `properties.status.type`
  alongside the event's `type`, verified against the binary's own `session.idle` schema, its
  `SessionStatus` union, and its `{type, properties}` envelope. A question is `permission.asked` /
  `question.asked` on the same stream; `session.error` shares their toast but not the mark, since an
  error happened rather than a question standing open. Those plus `session.*` (for the listing's
  watch) are the only types read — a frame naming none of them is dropped on a string test before
  parsing (`CONSUMED_EVENT_TYPE`), since most of the stream is a streaming answer's
  `message.part.updated`, and parsing every one was main-process CPU spent while the ptys wait.
- Claude Code's hooks are separate processes that can't call back into TET, so each point
  `touch`es an empty file named after the session id: `UserPromptSubmit` into `<agentDir>/busy/`,
  `Stop` into `<agentDir>/finished/`, and `Notification` (`permission_prompt|elicitation_dialog`)
  plus `PreToolUse` (`AskUserQuestion`) into `<agentDir>/waiting/` — `watchMarkers` picks them up
  (`src/main/marker-watch.ts`, shared with Codex below, as is `buildMarkCommand`, the script every
  unguarded marker hook of either agent is; only Claude Code's Stop hook has a script of its own).
  The busy hook shares `UserPromptSubmit`
  with the command printing the context file, so it must stay **silent** — anything it writes gets
  appended to the prompt — and must exit 0 regardless, since a failing hook there can hold the
  prompt back. `AskUserQuestion` needs its own hook since it's a *tool*, not a Notification event;
  `idle_prompt` is deliberately not matched, since it fires after a turn ends, which the bubble
  already covers.
- Codex hooks land the same three markers the same way — `UserPromptSubmit` into `busy/`, `Stop`
  into `finished/`, `PermissionRequest` (an approval is about to be asked) and `PreToolUse` matched
  to `request_user_input` (a question tool is about to run) into `waiting/`. What Claude Code
  doesn't need: Codex only *runs* a hook it has decided to trust — see "Codex's hook trust" below.

**No agent reports that a question was answered** — Claude Code and Codex would need a hook process
per tool call for their permission prompts — but TET doesn't need them to: the answer is typed
into the tab that asked, and every keystroke and click reaches the pty through
`ProjectSessionManager.write`. So a question clears on exactly two things: input that can be an
answer (`answersQuestion` — Enter, a printable character, a mouse click; not arrows, Tab, a bare
Escape, mouse motion or the wheel), and either end of a turn (`setTurn`, since a question can only
stand open *within* a turn; the transcript net that ends an interrupted turn clears it too). The
same for all three agents, which is the point — one rule in one place, no per-agent signal to keep
in step. Unlike the bubble, merely looking at the tab does **not** clear it (`markSeen` only ever
touches `finishedAt`): a standing question states a fact that is still true however long it is
looked at, where a finished turn is a one-off notice of something that already happened.

`watchMarkers` sweeps its directory on a timer **as well as** watching it: on win32 `fs.watch` can
silently miss a new file, stranding that turn's spinner forever (observed: a marker sat in
`finished/` long after being written, watcher healthy the whole time). The sweep costs nothing in
the git section's terms — a `readdir` on an empty directory is a syscall, not a process. The three
kinds are watched and swept separately, so a `busy` the watcher missed can be found *after* the
`finished` of the same short turn: every marker carries its mtime (`onSessionBusy`'s `at`), and a
signal made before the one last applied to its tab (`TabState.signalAt`) is dropped — applied in
arrival order it left the spinner running until the next turn ended.

**Claude Code runs no Stop hook for a turn the user cut short**, so that end never reaches
`finished/` — an escaped prompt or rejected tool call left the spinner running until the next turn
ended. The net is the transcript itself, which records a `system`/`turn_duration` entry at *every*
turn end, hook or no hook — the session listing reports it as `AgentSessionInfo.turnEndedAt`, from
the same tail scan `custom-title` already needs, and `reconcile` is the one place it's read.

That entry alone does not say *why* `finished/` stayed empty, though, and there are two reasons: an
interrupted turn (no hook ran at all), or one whose Stop hooks ran and legitimately chose not to
write the marker (`stop-guard.ps1`'s own `background_tasks` guard, above). Comparing `turnEndedAt`
against `busySince` cannot tell those apart — both leave a `turn_duration` entry newer than the busy
that started the turn — and conflating them once cleared the spinner on a session a background job
was still visibly running in, a monitor watching a long job's own log output and turning matches
into fresh turns. The tail scan resolves it instead: a completed turn's
`turn_duration` has a `stop_hook_summary` as its `parentUuid` (confirmed in the transcript — an
interrupted one has no such parent, no hook event covering an interrupt), so `turnEndedAt` is only
even set when that parent is missing. A turn hooks ran for is left out of the listing entirely,
whatever `stop-guard.ps1` decided — the marker mechanism is authoritative for it either way, and
this net exists only for the turn hooks never got a chance to run for at all. It leaves no mark:
reaching us this way means the user cut it short in that tab.

Codex has the identical gap for the identical reason — no hook fires on an interrupt either — and
closes it the identical way: its own rollout records `task_complete`/`turn_aborted` at every turn
end regardless of how it ended, and `AgentSessionInfo.turnEndedAt` is read from that scan too
(`src/agents/codex/sessions.ts`).

Reusing the Stop hook is the point: it already carries the `background_tasks` guard, so a turn that
only launched a subagent and returned isn't "finished" — a guess from the TUI's output would lose
exactly that. The hooks register regardless of notification settings; only their toast is optional,
same for the two marking a question. Anything sitting in the directories at startup is deleted
*without* being reported — those turns ended before this window existed.

State lives as `TerminalDescriptor.busy`, `waitingAt` and `finishedAt`, per tab in the main process
like `sessionId`, so a closed tab takes it along. `finishedAt` is a time, not a flag, since the
project row's mark opens the oldest one first, and `setTurn` writes both at once — ending a turn is
exactly "stop spinning, leave the mark." Two halves keep it honest:

- the **main process** sets it, never asking whether it should, since it can't know what's on
  screen. A turn reported before any tab has claimed its session id is held in `pendingTurns` and
  applied on a later reconcile — on a **timer** (`PENDING_TURN_TTL_MS`), not until missing from the
  session listing, since `UserPromptSubmit` fires before Claude Code writes the transcript that
  listing reads; dropping on absence lost the spinner for a new tab's first turn. A tab whose
  process stops or errors is cleared of `busy` immediately, since a killed CLI never reports its own
  end.
- the **renderer** decides what's *shown* and clears what was seen (`terminals.seen`), the rule
  living once in `App.markedTabs` so two views can't disagree. Only the mark follows that rule —
  `busy` draws wherever the tab is, on screen or not, since "this one is working" matters precisely
  while you're looking elsewhere.

`App` holds every project's tabs for the same reason it holds repository states: the project list
needs all of them at once, while a `TerminalsPane` only knows its own. The selection lives there
too, one per pane of the split (see "Split view") — a pane asks for a change through
`onActivateTab` rather than owning it.

Left deliberately unmarked: saved-command tabs (see "Saved commands").

## Ending a session

A session is **asked to quit before it is killed** (`TerminalSession.stop`): it gets the Ctrl+C
bytes its own convention expects (`AgentDefinition.quitPresses`, none for the shell), and only what
is still running afterwards is killed. `stop` resolves once the process is actually gone, not once
a kill was asked for — `destroyTab` deletes what the CLI persisted right after, and must not race
a process still writing it.

The reason is that a hard kill never lets a CLI run its own exit handlers, and at least one agent
keeps something there that matters: Claude Code arms a record in `~/.claude.json` while its
fullscreen renderer boots and clears it again ten seconds later, counting every process that died
in between as a strike — twice, and it turns its fullscreen renderer off machine-wide. Restarting
tet is exactly what killed those, since a tab spawned at startup sits inside that window. Its own
exit handler clears the record; nothing else does.

`\x03` only works because the TUI is in raw mode by then and reads it as an ordinary byte — in
cooked mode (a plain shell, the moment before a TUI starts, or **one already shutting down**)
ConPTY turns it into a process-level CTRL_C_EVENT that kills without running anything. Hence each
agent gets exactly the count it asked for and no more, and each press returns early if the process
has already left. See "Never assume the agents behave alike" for what the counts are and why one
shared interval could not work.

Two consequences worth knowing before touching either: stopping is asynchronous, so `before-quit`
has to hold the quit back with `preventDefault()` and ask again once the sessions are gone
(electron tears the process down the moment a synchronous handler returns) — with a guard, or the
second ask is held back too and the app never quits. And `closeTabs` starts every doomed tab's stop
before waiting on any of them, so closing four tabs costs one grace period rather than four; the
loop after it stays sequential for the CLI calls that list and delete sessions.

## Agent-specific vs shared code

Each agent gets a folder under `src/agents/`, described by one `AgentDefinition`
(`src/agents/agent.ts`). The shared terminal layer never imports an agent's own code, only calls its
callbacks — a new agent is a new folder, one entry in `src/agents/index.ts`, one case in `AgentIcon`
(`src/renderer/components/agent-icons.tsx`). That last is the only agent-specific thing outside
`src/agents/`, since that folder belongs to the main process — a definition reaches `fs` and
`child_process`, and an icon there would pull JSX into that bundle and setup code into the
renderer's.

- `executable`, `args`, `env`, `versionArgs` — how to start it, and how to tell "not installed" from
  a spawn that failed for another reason
- `askArgs` — one question, answered on stdout, no terminal (`claude -p`, `opencode run`, `codex
  exec --ephemeral`); an agent without it is no candidate for anything that asks. A background
  question mustn't leave a session behind, or it returns as a tab next start: Claude Code takes
  `--no-session-persistence`, opencode titles the run and deletes it in `cleanupAsk`, Codex's
  `--ephemeral` skips writing the session at all
- `runArgs` — one command run *in* a terminal, ending when it does; saved commands use it, only the
  shell has it
- `sessions` — listing, resume args, rename, delete, optional `watch`
- `prepareApp` — the one hook about no repository at all, run once before any project opens; for
  what a killed run left behind (see below)
- `prepareSpawn` — async setup finishing before the first spawn, the only place an agent may write
  anything. Handed `AgentPaths`; a rejection marks the agent unstartable, so only reject for what
  truly makes it unusable (opencode's server, not a failed notification script).
  `AgentPaths.onSessionBusy`/`onSessionFinished` are the one thing reported back out of band — see
  "Both ends of a turn"
- `resolveUrlPrefix` — completes a url the agent's TUI wrapped across rows
- `createIsSessionReady` — the per-agent guess at "the CLI drew its first real frame," driving the
  progress bar
- `quitPresses` — how many Ctrl+C bytes make it quit by itself, so a session can be asked before
  it is killed (see "Ending a session")

### Never assume the agents behave alike

They are three separate products that happen to sit in the same kind of tab. Every time the same
question has been put to all of them, the answers differed — and the differences were only ever
found by **measuring the real binary through this same pty**, never by reading its source or its
docs, and never by reasoning from one agent to another:

- `createIsSessionReady`'s byte thresholds: 500 / 800 / 600, one per agent, all tuned by hand.
- `quitPresses`: Claude Code wants two Ctrl+C and withdraws the offer after about a second;
  Codex and opencode quit on one, and a second byte sent to a Codex already leaving *kills* the
  shutdown it would have completed. There is no single interval that serves all three, which is
  why it is a count per agent instead of one constant.
- The right mouse button: Claude Code and opencode take it themselves through mouse reporting,
  Codex deliberately leaves it to the terminal (`terminal-views.ts`).
- Colours: opencode's `"theme": "system"` adopts the terminal palette but swaps blue and magenta;
  Codex ignores the palette entirely until `-c tui.theme=ansi`.
- Turn signals: opencode has an event stream, Claude Code and Codex need hook processes touching
  marker files, and Codex only runs a hook it has hashed and decided to trust.

So when adding anything that touches how a CLI is driven, the default is a field on
`AgentDefinition` with a value per agent, not one shared constant with a comment guessing at the
others. And what goes in that field is what was measured — a value carried over from the agent
next to it is a guess wearing a number.

### The one database under opencode's servers

TET runs one `opencode serve` per repository, but a server opens the SQLite database of the
whole machine — every instance shares one `opencode.db`. Two consequences, both paid for:

- **They come up one at a time** (`OpencodeServer.queue` in `server.ts`): four repositories restored
  at startup once booted four servers in parallel, and the one that lost the race for the write lock
  died with `database is locked`. Waiting for the previous server's url is enough — by then it's past
  the setup that holds the lock.
- **What a killed run left running is taken down before the first of them starts**
  (`server-registry.ts`). Every path ending the app ends its servers too, but a killed process
  doesn't, and a server outliving its TET keeps writing to that same file. So each server is
  recorded in an `opencode-servers.json` in `userData`, and the next run kills what's there — but
  **never by pid alone**: pids are reused and by read time may be anything. Killed only once it
  answers on its recorded url with its recorded password, which only our own server can. One killed
  between spawn and reporting its url is never recorded and stays behind — nothing left to
  recognise it by.

The cleanup is what `prepareApp` is for: `main.ts` calls `prepareAgents(userData)` before any
project opens, since opening one asks the agent for its session listing, which alone starts a
server. Nothing out there waits on it — `OpencodeServer.start` holds the promise itself, since only
it knows which calls mustn't overtake it.

### Codex's hook trust

Codex only *runs* a hook it has decided to trust: a sha256 over a normalized form of its event
name, matcher and command, checked against a `trusted_hash` it reads back from its own config.
Handed an unknown hash, an interactive session opens on a blocking "Hooks need review" screen
instead of the chat — Codex's own answer to a hook being able to run commands outside the sandbox.

`src/agents/codex/hooks.ts` reproduces that hash and hands it in alongside the hook itself, via
`-c`, so the screen never appears — verified end to end against a real install, including through
`node-pty → cmd.exe /d /s /c → codex.cmd`, not just derived from source. Reproducing a private,
unversioned serialization is a real trade-off: if a future Codex release changes it, the hook shows
"Modified" instead of "Trusted" and the screen reappears once, the same as it would for a user who
hand-edited their own config — not silent, not a crash, but worth re-checking against
`hooks/src/engine/discovery.rs::hook_hash` in Codex's own source if it ever happens.

Two things only found by testing the actual spawn path, not by reading source: `-c key=value`'s
*key* is split on every literal `.` before any TOML parsing runs, so passing the trust key as the
key (it contains one, from `config.toml`) silently corrupts it — no error, no warning, the hash
just never applies. Everything — every hook definition and its trust entry — has to go inside the
*value* of one combined `-c hooks={…}` argument instead, where a real TOML parser handles the
quoted key correctly. And that one argument has to be built from TOML **literal** strings (`'…'`),
not basic strings (`"…"`) — the same reasoning `powershellSingleQuote`/`shellSingleQuote` already
apply to their own shells (see "Cross-platform requirement"): a form that needs no escaping over
one that does, since escaping a value already carrying a Windows path and an embedded `"` through
`cmd.exe`'s own re-quoting is exactly the kind of nested quoting that goes wrong.

Also why there's no persistent `codex app-server` the way there's a persistent opencode server
above: `$CODEX_HOME`'s SQLite state db is machine-wide, same as opencode's, and starting six
`codex app-server` processes in parallel against a *fresh* `CODEX_HOME` crashed two of them
outright — the identical `database is locked` race `server-registry.ts` exists to solve for
opencode, reproduced rather than avoided. Rename and delete go through a short-lived
`codex app-server` JSON-RPC call instead (`src/agents/codex/app-server-client.ts`, one process per
call, ~300–500 ms measured) — cheap enough for actions a user triggers rarely, and it never starts
two at once.

## Never touch the user's agent configuration

Everything TET generates lives under its own `userData` and is pointed at from outside:

- Claude Code: a generated settings file passed as `--settings`, layered by the CLI on top of its
  own config. `~/.claude/settings.json` is never read, written or replaced.
- opencode: `OPENCODE_CONFIG_DIR` on the **server** process (under `attach` the TUI is only a
  client). Additive — doesn't replace the user's own `plugins/`. Shared across repositories, since
  opencode pays a minutes-long install on an unfamiliar config dir; each repository's generated
  plugin needs a unique filename *and* a runtime guard on `TET_PROJECT_ROOT`, or every open
  repository's context gets appended to every message. Only written when content changes, since a
  changed plugin triggers a recompile.
- opencode again: `OPENCODE_TUI_CONFIG` on the **terminal** process, generated with nothing but
  `"theme": "system"` (`tui-config.ts`) — opencode otherwise draws its own palette and looks nothing
  like the window; `system` takes the terminal's colours, the `--vscode-*` ones xterm was handed.
  Layered on top of the tui config opencode already loaded, so a user with that variable set keeps
  their own file.
- Codex: `-c key=value` overrides, layered on top of the user's `config.toml` for that one process
  only — verified nothing is written back (`config.toml` diffed before/after several runs,
  byte-identical). `~/.codex/config.toml` and `~/.codex/hooks.json` are never read, written or
  replaced.

## Files other processes read

The context file and shell transcript are written by TET and read by a separate process — an
agent's prompt hook, or the agent's own file reads. Write beside the target and `rename` into place,
never in place — measured against writing in place and lost; on Windows a read landing mid-write
fails outright rather than returning partial data.

The one file crossing the other way — Claude Code's Stop hook writing into `finished/` — sits
outside that rule, since it carries nothing: the *filename* is the whole message, nothing a reader
could catch half-written. Codex's marker hooks the same way.

## Cross-platform requirement

Must work on Windows, Linux and macOS. Never add OS-specific behaviour without an equivalent for the
others.

- Build paths with `path.join`; route process spawning through `resolveCommand` (`src/main/pty.ts`).
- Generated `.ps1` files need a UTF-8 BOM — PowerShell 5.1 decodes BOM-less files as ANSI. Generated
  `sh` scripts must be LF, whatever the source's line endings.
- Anything written *into* a generated script needs literal quoting: `@'...'@` and `'...'` in
  PowerShell, `'...'` in sh. A repo folder or user name may hold a `$`, and the interpolating forms
  (`@"..."@`, `"..."`) read `$name` as a variable and `$(...)` as a command — which once printed
  half a repository's name in a toast and would have run whatever the other half said.
  `os-notify.ts` has the two helpers.
- Claude Code's hook shell on win32 varies (PowerShell, cmd.exe, Git Bash all observed). Avoid shell
  builtins and nested quoting; invoke a plain exe, e.g. `powershell -NoProfile -ExecutionPolicy
  Bypass -File "<script>.ps1"`.

## The keyboard belongs to the terminal

A terminal tab holds a foreign program owning every key while focused, and TET's handler runs
*before* xterm encodes anything (`attachCustomKeyEventHandler` in `terminal-views.ts`) — the window
can take any combination, so whether it can is never the question. **It takes nothing an agent could
have received**, decided by reading xterm's own `Keyboard.ts` rather than assuming:
`evaluateKeyboardEvent`'s ctrl branch requires `!shiftKey`, so `Ctrl+<letter>` is the agent's control
byte (`Ctrl+G` is `\x07`) but `Ctrl+Shift+<letter>` falls through every branch and sends nothing —
the opposite of what "xterm drops the shift" would suggest, why this got read rather than guessed
twice. `Alt+1…9` is out (`ESC 1`, readline's digit argument), so is `Ctrl+Tab`/`Ctrl+Shift+Tab`:
keyCode 9's case never looks at `ctrlKey`, so both are byte-identical to plain Tab/Shift+Tab — the
latter is Claude Code's own mode toggle. `Ctrl+,` and `Ctrl+Shift+.`/`Ctrl+Shift+,` are open: none of
those keycodes appear in any branch, modified or not. Shift+Enter, Ctrl+V and Ctrl+C are handled
*for* the terminal, not taken from it. None of the six window shortcuts close a tab — behind that
key is a live agent session that doesn't come back. They live in `src/renderer/shortcuts.ts`, the
one list both the capture-phase listener in `App.tsx` and the settings dialog's Shortcuts tab read
from, so binding and label can't drift apart.

**Ctrl+C is the one deliberate exception to "takes nothing an agent could have received."** With a
selection it always copies instead of sending `\x03`. Without one, a plain shell, Claude Code and
opencode get `\x03` (SIGINT) — the running CLI reads it as an ordinary byte and clears its current
prompt or interrupts a turn, the point of the key. Codex is the exception: what the byte does to it
is not what it looks like — measured through this pty, a TUI in raw mode reads `\x03` as an
ordinary byte and decides for itself, but the *same* byte reaching a process in cooked mode — one
still starting, or already shutting down — becomes a process-level `CTRL_C_EVENT` that kills it
outright, and closing the tab is Codex's equivalent action instead. Sending it deliberately is a
separate matter, with its own rules per agent (see "Ending a session"). Check a newly added agent
against this rather than assuming; `agentId === "codex"` in `attachCustomKeyEventHandler`'s Ctrl+C
branch is what currently draws the line.

## The renderer

- Terminal output goes straight to xterm, never through React state. Instances live in
  `src/renderer/terminal-views.ts`, outside React, keyed by project *and* tab — tab ids are only
  unique within their project — so they survive tab/project switches untouched. Arrives batched, one
  periodic flush carrying every terminal that produced something, so message count doesn't grow with
  the number of open tabs.
- An xterm is built the first time its tab is in front of the user (`TerminalHost` attaches on
  `active && visible`), not on mount — every tab of every project mounts at startup, and a theme
  read plus DOM and character measurement for each was most of the window's start. Nothing's lost by
  waiting, since a tab's process only starts on its first fit; once attached a view stays attached.
- **The views under `App` are memoized, and `App` hands them stable props.** `App` re-renders on
  every tab and repository push from any project; without `React.memo` on `TerminalsPane`,
  `ProjectList`, `CommandList`, `GitPane`, `BranchTree` and `DiffDialog`, each — branch
  tree with all its refs, a 5000-line diff — re-renders for a spinner starting elsewhere. Only holds
  while props stay stable: a callback is a `useCallback`, an object a `useMemo`, an empty list a
  shared constant (`NO_TABS`, `NO_IDS`), per-project mark lists keep identity while their ids match
  (`marks`). An inline arrow on one of these silently switches its memo off — as `usePaneSize`'s
  setter did before becoming a `useCallback`.
- A merely hidden terminal keeps its layout (`visibility`, not `display`) — xterm needs a laid-out
  element to measure itself. A whole pane may use `display: none` but needs refitting on return.
- **The element xterm mounts into is `.terminal-host`, never `.terminal`.** xterm gives its own
  element the class list `terminal xterm ...`, so a rule named for the plain word lands on both it
  and the container — the inset below was taken twice for months, a doubled gutter on three sides
  and none on the fourth. New elements in that subtree get their own name; xterm's own classes are
  `xterm`, `xterm-viewport`, `xterm-screen` and `terminal`.
- A terminal sits 6px inside its pane on every side (`.terminal-stack`'s padding plus
  `.terminal-host`'s matching inset — an absolutely positioned child ignores padding alone). That
  gutter is terminal background, living on `.terminal-host` with `.xterm-viewport` forced
  transparent over it: xterm.css hardcodes that viewport to black, which showed through as a black
  gutter and a black strip under the last row while a pane was dragged taller.
- A file dragged over a terminal frames the **pane** (`.terminal-host.drag-over`), so it's clear
  which mounted terminal would take the drop. A `::after` overlay, not a border — a border would
  shrink the box xterm measures, so every drag would refit and resize the pty. Only a drag carrying
  files raises it, the only kind the drop handler acts on. A file dropped anywhere *else* is
  swallowed in `main.tsx`: unhandled, Electron navigates the window to it and the app is gone. Files
  only — text dragged into a field still needs to reach that field. A dropped or pasted file types
  its path the way a hand-typed reference would arrive, through `term.paste` rather than individual
  keystrokes so a CLI's own input mode (vim-mode commands, say) cannot misread it. One dragged in
  from the filesystem has a real path; one dragged out of a browser, or a screenshot pasted with
  Ctrl+V, has only content, so it is written to a temp file first (`files:write-temp`,
  `clipboard:image-file` in `ipc.ts`) for a path to name — asynchronously, since a pasted
  screenshot is megabytes and a synchronous write would hold up every pty's output and keystrokes
  on the way to it. Nothing marks such a file as "already read", so `sweepTempFiles` deletes
  anything a day old at startup rather than after each paste — the file may still be read a moment
  later, and a session cut short must not take it with it.
- **Nothing in the lane at the terminal's right edge may be left to an xterm default, and CSS isn't
  what settles it** — both elements there are xterm's own and redrawn as the buffer grows, so the
  **color given in `theme.ts`** decides — `#00000000` for each, as hex so it passes xterm's color
  parser. The scrollbar: since xterm 6 it's a copy of VS Code's scrollable element with a
  `<div class="slider">`, not native, so `styles.css`'s older rules (`scrollbar-width`,
  `::-webkit-scrollbar`) never touch it — a TUI repaints its whole viewport, so a mismatched one
  would only twitch, and the wheel is what scrolls. And the overview ruler, asked for only to stop
  FitAddon reserving 14px for a scrollbar (`overviewRuler: { width: 1 }`) — xterm outlines it every
  frame regardless of marks, and an unset outline is a light line beside every terminal.
- Resizing reflows xterm and notifies the pty together, only once dragging settles
  (`RESIZE_DEBOUNCE_MS` in `Pane.tsx`) — an immediate local reflow ahead of the debounced pty
  notify was tried first and reverted: ConPTY can reflow its own internal screen buffer out from
  under a CLI's own cursor-relative redraw when a resize lands mid-redraw, corrupting the screen
  (an upstream Windows bug — VS Code hits the identical symptom, e.g. microsoft/vscode#230852,
  #260038, closed by xterm.js's own maintainer as unfixable from the application side). A dragged
  sash can show an empty strip of background until it stops, the trade taken instead. The sash
  itself reports one size per animation frame, not per pointer event — a mouse sends hundreds a
  second — and stores it a moment after the last one.
- `provideLinks` runs on **every render** while the pointer's over the terminal, and an agent TUI
  repaints constantly. Nothing expensive, no logging, in that path.
- A terminal's xterm theme is built **per terminal**, not once for the window, for one deliberate
  lie: opencode's TUI swaps blue and magenta from VS Code's terminal palette, so `buildXtermTheme`
  swaps them back for that agent alone. Observed, not derived — if opencode's colours ever look
  wrong the other way, take this back out. Only matters because of `"theme": "system"` in
  `tui-config.ts`.
- Codex doesn't adopt the terminal's palette on its own the way opencode's `"theme": "system"`
  does — its default is a fixed RGB syntax theme (`catppuccin-mocha`/`-latte`, picked by an OSC
  10/11 background query this terminal never answers, so it always lands on the dark one) applied
  to the status line and code highlighting alike, ignoring TET's ANSI palette entirely.
  `-c tui.theme=ansi`, added in `src/agents/codex/index.ts` alongside the hooks argument, switches
  Codex to its one bundled theme that emits plain named ANSI colors instead of RGB — verified end
  to end: the status line's model name and cwd path render in exactly TET's configured
  ansiYellow/ansiGreen with the override, a hardcoded tan/green without it. The config key is
  `tui.theme`, not `tui_theme` — the latter is the Rust struct field name, but `-c`'s dotted path
  follows the TOML layout instead (`[tui]\ntheme = "..."`, `codex-rs/config/src/types.rs`), and
  only the dotted form actually takes effect.
- Measurements are shared, not invented per view: a bar along an edge is 35px, the tab strip's
  height — title bar, both sidebar headers (`.section-header`) and the diff dialog's bar all use it.
  Same for the 22px action button and the 1px `--vscode-panel-border` between panes. Check the
  neighbouring view's size before inventing a new one.
- **An icon is one size everywhere, and it takes two numbers.** The box is `--icon-size`, 13px
  everywhere — the one knob resizing every icon. The other number is how much of its grid a *path*
  covers, from 59% (chevron) to 100% (Claude's mark): every icon declares the `extent` it was
  **measured** at, and `Svg` crops the viewBox so all cover `TARGET_EXTENT`, scaling `strokeWidth`
  the same factor. Extents are tuned to each icon's *geometric mean*, not its longer side —
  normalising the long side alone left a 12×9 shape looking small beside a 12×12 one, reported in
  turn for the branch icon, sync arrows, sparkle and Claude's mark. Verified at a mean of 11.9–12.0px
  wherever shape allows; a chevron and a row of dots are capped, not stretched. Neither number is
  optional: unequal extents in a shared box is what the app looked like for months.
- Adding or redrawing an icon means re-measuring, not estimating: render it, read `getBBox()` on
  each child grown by half its stroke, write down that extent and centre.
- **State an icon's size in CSS; never rely on the `width`/`height` the shared `<Svg>` writes as
  attributes** — a fallback a flex container is free to shrink. `.icon-button` is a `<button>`;
  `styles.css`'s reset clears border and background but not padding, and Chrome's default `1px 6px`
  with `border-box` left 12px of content inside a 24px box, so every icon in every such button
  rendered 12 by 18 for as long as the class existed. `.icon-button` now sets `padding: 0`; a
  squashed icon still looks like an icon, which is why it went unnoticed.
- **When two things that should look identical don't, measure them — don't read the code harder.**
  This cost several rounds of correct-but-wrong reasoning; what found it in one step: rebuild a page
  with the *built* stylesheet and real markup, serve over http (`file://` blocks the browser tools),
  read `getComputedStyle` per element. Use layout size, not `getBoundingClientRect`, on anything
  carrying `.spinning` — a rotated square reports a larger hull box than its own edge.
- The box *around* an icon counts as part of its size — the same glyph reads smaller inside a 24px
  `.icon-button` than bare in a row, which is why the project row's spinner is an `.icon-button`
  itself.
- **Anything that marks or points at something is 1px in `--vscode-focusBorder`**: the drop
  indicator between rows, the active tab's underline, the frame around a terminal a file's held
  over, the sash while dragged (`--vscode-sash-hoverBorder`, VS Code's name for the same blue). A new
  one copies an existing rule rather than picking its own width and color — two that differ read as
  two meanings. Same for a mark that's a *shape*: every session mark sits under one `.session-mark`
  rule, drawn to the square its neighbours occupy rather than the full 2–14 box.
- **Icons and marks are monochrome**; the only colour any takes is that blue. The changes list's
  status letters are the one exception, colored by `gitDecoration-*`, the theme's own answer for that
  list — the test for the next one: a colour is allowed where Dark Modern already names one for that
  meaning, nowhere else.
- Colors come from `--vscode-*` variables only (`src/renderer/vscode-theme.css`). Add a new variable
  rather than hardcoding, using VS Code's own name. Exception: the diff's syntax colors — Shiki
  assigns those per grammar scope, hundreds per theme, handed back per token, so
  `src/renderer/diff-highlight.ts` writes them inline; its `dark-plus` is the token half of the same
  theme the variables come from.
- Two hover colors, not interchangeable. A *row* (list item, tree item, tab, section header) takes
  `--vscode-list-hoverBackground`. An *action button* takes the translucent
  `--vscode-toolbar-hoverBackground` wherever it sits — the list color would be invisible on an
  already-hovered row, or a grey patch on a selected one's blue. A selected row keeps its selection
  color while hovered.
- The renderer is one bundle with no code splitting, so every Shiki grammar in that file's list ships
  regardless of use — a list of what a repository plausibly holds, not all two hundred; an unlisted
  language shows plain text. Imported lazily, so an unopened one costs bundle size but no startup
  time.
- `.pane-hidden` is last in `styles.css` on purpose: it has to override the `display` the panes it
  hides set on themselves, and they're all single-class selectors too.

## npm scripts

- `npm run compile` — bundle main, preload and renderer
- `npm run typecheck`
- `npm run lint`
- `npm start` — typecheck, compile, then launch (see "Do not restart the app yourself" first). The
  typecheck is there because esbuild only bundles: an unimported identifier is a global to it, so it
  drops the unused export and the app dies on load with a `ReferenceError` a `tsc` run would have
  named at the import.

## Releasing

When asked for a release, run it — no need to re-derive these steps first:

```
npm version patch   # or minor / major
git push && git push --tags
```

`npm version` bumps `package.json` and tags in one step, so the two can't drift apart. The tag
push triggers `.github/workflows/build.yml`, which builds all three platforms and publishes to a
GitHub Release with its own `GITHUB_TOKEN` — the repo is public so `electron-updater`
(`src/main/auto-update.ts`) can read releases without a token of its own.

Windows and Linux run from the AppImage auto-install on the next quit — never forced, since a
terminal tab is a live agent session (see "Do not restart the app yourself"). macOS and the
`.deb` build can't self-replace, so they only get a notice linking to the release page.
