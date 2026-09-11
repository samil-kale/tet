# CLAUDE.md

## What this is

TET is a git workspace for coding agents: Electron + React + xterm.js, several repositories
open at once, each with its own git pane and its own agent and shell terminals. Git is for
navigation and control of the repository state; the actual work happens in the terminals, so
anything git can't do in two clicks belongs in an agent or a shell, not in a new dialog.

This file holds rules of conduct, cross-file invariants, and what was measured about the CLIs —
what an agent needs *before* knowing which file to open. A reason that fits one file goes into
the comment at that site. Keep this file around its current size: adding means cutting.

## Do not restart the app yourself

Agents run *inside* TET, as terminal tabs. Killing the Electron process kills your own session.
Build and typecheck freely, but ask the user to restart. The same goes for anything that tears
down a project's terminals.

## Measured, not obvious

These are measured against the real binaries, and the rationale lives in the comments at their
sites: session listing/resume/rename/delete and the reconcile loop (`src/main/agents/*/sessions.ts`,
`src/main/terminals/session-manager.ts`); how each agent is driven (Claude Code reads
`<uuid>.jsonl` transcripts off disk; each opencode tab is the plain `opencode` plus a generated
plugin that writes the session records TET lists, `src/main/agents/opencode/plugin.ts` — TET never
runs an opencode server, never reads its SQLite file, and runs its CLI only for one-off actions);
`extractTitle`'s precedence rules for Claude Code titles; the modifier-gated link providers
(`src/renderer/terminal/links/`); the AppUserModelID a Windows toast needs and the
`background_tasks` stop guard (`src/main/main.ts`, `src/main/agents/claude/hooks.ts`); the
`--vscode-*` theming layer.

An agent gets no editor context and no quick fix. What it gets is the shell transcript
(`src/main/terminals/shell-context.ts`), a capped file it is pointed at; every shell tab of a
project writes into it in arrival order, per whole line, with a `=== shell tab: <title> ===`
header at each change of writer.

References: **GitHub Desktop** for the git half (shapes, not scope); **VS Code** for the UI (tab
semantics, close actions, theme names, the sash) — the classic layout and Dark Modern's palette,
not the pill-shaped Modern UI. **Monaco** is the diff dialog's file editor only; the diff itself
is `DiffView`'s own unified render. Not adopted: Octokit/GitBeaker for the providers.

## The layout

- projects live in the left sidebar; the tab strip is one project's terminals only
- git is **not** a tab. The strip's git toggle slides out a pane between navigation and terminals —
  branches over changed files, nothing else — and stays out until pressed again (`usePaneToggle`).
  One git pane for all projects.
- the diff is a **dialog** over the whole window (double-click a changed file, ctrl-click a path
  in a terminal, or "Browse files", which reopens the file last shown for that project). Its left
  side is the git pane's `ChangesList` with only "Discard all" in its header. `DiffDialog` and
  `SettingsDialog` are not part of `Dialog.tsx`, which is for questions (a form with two buttons).
  Every card dialog — the questions and everything under `dialogs/` — is drawn in `DialogFrame`
  (`src/renderer/ui/DialogFrame.tsx`), headed by a title bar or a tab strip; the diff dialog alone
  has a frame of its own.
- git commands go in an ordinary terminal tab, not a console of the pane's own
- panes are draggable (`src/renderer/ui/Sash.tsx`)

## Split view

One project's terminals can be split into up to four panes, each with its own tab strip — VS
Code's editor groups cut down to **four fixed presets** (single, two columns, two columns with the
right one split, 2×2), not a nestable tree. `src/renderer/terminal/pane-layout.ts` holds the model
and every rule about it; `TerminalsPane` lays the panes out; `Pane` is one strip-and-stack. Pane
"a" (always top-left) carries the one row of icon buttons — git toggle, browse-files, layout
picker, settings — regardless of preset.

- **The layout lives in `App`** (`layouts: Record<projectId, ProjectLayout>`): the tab shortcuts
  and `markedTabs`/`seen` need "the tab on screen" — one *per pane* with a split (`visibleTabIds`).
  A pane asks for a selection change through `onActivateTab`.
- **A tab belongs to exactly one pane**, assigned lazily to the focused pane on first sight
  (`normalizeLayout`, the one place a layout is reconciled with the tab list). One xterm per tab,
  so the same tab in two panes is not a thing.
- **Dividers are fractions** of `.panes-grid`'s live measurement (`useDividerFraction`), never
  pixels; "single" is the one preset that resets them.
- **Persistence**: preset, focused pane, divider shares, and tab→pane keyed by **session id**
  (`serializeLayout`). Not persisted: each pane's active tab, and any focus frame. The layout is
  loaded on *first sight* of a project (`layoutOf`), and nothing is written until its bootstrap
  has once reported not starting (`settledProjects`) — both commented in `App.tsx`.
- **A tab moved between panes gets a new host**, so `attachTerminal` moves the xterm element
  rather than calling `open()` again (which silently no-ops). Only the **focused** pane focuses
  its terminal; a focus change alone must never resize the pty.
- **A tab dragged onto a snap zone lays out the preset that has a pane there.** The zones
  (`SNAP_ZONES`: the right quarter in thirds, the lower left quarter) are the same for every
  preset; what each does per preset is `SNAP_TRANSITIONS`. Panes the preset adds beyond the target
  stay empty. A zone drop *places* a tab and leaves what it empties standing; a plain drop
  (outside every zone, or on a tab strip) *moves* it and tidies up. The preview is an overlay
  (`.snap-preview`); pane sizes change on the drop alone, since a resize refits every pty.
- **An *emptied* pane collapses away, and with it every empty pane at the end of the reading
  order** (`COLLAPSE_TRANSITIONS`, `collapseTrailing`). Every other pane keeps its place. Emptied
  means its last tab moved out (`activateTab`) or closed (`collapseClosed`), both in `App` — never
  a snap, and never a pane that was never filled. Once a project's bootstrap has listed every
  session (`settledProjects`), *every* empty pane counts as emptied (`collapseEmpty`).

## Nothing starts without git, and an agent or sbx

`src/main/requirements.ts` checks git, every agent with `versionArgs`, and sbx before anything
opens; passing (`startup:check`) is what calls `openWorkspace`. **sbx alone is enough** — a
sandboxed tab runs the agent's CLI inside the container, so a machine with none of them installed
still works (`AgentRuntime.sbxOnly`). Missing everything, `Startup` shows `RequirementsDialog`
instead of mounting `App` — a wall (no Escape), and **it installs nothing**, not even a link.
`--version` results are remembered (`isAgentInstalled`); `npm start -- --simulate=git,claude`
makes the dialog reachable on a machine that has everything. `--allow-shell-only` lets a runner
with no agent open, and `--user-data-dir=<dir>` gives that run a profile of its own (and, only
then, a control token from its environment) — `test/app.test.ts` is the one user of both.
`anyAgentInstalled` asks the same question mid-session, where a *project* decides whether it is
sbx-only: nothing is stored for that, it is derived at each of tet's own refresh points.

**`process.env.PATH` is not the one tet was launched with.** `augmentAgentPath`
(`src/main/terminals/agent-path.ts`) rewrites it before the check and on every re-check: on
macOS/Linux the login shell's PATH *replaces* it, on win32 the package managers' bin directories
are appended. Everything spawned inherits it, which is why `startGitProcess` waits for it.

## Git

Git is never reimplemented. `src/main/git/git.ts` wraps the local CLI: `git()` resolves for *any*
exit code — callers decide what it means — and rejects only if git itself couldn't start. Never
run git from the renderer.

All of `git.ts` runs in its own `utilityProcess` (`git-host.ts`), reached through `git-client.ts`
— a proxy whose properties are the module's own functions. Nothing in there may import electron,
and everything crossing the boundary must survive a structured clone (an image as a data URL, an
error as its message). A git process that *dies* rejects every in-flight call; `Repository`
catches that at each entry point, and the client restarts the process on the next call.

`Repository` (`src/main/git/repository.ts`) is the single source of truth for both the git pane
and the terminals. It watches the working directory, debounces and throttles bursts, and only
emits when state actually changed. Diffs load on file selection, never up front.

**Everything the git pane can do fits in a context menu, an icon button or a question.** A
command needing a checkbox list, a message field, or conflict resolution is one the pane doesn't
offer. Of what fits, we take GitHub Desktop's set — the branch tree (branches, remotes, tags,
stashes) with per-ref menus, checkout, status, per-file diff, discard, `.gitignore`,
fetch/pull/push (push doubles as "publish", `--set-upstream`), "commit all" (one message asked,
`add --all` then `commit` — no staging), and cloning from the add-repository dialog. The commit
prompt's suggest button asks the first installed agent with `askArgs` for the message
(`src/main/git/commit-message.ts`), handing it the diff and recent subjects up front. Cloning
goes through one `GitProvider` interface for GitHub and GitLab (`src/main/providers/`); providers
stay out of the local git layer.

Every action goes through `Repository.runAction`, one at a time per repository, refreshing after.
The renderer mirrors this in `App`'s `branchAction`; `BranchActions.run` is the one way in — a
view asks its own question first, then hands over a label and the call. Each repository also
auto-fetches every ten minutes, silently on failure, without taking the action slot.

The project row carries repository-wide entries (open in terminal, show in file manager, copy
path, view on host, change remote url, close) — nothing touches the working tree there.

### Talking to a remote

Every command reaching a remote runs with `NETWORK_ENV` (`git.ts`), which stops git from asking a
question there is no console to answer in. Credentials come from the user's credential helper or
a provider token, or not at all — **TET writes nothing into that machine-wide helper**.
`LC_ALL=C` is what lets `runNetwork` match git's auth messages into `authRequired`, the one thing
the add-repository dialog's `CloneAuth` acts on; the per-variable reasons are in the comments.

### The diff and the editor

A diff is read with `--ignore-all-space` only while the dialog's whitespace toggle is on, and
synthesised for an untracked file. Unfolding a gap asks `repo:file-lines` for exactly those lines
from the working tree. An image is not "Binary file.": `readDiff` hands both versions to the
renderer as data URLs, shown side by side or as an onion-skin overlay; SVG stays text.

The diff dialog doubles as a plain code editor (`CodeEditor.tsx`, one Monaco model for the
dialog's whole time on that file). `monaco-core.ts` reproduces `editor.main.js`'s import list
minus every language and language service — re-diff it on a monaco upgrade. Coloring goes through
the **same shiki instance and theme the diff view uses** (`ensureLanguage` in `editor.ts`). Saving
goes through `Repository.writeFile`, guarded by the mtime the file was read at. Keybindings are a
curated preset (`keybinding-presets.ts`, chosen in Settings → Files) over tet's own defaults
(`keybindings.ts`): no chords, no provider-dependent commands, no format command.

### Where we follow GitHub Desktop rather than git's default

- Discarding: a file HEAD doesn't know is moved to the trash, not deleted;
  `git restore --source=HEAD --staged --worktree` covers everything else.
- Deleting a branch is `git branch -D`; the question says out loud what that risks.
- A `stash@{n}` is a position, not an identity; rows act on the last refresh's report.

### What the git view deliberately does not do

Don't add without being asked: a commit UI with per-file/per-line staging; history, graph,
cherry-pick, revert, squash, reorder; bisect, submodules; conflict resolution beyond aborting;
side-by-side text diff; discarding single lines; pull with rebase and force push. A git command
needing a list, a message or a per-line decision is what an agent should be asked to do.

Provider accounts live in the add-repository dialog, the one place talking to a host rather than
a repository.

### Keep git off the main process, and count its invocations

Each of these was measured; the numbers are in the comment at each site.

- Git stays in its own process — in the main process it puts typing lag back, since that process
  also relays pty output.
- Starting git is what costs, so count *invocations*. `readState` gets by with two; `readStashes`
  is the third a refresh spends; anything added to the refresh path has to earn its process.
  `listIgnored` (the Explorer's `excludeGitIgnore`) is per listing and opt-in.
- A refresh finding events waiting goes back through `scheduleRefresh`, never re-runs at once.
- `readStatus` runs `git --no-optional-locks status`; don't fix the index-write feedback loop with
  another entry in `isIgnoredEvent`.
- `src/main/event-loop-monitor.ts` writes stalls to `event-loop.log` in `userData` every session;
  `logSlow` names a block whose own duration is worth knowing.

## Saved commands

The sidebar's lower half is a project's saved shell commands, under a `commands` key in a
`tet.json` in the repository's own root (`src/main/git/commands.ts`) — they describe the project,
so they travel and can be committed. A command is a plain string, or an object once it needs a
`name`, `cwd` or `env` (`{"command": "npm run build", "cwd": "web"}`). The array's order is the
screen order; rows reorder by dragging (`useDragReorder`, shared with the project list).

**There is no shell in between.** `splitCommand` (`src/shared/command.ts`) reads the line as a
program plus arguments, started directly — the same on every machine. Pipes, redirection, `&&`,
`$(...)` and `$VAR` don't work; an operator surviving the split as its own word is refused with a
notice. `env` outranks the inherited environment. `"shell": true` hands the line to
`AgentDefinition.runArgs` and only works where it was written. Where the line goes on Windows is
`resolveCommand`'s call (`src/main/terminals/pty.ts`).

**Running one opens a terminal tab whose process is the command**, ending when it does;
`createCommandTab` is `createTab` with a program. `TerminalSession` tells a clean end from a
failure by exit code (`stopped` vs `error`); an `error` tab draws `ExclamationIcon` in the mark
slot. A tab opened from outside the terminals pane is brought to front through `App.showTab`, a
one-off write into the layout — for a saved command into the pane its line last lay in
(`placeCommandTab`; `commandPane` in the persisted layout): the pane at the same position in the
current preset, or the recorded preset restored like a snap, placed rather than moved, so nothing
collapses. Saved-command tabs carry no session marks.

A `tet.json` that's missing, unparseable or oddly shaped is simply no commands. One `CommandList`
serves every project; rows are added with `+` and can be edited, deleted or reordered.

## Explorer

The diff dialog's Explorer tree (`Explorer.tsx`, fed by `Repository.listExplorer`) is configured
from the same `tet.json`, shaped like a VS Code `.code-workspace` and read by `readExplorerView`
in `commands.ts` as defensively as the commands:

- `folders` — `[{"path": "src/main/frontend", "name": "frontend"}, {"path": "."}]`; overlap
  allowed, each file listed once, a selection revealed in the *innermost* root containing it.
  Missing or empty means the whole repository as one tree.
- `settings["files.exclude"]` — glob → `true`, matched against the **repository-relative** path.
  `.git` is hidden regardless.
- `settings["explorer.excludeGitIgnore"]` — default off: one `git ls-files` per listing.
- `settings["explorer.compactFolders"]` — default on; roots are never compacted.
- `settings["explorer.sortOrder"]` — default `default`; `modified` costs a `stat` per entry.

"Add Folder to Workspace", "Remove Folder from Workspace" and "Exclude from Files" write
`tet.json` from the tree's context menu; `name` and the three `settings` entries are file-only.
The watcher reports every write of `tet.json` as `commands:changed`.

## Settings

One dialog for everything TET keeps about *itself*, opened from pane "a"'s strip. **Nothing is
written until Save**, as everywhere else — Cancel and Escape drop what was edited. Tabbed
(Appearance, Notifications, Shortcuts, Files, Prompts, Info) with a tab strip in place of a title.
Values live in `settings.json` in `userData` (`src/main/settings.ts`), written whole and read back
defensively. The Files tab alone writes elsewhere — one `setExplorerSetting` into the active
project's `tet.json` per key Save finds changed. It reads that file once, on open: `patchSetting`
reads it fresh at write time and leaves every other key standing.

**A setting reaches an agent through `AgentPaths`**, handed over at `prepareSpawn`. An agent gets
its setup once per project, so a change applies to projects opened after it — and the dialog says
so. The color theme travels the same way, and every agent is told to draw in it (Claude Code's
`theme`, opencode's `"theme": "system"`, pi's `--use-theme`, Codex's console colors). The
background commit-message question is the exception: its text lives in `src/shared/prompts.ts`,
an empty setting means tet's own, and `ipc.ts` reads it at the moment of asking.

Deliberately not in there: the session marks, and a notification to turn off.

## Everything the user is told is a notice

`notify(severity, message)` from `src/renderer/ui/Notices.tsx` is the only way to say something
to the user — no view keeps a message of its own. A plain function, modelled on VS Code's
`window.showErrorMessage`; the main process uses the same channel (`app:notice`). All three
severities disappear after 8 seconds or on click; an identical message already standing is
dropped.

Not a notice: a status — a tab colored for an uninstalled agent, the progress bar, the head, the
git mark and the sandbox shield next to a project's name.

Nor a *question*. `Dialog.tsx`: a plain function anything can call, one `Dialogs` drawing
whatever's pending, one question at a time. `confirm` resolves to whether the user went through
(plus its one optional checkbox); `prompt` resolves to a name or null, and can carry a per-project
history dropdown (`commit-history.ts`). **The main process asks nothing** — the question lives in
the view offering the action. Electron's native `dialog.showMessageBox` isn't used. Only ask
before something irreversible.

## One progress indicator per pane

Every pane that can be slow carries its own `.progress-bar` showing only what is happening in
*it*. One component serves all (`ProgressBar.tsx`), dropped into whichever header declares
`position: relative`. **Never add a second bar inside one pane** — a new slow reason there feeds
the one it already has. Today: each terminal pane (`Pane`'s `showProgress`, from
`TerminalDescriptor.starting`; the bootstrap listing falls to pane "a"), the git pane's two
sections (`branch.busy` under BRANCHES, `acting` under LOCAL CHANGES), the diff dialog
(`DiffView`'s `onBusy`) and its changes list.

**A spinner in place of an icon is not a second one of these.** A spinner is about the one thing
the icon stands for, and takes its place — a tab's agent icon while its session works a turn. An
action button disabled for being underway only dims. The project row is the one place a spinner
stands alone.

## Both ends of a turn

A session says whether it's *working* (spinner), *stopped for an answer* (question mark), or
*finished out of sight* (speech bubble), drawn on the tab and on its project's row. A question is
a standing fact, only *hidden* while its tab is in front of the user; a finished turn is a one-off
notice cleared by looking. A stopped session never spins anywhere (`ProjectMarks.busy`, and
`Pane`'s own check). One glyph per condition.

**On a tab all marks take the agent icon's place**, ranked **error/missing > waiting > working >
finished** (reasoned in `Pane.tsx`). In the project row the three turn marks are buttons stepping
through their sessions. All three are `--vscode-focusBorder` under one `.session-mark` rule; the
error mark alone is `--vscode-errorForeground`.

**Nothing here is read off the terminal, and nothing goes through a file.** Each agent reports
its own turn over the control channel — `tet-ctl hook <event>`, one verb for all four, five
events in tet's own vocabulary (`HOOK_EVENTS`: `prompt-submit`, `stop`, `permission`, `question`,
`idle`). Claude Code and Codex register it as their hook command, plain and constant, and speak
their payload on its stdin; opencode's plugin and pi's extension post the same request from
inside their own process, no `tet-ctl` involved. The **tab** is the address, off `TET_TAB_ID` in
the hook's own environment (sbx passes it into the sandbox), so a turn is never reported for a
session no tab has claimed yet.

`SessionManager.hookEvent` is where an event becomes a mark, a toast and the answer the agent
sees on stdout: the context file's text for `prompt-submit` — which is why Claude and Codex need
only one `UserPromptSubmit` hook — and `{}` for the rest, since Codex reads its Stop hook's
stdout as JSON. The toast is composed there too, off the settings **as they stand at that
moment**: a notification switch applies to the next turn of every open project. The exception is
the idle reminder, the one event with no mark behind it — its hook is registered only when the
switch is on (`AgentPaths.idleReminder`), rather than starting a process per idle prompt to have
the answer thrown away, so that switch alone waits for a new tab. `stop` asks
`AgentDefinition.holdsTurnEnd` first, which is where Claude Code's `background_tasks` guard
lives, so a turn that only launched a subagent isn't "finished".

**A report is ordered by when it was *made*, never by when it arrived** (`ControlRequest.at`):
two hooks of one turn are two requests racing each other, out of a sandbox ~100 ms each while the
events behind them are milliseconds apart — order them by arrival and a `busy` overtakes its own
turn's `stop`, leaving a tab finished *and* working. All of a tab's reports come from that tab's
own agent, so one clock decides throughout — and a report *much* older than the last one is that
clock having moved rather than a race, so it is taken (`turn-order.ts`), or a container corrected
after the host slept would freeze a tab's marks until real time caught up.

Measured, and the reason the command is a bare `tet-ctl`: Claude Code runs its win32 hooks under
`/usr/bin/bash`, where `cmd.exe /c` is mangled by MSYS and a `.cmd` on PATH does not resolve —
hence the second, extensionless launcher (`control-launcher.ts`). A hook must never fail its own
turn, so the CLI answers a hook that cannot be delivered with silence and exit 0.

**No agent reports that a question was answered**: a question clears on input that can be an
answer (`answersQuestion` in `session-manager.ts`) or either end of its turn — except where the
asking outlives the turn, which is a measured per-agent fact (`questionOutlivesTurn`: Claude
Code's `AskUserQuestion` blocks its turn, Codex's `request_user_input_async` answers at once and
leaves the question queued in its composer). Such an end leaves **no bubble beside the
question** and no second toast: one moment, one notice — the tab would hide the bubble behind
the higher-ranked mark anyway, but the project row has a button per condition and would step
through that one tab twice. **No hook fires for a turn the user cut short**;
the net is each agent's own transcript (`turnEndedAt` in `src/main/agents/*/sessions.ts`).

State lives as `TerminalDescriptor.busy` / `waitingAt` / `finishedAt` per tab in the main
process. The **main process** sets it, never asking whether it should; the **renderer** decides
what's *shown* and clears what was seen, the rule living once in `App.markedTabs`. `App` holds
every project's tabs because the project list needs all of them at once.

## Ending a session

A session is **asked to quit before it is killed** (`TerminalSession.stop`): the Ctrl+C bytes its
own convention expects (`AgentDefinition.quitPresses`), then a kill for what's still running.
`stop` resolves once the process is actually gone — `destroyTab` deletes what the CLI persisted
right after. A hard kill never lets a CLI run its exit handlers, and Claude Code keeps something
there that matters (`~/.claude.json`, see `terminal-session.ts`). `before-quit` holds the quit
back and asks again once the sessions are gone; `closeTabs` starts every doomed tab's stop before
waiting on any.

## Agent-specific vs shared code

`src/` is the process list — `main/`, `renderer/`, `preload/`, `cli/` — plus `shared/`, the only
folder any of them may import from another. `src/main/` is split by process boundary and by half:
`git/` (the git process and everything that talks to it, `commands.ts` included), `terminals/`
(pty, sessions, hooks), `control/` (the `tet-ctl` channel), `agents/`,
`providers/`; what stays flat is the app itself — window, ipc, settings. The process borders are
lint rules (`no-restricted-imports` in `eslint.config.mjs`).

Each agent gets a folder under `src/main/agents/`, described by one `AgentDefinition`
(`src/main/agents/agent.ts`). The shared terminal layer imports only the registry (`AGENTS`,
`getAgent` from `src/main/agents/index.ts`) and the `AgentDefinition` type, never an agent's own
folder. A new agent is a new folder, one entry in that index, one case in `AgentIcon`
(`src/renderer/ui/agent-icons.tsx`, the only agent-specific thing outside `src/main/agents/`).

- `executable`, `args`, `env`, `versionArgs` — how to start it, and how to tell "not installed"
  from a spawn that failed for another reason
- `askArgs` — one question answered on stdout, no terminal; a background question must not leave
  a session behind (`cleanupAsk` for an agent that persists one either way)
- `runArgs` — one command run *in* a terminal; only the shell has it
- `sessions` — listing, resume args, rename, delete, optional `watch`
- `holdsTurnEnd` — reads this agent's own end-of-turn payload for a reason the turn is not over
- `questionOutlivesTurn` — its questions are asked asynchronously and still stand once the turn ends
- `prepareSpawn` — async setup before the first spawn, **the only place an agent may write
  anything**; a rejection marks the agent unstartable, so only reject for what truly makes it
  unusable
- `resolveUrlPrefix` — completes a url the agent's TUI wrapped across rows
- `createIsSessionReady` — the per-agent guess at "the CLI drew its first real frame"
- `quitPresses` — how many Ctrl+C bytes make it quit by itself
- `takesRightMouse`, `swapsBlueMagenta` — measured facts the *renderer* acts on; they travel as
  flags on `AgentInfo`

### Never assume the agents behave alike

Four separate products in the same kind of tab. Every time the same question was put to all of
them, the answers differed, and the differences were only ever found by **measuring the real
binary through this same pty** — never by reading source or docs, never by reasoning from one
agent to another:

- `createIsSessionReady`'s byte thresholds: one per agent, tuned by hand — pi's stays under its
  project-trust dialog, which holds the output at ~1.4 KB until answered.
- `quitPresses`: Claude Code and pi want two Ctrl+C (pi within 500 ms) and soon withdraw the
  offer; Codex and opencode quit on one, and a second byte sent to a Codex already leaving *kills*
  the shutdown.
- The right mouse button: Claude Code and opencode take it through mouse reporting, Codex leaves
  it to the terminal (`takesRightMouse`), pi turns on no mouse reporting at all.
- Colours: opencode's `"theme": "system"` adopts the terminal palette but swaps blue and magenta
  (`swapsBlueMagenta`; `buildXtermTheme` swaps them back); Codex picks its own light/dark theme
  from the terminal's colors, which on win32 it reads from the console (hence `launch.cmd` and the
  OSC 4 handling in `src/main/agents/codex/index.ts`); Claude Code paints dark unless told
  otherwise, so tet passes `theme` in its `--settings` file (a built-in theme, never a custom one —
  it draws a dark frame while a custom theme loads); pi paints truecolor only and takes
  `--use-theme dark|light` for one run.
- Turn signals: Claude Code and Codex need hook processes, and only Codex insists on a hash it
  has decided to trust; opencode loads a TypeScript plugin whose `event` hook is its whole event
  bus (and bun-installs its dependency into the config dir the first time), and pi loads a
  TypeScript extension and exits outright when it fails to load. All four end up on the same
  control-channel verb; what differs is how they are made to call it.
- Ctrl+C: all four read `\x03` as an ordinary byte and decide for themselves what it means — Codex
  clears its composer, or quits when it is empty (0.153.4; it once sat in cooked mode, where win32
  turned the byte into a `CTRL_C_EVENT` that killed it, and tet swallowed Ctrl+C for it).
- Resize redraw: Codex reprints its whole scrollback on any real pty resize, because it never
  enters its own alternate screen — its `alternate_screen = "always"` config has no effect in the
  shipped binary (raw pty bytes captured; openai/codex#24552). A Codex bug, not tet's; per-agent
  resize suppression only trades one visible symptom for another. Wait for an upstream fix.

So anything that touches how a CLI is driven is a field on `AgentDefinition` with a value per
agent, not one shared constant — and what goes in that field is what was measured.

### One SQLite database under every opencode and Codex process

Every `opencode` on a machine opens the same `opencode.db`, and a listing through the CLI boots a
process (~1.5 s) that writes to it (measured, 1.18.4). So the listing is the plugin's records, and
the CLI is only ever run for a one-off (delete, export, the background question's cleanup),
never from a timer or a tab's output. Codex's `$CODEX_HOME` state db has a write-lock race between
instances, so there is no persistent `codex app-server`: rename and delete go through a
short-lived JSON-RPC call (`src/main/agents/codex/app-server-client.ts`), never two at once.

### Codex's hook trust

Codex only *runs* a hook whose hash it trusts; handed an unknown one, an interactive session opens
on a blocking "Hooks need review" screen. `src/main/agents/codex/hooks.ts` reproduces that hash — a
private, unversioned serialization; if a future release changes it the screen reappears once
(re-check `hooks/src/engine/discovery.rs::hook_hash`). The trust entry must live inside the
*value* of one combined `-c hooks={…}` argument, built from TOML literal strings.

## The control channel: `tet-ctl`

An agent can ask the app around it for things the filesystem and git can't give it — the theme,
the project list, the terminal tabs. `src/main/control/control-server.ts` listens on a loopback
TCP port derived from `userData` and probed for being free (`findControlPort`), one HTTP POST per
connection — HTTP because sbx's proxy to the host is HTTP-only — and answers with the same
singletons `ipc.ts` holds. It comes up with the workspace, so `tet-ctl` waits a few seconds for a
port. A second transport onto the same logic, never a second implementation (`addProject`/
`removeProject` in `projects.ts` are shared for exactly that). The wire contract and the verb
list are `src/shared/control.ts`; the CLI is `src/cli/tet-ctl.ts`, bundled on its own and run by
a launcher in `userData/bin` under tet's own electron as node. What reaches a terminal is decided
in `spawnAgentProcess` (`pty.ts`), in layers **above** `process.env`: the port, a per-run token,
the launcher directory on PATH, and the tab's own project and tab id — above, because a tet
started from one of its own shell tabs inherits the outer one's values. Only ptys get them; git
does not. The agent learns the command from the context file (`shell-context.ts`), which is never
empty for that reason.

`hook` is the one verb that is not for an agent to call: tet registers it as each agent's own
hook command, and it is the whole of how a turn reaches the app ("Both ends of a turn"). It is
also the one verb whose stdout belongs to the caller — the CLI prints the answer verbatim and
exits 0 whatever happened, since a hook that fails takes its own turn down with it.

`restart-app` is the one verb that ends sessions and takes `--confirm`, which an agent passes
only when the user asked. A theme change answers `restartRequired`; that is a fact for the agent
to relay, never a reason to restart on its own. A verb that ends its caller replies before it
acts.

**Direction of travel**: every setting in `settings-get` is to be settable through `tet-ctl`
(`settings-set-theme`, `settings-set-prompt` so far), toward letting an agent drive the whole
app. A new or extended setting comes with an offer to add its verb: the same `ControlVerb` entry,
handler and `control.test.ts` case the existing ones have — offered, since the user decides what
an agent may change.

## sbx: an agent tab inside a Docker sandbox

Opt-in per project through the project row's "SBX Settings", for every agent but the shell
(`SbxAgentId`): the three sbx ships a kit for, plus pi through a community kit
(`SBX_CREATE_TARGET`). `src/main/sbx.ts` drives the `sbx` CLI the way `git.ts` drives git — every
call a plain spawn, never a shell — and every fact in it about sbx was measured against the real
binary; its comments are the record. The config is the `sbx` key of the repository's own
`tet.json` (`readSbxConfig` in `commands.ts`: ports, allowed paths — a folder or a single file —
and which of the agent's skills/plugins/instructions to mount); the tab-time decision is
`resolveSbxRun` in `session-manager.ts`, which skips the sandbox for the one spawn when sbx is
not ready — never writing the project's switch off — and sends each session back where it was
made. Skipping needs somewhere to skip *to*: an agent that is not installed here at all is
startable only through the sandbox (`AgentRuntime.sbxOnly`, decided with the project's config at
bootstrap and again whenever `tet.json` is written, `sbxConfigChanged`), and its tab is left in
`error` rather than spawning an executable that does not exist.

- **A setup is generated for where it runs**, not for `process.platform`: `HookTarget`
  (`src/main/terminals/hook-target.ts`) says whether the target is POSIX and how a host path reads
  inside the sandbox (`C:\Users\x` → `/c/Users/x`). Each agent's `prepareSandboxSpawn` writes its
  sandbox setup under `<agentDir>/sandbox/`, beside the host one. The hook commands themselves are
  the same either way — a sandboxed `tet-ctl` reaches the host through `TET_CONTROL_HOST`.
- **The sandbox never sees the agent's own config directory** — its sign-in is its own. The
  project is the one `sbx create` workspace (only a create-time workspace decides the agent's
  working directory). Everything else — `agentDir` and the context file's directory included
  (`fixedMountSpecs`) — is a live `sbx mount` re-applied on every spawn, since a bind mount does
  not survive a stop.
- **A sandboxed session is read through a mount, not out of the container**
  (`SessionProvider.sandbox`): a host directory mounted where the CLI writes its transcripts, so
  the *same* listing code reads it. Curated subpaths only, never the one holding the credentials.
  opencode differs in mechanism only: its plugin already writes records through the `agentDir`
  mount.
- **`tet-ctl` inside a sandbox** is the same bundle written into the sandbox's `~/.local/bin`,
  reaching the control server at `host.docker.internal` (`TET_CONTROL_HOST`) through an
  `sbx policy allow` for `localhost:<port>`. An account whose policies an organization manages
  gets a wall in the sbx dialog instead of the fields (`readSbxStatus`, unverified against a
  real managed account).

## Never touch the user's agent configuration

Everything TET generates lives under its own `userData` and is pointed at from outside:

- Claude Code: a generated settings file passed as `--settings`. `~/.claude/settings.json` is
  never read, written or replaced.
- opencode: `OPENCODE_CONFIG_DIR` on the tab's process, additive and shared across repositories
  on the host (an unfamiliar config dir costs an install) — so each repository's generated plugin
  needs a unique filename *and* a runtime guard on `TET_PROJECT_ROOT`, and is only written when
  its content changes; a sandbox gets a config dir of its own under agentDir. Never an
  `opencode.json` in there: it would override the user's. `OPENCODE_TUI_CONFIG` carries nothing
  but `"theme": "system"` (`tui-config.ts`).
- Codex: `-c key=value` overrides for that one process only. `~/.codex/config.toml` and
  `~/.codex/hooks.json` are never read, written or replaced.
- pi: a generated extension under `userData` passed as `-e`, `--use-theme` for that one process;
  `PI_CODING_AGENT_DIR` is never set — it would move the user's sessions and auth.

## Files other processes read

The context file, the shell transcript, opencode's session records and its rename requests are
written by TET or by a generated plugin and read by a separate process. Write beside the target
and `rename` into place, never in place — on Windows a read landing mid-write fails outright.
Nothing about a *turn* is a file: that goes over the control channel.

## Cross-platform requirement

Must work on Windows, Linux and macOS. Never add OS-specific behaviour without an equivalent for
the others.

- Build paths with `path.join`; route process spawning through `resolveCommand`
  (`src/main/terminals/pty.ts`).
- A generated file PowerShell will read needs a UTF-8 BOM; generated `sh` scripts must be LF.
- Anything written *into* a generated script needs literal quoting (`shellSingleQuote` in
  `script-text.ts`): a repo folder or user name may hold a `$`.
- A hook command is run by whichever shell the agent picked, and that is not ours to pick
  (measured on win32: Claude Code uses `/usr/bin/bash`; PowerShell and cmd.exe have been seen
  too). Keep it a bare name plus arguments — `tet-ctl hook <event>` and nothing else. Which is
  why the win32 launcher is written twice, `.cmd` and extensionless.

## The keyboard belongs to the terminal

A terminal tab holds a foreign program owning every key while focused, and TET's handler runs
*before* xterm encodes anything (`attachCustomKeyEventHandler` in `terminal-views.ts`). **It takes
nothing an agent could have received**, decided by reading xterm's own `Keyboard.ts` — the
findings are in `src/renderer/shortcuts.ts`, the one list both `App.tsx`'s listener and the
settings dialog read from. Check a new shortcut against that reading. None of the window
shortcuts close a tab. Shift+Enter, Ctrl+V and Ctrl+C are handled *for* the terminal, not taken
from it; Ctrl+C with a selection always copies, and its per-agent rules are above.

## The renderer

`src/renderer/` is split by surface: `terminal/` (xterm, the split, the link providers), `git/`
(the pane and `ChangesList`), `diff/` (the dialog, the editor, shiki and monaco), `sidebar/`,
`dialogs/` (the ones that are not questions), `ui/` (what every surface uses). What stays flat is
the shell: `App`, `Startup`, the stylesheets, the shortcut list.

- Terminal output goes straight to xterm, never through React state. Instances live in
  `src/renderer/terminal/terminal-views.ts`, outside React, keyed by project *and* tab (tab ids
  are only unique within their project). Output arrives batched, one flush for every terminal.
- An xterm is built the first time its tab is in front of the user, not on mount — building each
  at startup was most of the window's start.
- **The views under `App` are memoized, and `App` hands them stable props.** `React.memo` on
  `TerminalsPane`, `ProjectList`, `CommandList`, `GitPane`, `BranchTree` and `DiffDialog` only
  holds while props stay stable: a callback is a `useCallback`, an object a `useMemo`, an empty
  list a shared constant (`NO_TABS`, `NO_IDS`).
- A merely hidden terminal keeps its layout (`visibility`, not `display`) — xterm needs a laid-out
  element to measure itself. A pane using `display: none` needs refitting on return.
- **The element xterm mounts into is `.terminal-host`, never `.terminal`** — xterm gives its own
  element the class `terminal`. xterm's own classes are `xterm`, `xterm-viewport`, `xterm-screen`
  and `terminal`.
- A file dragged over a terminal frames the pane with a `::after` overlay, never a border — a
  border would shrink the box xterm measures and refit the pty. A file dropped anywhere *else* is
  swallowed in `main.tsx`, or Electron navigates the window to it. Dropped and pasted files type
  their path through `term.paste`; content without a path goes to a temp file first, swept a day
  old at startup.
- **Nothing at the terminal's right edge may be left to an xterm default** — the scrollbar and
  overview ruler are xterm's own, so `theme.ts`'s colors decide, not CSS.
- Resizing reflows xterm and notifies the pty together, only once dragging settles
  (`RESIZE_DEBOUNCE_MS`) — never an immediate local reflow, since ConPTY corrupts a CLI's redraw
  when a resize lands mid-way.
- `provideLinks` runs on **every render** while the pointer's over the terminal. Nothing
  expensive, no logging, in that path.
- A terminal's xterm theme is built **per terminal**, not once for the window (`buildXtermTheme`).
- Measurements are shared, not invented per view: a bar along an edge is 35px (tab strip, title
  bar, `.section-header`, the diff dialog's bar); the action button is 22px; the border between
  panes is 1px `--vscode-panel-border`. Check the neighbouring view before inventing a size.
- **An icon is one size everywhere, and it takes two numbers.** The box is `--icon-size` (13px);
  the other is how much of its grid the path covers — every icon declares the `extent` it was
  **measured** at (`getBBox` on each child grown by half its stroke), and `Svg` crops the viewBox
  so all cover `TARGET_EXTENT`. Extents are tuned to the *geometric mean*, not the longer side.
  State an icon's size in CSS, never rely on the `width`/`height` attributes.
- **A new icon comes from Lucide first** (lucide.dev, ISC), vendored on its native 24-unit grid
  (`fitIcon`/`fitStroke` take the grid); the hand drawings in `icons.tsx` are what Lucide had no
  match for.
- **When two things that should look identical don't, measure them** — rebuild a page with the
  *built* stylesheet, serve over http, read `getComputedStyle`. Use layout size, not
  `getBoundingClientRect`, on anything `.spinning`.
- **Anything that marks or points at something is 1px in `--vscode-focusBorder`**: the drop
  indicator, the active tab's underline, the drag-over frame, the dragged sash. A new one copies
  an existing rule. Every session mark sits under one `.session-mark` rule.
- **Icons and marks are monochrome**; the only colour any takes is that blue. Two exceptions —
  the changes list's status letters (`gitDecoration-*`) and the error mark
  (`--vscode-errorForeground`) — both colours Dark Modern already names for that meaning.
- Colors come from `--vscode-*` variables only (`src/renderer/themes/`); add a new variable under
  VS Code's own name rather than hardcoding. Exception: the diff's syntax colors, which Shiki
  hands back per token (`diff-highlight.ts`). Shiki's editor-surface colors are patched with
  those variables at load (`buildShikiColors`) and monaco takes its theme from shiki's.
- **A theme is one stylesheet in `src/renderer/themes/<id>.css`** — a `:root[data-theme="<id>"]`
  block naming the **complete** variable list (`pieces.test.ts` holds the lists equal; Dark
  Modern doubles as the bare `:root`) — plus an entry in `src/shared/themes.ts` for what lives
  outside the stylesheet. Values come from VS Code's theme files, not from eyeballing. The fonts
  are `styles.css`'s. The id travels `settings.json` → `currentTheme` → `additionalArguments` →
  preload → `data-theme` in `main.tsx`, synchronously, so the first frame is right. **A change
  applies after a restart**: xterm, shiki, monaco and the window chrome bake it in at
  construction.
- Two hover colors, not interchangeable: a *row* takes `--vscode-list-hoverBackground`, an
  *action button* the translucent `--vscode-toolbar-hoverBackground`. A selected row keeps its
  selection color while hovered.

## npm scripts

- `npm run compile` — bundle main, preload and renderer
- `npm run typecheck`
- `npm run lint`
- `npm test` — compile, then node's own runner over `dist-test/`, one file per seam: the control
  server with its electron-side dependencies faked, driven through the built `tet-ctl`
  (`control.test.ts`); the real app on a throwaway profile, driven through `tet-ctl` alone
  (`app.test.ts` — needs a display, `xvfb-run` on Linux); `git.ts` against the real git
  (`git.test.ts`); the session providers against transcripts written the way the CLIs write them
  (`sessions.test.ts`); `tet.json` reading and writing (`commands.test.ts`); the command-line
  reading (`command.test.ts`); the split view's rules (`pane-layout.test.ts`); the background
  question and the commit message (`ask.test.ts`); the measured pieces — Codex's hook hash,
  `resolveCommand`, the quoting helper, the stores, the generated plugin and extension
  (`pieces.test.ts`), env layering, launcher and context file (`unit.test.ts`). Nothing looks into the window. The Linux
  side is testable from Windows in WSL: clone onto the Linux filesystem, `npm install` there,
  Electron's libraries via `wsl -u root apt-get`, launch with `env -i … PATH=/usr/bin:/bin`,
  drive it through `tet-ctl`.
- `npm start` — typecheck, compile, then launch (see "Do not restart the app yourself" first).
  The typecheck is there because esbuild only bundles: an unimported identifier is a global to
  it, and the app dies on load with a `ReferenceError`.

## Releasing

When asked for a release, run it:

1. Write the release's section at the top of `CHANGELOG.md` — `## <version> (<date>)`, then one
   bullet per change a user would notice, read off `git log <last tag>..HEAD`. Say what changed
   for the user, not what the commits say; leave out refactors, docs and fixes to unreleased
   work. Commit it on its own (`changelog for <version>`).
2. `npm version patch` (or `minor` / `major`), then `git push && git push --tags`.

`npm version` bumps `package.json` and tags in one step, and refuses on a dirty tree — hence the
changelog commit first. The tag push triggers `.github/workflows/build.yml`, which takes the
version's section of `CHANGELOG.md` as the release notes, builds all three platforms and
publishes to a GitHub Release; the repo is public so `electron-updater` (`src/main/auto-update.ts`)
can read releases without a token. Windows and Linux (AppImage) auto-install on the next quit —
never forced, since a terminal tab is a live agent session. macOS and the `.deb` build only get a
notice linking to the release.
