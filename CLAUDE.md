# CLAUDE.md

## What this is

TET is a git workspace for coding agents: Electron + React + xterm.js, several repositories
open at once, each with its own git pane and its own set of agent and shell terminals.

Git is there for navigation and control of the repository state. **The actual work happens in the
terminals**, so anything git can't do in two clicks belongs in an agent or a shell, not in a new
dialog.

**Before adding anything here, apply one test: does an agent need this *before* knowing which
file to open?** Rules of conduct, cross-file invariants, what was built and deliberately taken
out, and what was measured about the CLIs pass. A reason that fits one file does not — it goes
into the comment at that site, and at most a one-line pointer goes here. This file is meant to
stay around its current size; adding means cutting or moving something else.

## Do not restart the app yourself

Agents run *inside* TET, as terminal tabs. Killing the Electron process kills the session you
are running in, mid-turn. Build and typecheck freely, but ask the user to restart and report back.
The same goes for anything that tears down a project's terminals.

## Where it came from

**`sbc-vsc-agents`** (private, no longer checked out here) is the direct ancestor: two VS Code
extensions docking `claude` and `opencode` into the sidebar as real terminals. Most of TET's
terminal half ports its `shared/`; the rationale now lives only in the code comments at these
sites, so treat them as measured, not obvious: session listing/resume/rename/delete and the
reconcile loop (`src/agents/*/sessions.ts`, `src/main/session-manager.ts`); how each agent is
driven (Claude Code reads `<uuid>.jsonl` transcripts off disk; opencode is client/server and
**everything** goes through the one server TET runs, `src/agents/opencode/server.ts` — never its
CLI or its SQLite file); `extractTitle`'s precedence rules for Claude Code titles (a regression
there silently shows the wrong tab title); the modifier-gated link providers
(`src/renderer/links/`); OS notifications and the `background_tasks` stop guard
(`src/main/os-notify.ts`, `src/agents/claude/hooks.ts`); the `--vscode-*` theming layer.

Not ported: the VS Code editor context (feeding an agent what's open or under the cursor) and the
diagnostic quick fix — TET's own editor is a plain look-and-fix surface. What survives is the shell
transcript (`src/main/shell-context.ts`), a capped file the agent is pointed at. **Open**: every
shell tab of a project writes into that one file, interleaved and unmarked — a build in one tab and
a `git log` in another read as one stream. To be addressed.

**GitHub Desktop** is the reference for the git half — crib the shapes, not the scope. **VS Code**
is the UI reference (tab semantics, close actions, theme names, the sash) — the **classic** layout
and Dark Modern's palette, not the pill-shaped Modern UI. **Monaco** is the diff dialog's file
editor only; the diff itself is `DiffView`'s own unified render. Not adopted:
**Octokit**/**GitBeaker** for the providers.

## The layout

- projects live in the left sidebar; the tab strip is one project's terminals only
- git is **not** a tab. The strip's git toggle slides out a pane between navigation and terminals —
  branches over changed files, nothing else — and stays out until pressed again (`usePaneToggle`),
  so a terminal and the repository stay on screen together. One git pane for all projects.
- the diff is a **dialog** over the whole window (double-click a changed file, ctrl-click a path
  in a terminal, or "Browse files", which reopens the file last shown for that project). It carries
  the same `ChangesList` as the git pane's LOCAL CHANGES down its left side, with only "Discard
  all" in its header. `DiffDialog` and `SettingsDialog` are deliberately not part of `Dialog.tsx`:
  that file is for questions, built around a form with two buttons.
- git commands go in an ordinary terminal tab, not a console of the pane's own
- panes are draggable (`src/renderer/components/Sash.tsx`)

## Split view

One project's terminals can be split into up to four panes, each with its own tab strip — VS
Code's editor groups cut down to **five fixed presets** (single, two columns, three columns, two
columns with the right one split, 2×2), not a nestable tree: a fixed set is one `switch` in
`TerminalsPane` instead of a generic sash composition and a "which pane did you mean" for every
action. `src/renderer/pane-layout.ts` holds the model and every rule about it; `TerminalsPane` lays
the panes out; `Pane` is one strip-and-stack. Pane "a" (always top-left) carries the one row of
icon buttons — git toggle, browse-files, layout picker, settings — regardless of preset.

The cross-file facts, each reasoned at its site:

- **The layout lives in `App`** (`layouts: Record<projectId, ProjectLayout>`), not in
  `TerminalsPane`: the tab shortcuts, and `markedTabs`/`waitingTabs`/`seen`, need "the tab on
  screen" — one *per pane* with a split (`visibleTabIds`) — and two views applying that rule would
  be two chances to disagree. A pane asks for a selection change through `onActivateTab`.
- **A tab belongs to exactly one pane**, assigned lazily to the focused pane on first sight
  (`normalizeLayout`, the one place a layout is reconciled with the tab list). One xterm per tab
  (`terminal-views`), so the same tab in two panes is deliberately not a thing.
- **Dividers are fractions** of `.panes-grid`'s live measurement (`useDividerFraction`), never
  pixels; "single" is the one preset that resets them.
- **Persistence**: preset, focused pane, divider shares, and tab→pane keyed by **session id**
  (`serializeLayout`). Not persisted on purpose: each pane's active tab, and any focus frame (tried
  and taken out — the only frame is the drag-over one). Two timing rules learned the hard way, both
  commented in `App.tsx`: the layout is loaded on *first sight* of a project (`layoutOf`), and
  nothing is written until its bootstrap has once reported not starting (`settledProjects`).
- **A tab moved between panes gets a new host**, so `attachTerminal` moves the xterm element
  rather than calling `open()` again (which silently no-ops). Only the **focused** pane focuses its
  terminal; a focus change alone must never resize the pty.

## Nothing starts without git and an agent

`src/main/requirements.ts` checks git and every agent with `versionArgs` before anything opens;
passing (`startup:check`) is what calls `openWorkspace`. Missing something, `Startup` shows
`RequirementsDialog` instead of mounting `App` — a wall, not a question (no Escape), and **it
installs nothing**: no command works on all three platforms, and a program installed while the
dialog stands is still missing from this process's PATH. `--version` results are remembered
(`isAgentInstalled`); `npm start -- --simulate=git,claude` makes the dialog reachable on a
machine that has everything. The tests go the other way: `--allow-shell-only` lets a runner with
no agent open, and `--user-data-dir=<dir>` gives that run a profile of its own (and, only then,
a control token from its environment) — `test/app.test.ts` is the one user of both.

## Git

Git is never reimplemented. `src/main/git.ts` wraps the local CLI: `git()` resolves for *any* exit
code — callers decide what it means — and rejects only if git itself couldn't start. Never run git
from the renderer.

All of `git.ts` runs in its own `utilityProcess` (`git-host.ts`), reached through `git-client.ts`
— a proxy whose properties are the module's own functions. Two rules for anything added there:
nothing may import electron, and everything crossing the boundary must survive a structured clone
(an image as a data URL, an error as its message). A git process that *dies* rejects every
in-flight call; `Repository` catches that at each entry point and turns it into the shape callers
already handle, and the client restarts the process on the next call.

`Repository` (`src/main/repository.ts`) is the single source of truth for both the git pane and
the terminals, so a branch switched in a terminal shows up in the UI on its own. It watches the
working directory, debounces and throttles bursts, and only emits when state actually changed.
Diffs load on file selection, never up front.

**Everything the git pane can do fits in a context menu, an icon button or a question.** That
limits the *views*, not git: a command needing a checkbox list, a message field, or conflict
resolution is one the pane doesn't offer. Of what fits, we take GitHub Desktop's set — the branch
tree (branches, remotes, tags, stashes) with per-ref menus, checkout, status, per-file diff,
discard, `.gitignore`, fetch/pull/push (push doubles as "publish", `--set-upstream`), "commit all"
(one message asked, `add --all` then `commit` — no staging), and cloning from the add-repository
dialog. Cloning brought GitHub and GitLab behind one `GitProvider` interface (`src/providers/`);
providers stay out of the local git layer — once cloned, everything goes back through the CLI.

Every action goes through `Repository.runAction`, one at a time per repository, refreshing after —
two actions would race for the same index lock. Discarding and ignoring go through it too. The
renderer mirrors this in `App`'s `branchAction`; `BranchActions.run` is the one way in — a view
asks its own question first (it knows the remote, the branch, the file count), then hands over a
label and the call. Each repository also auto-fetches every ten minutes, silently on failure,
without taking the action slot.

The project row carries repository-wide entries (open in terminal, show in file manager, copy
path, view on host, change remote url, close) — nothing touches the working tree there; those
actions live in the git pane, where their target is on screen.

### Talking to a remote

Every command reaching a remote runs with `NETWORK_ENV` (`git.ts`), all aimed at stopping git
from asking a question there is no console to answer in — a command waiting for an answer holds
the repository's one action slot open indefinitely. Credentials come from the user's credential
helper or a provider token, or not at all — **TET writes nothing into that machine-wide helper**.
`LC_ALL=C` is what lets `runNetwork` match git's auth messages into `authRequired`, the one thing
the add-repository dialog's `CloneAuth` acts on; the reasons for each variable, and for what is
deliberately *not* matched, are in the comments there.

### The diff and the editor

A diff is read with `--ignore-all-space` only while the dialog's whitespace toggle is on, and
synthesised for an untracked file. Unfolding a gap asks `repo:file-lines` for exactly those lines
from the working tree — git isn't run again. An image is not "Binary file.": `readDiff` hands
both versions to the renderer as data URLs; SVG stays text.

The diff dialog doubles as a plain code editor (`CodeEditor.tsx`, one Monaco model for the
dialog's whole time on that file — a look-and-fix surface, not a multi-file session).
`monaco-core.ts` reproduces `editor.main.js`'s import list minus every language and language
service — re-diff it on a monaco upgrade. Coloring goes through the **same shiki instance and
theme the diff view uses** (`ensureLanguage` in `editor.ts`), so a token reads identically in
both. Saving goes through `Repository.writeFile`, guarded by the mtime the file was read at.
Keybindings are a curated preset (`keybinding-presets.ts`, chosen in Settings → Files) over tet's
own defaults (`keybindings.ts`): no chords, no provider-dependent commands — there is no language
server, and no format command exists as a result.

### Where we follow GitHub Desktop rather than git's default

- Discarding is not `git checkout --`: a file HEAD doesn't know is moved to the trash, not
  deleted; `git restore --source=HEAD --staged --worktree` covers everything else.
- Deleting a branch is `git branch -D`; the question says out loud what that risks.
- A `stash@{n}` is a position, not an identity; rows act on the last refresh's report.

### What the git view deliberately does not do

Built at some point and taken back out, so don't re-add without being asked: a commit UI with
per-file/per-line staging (what stayed is "commit all"); history, graph, cherry-pick, revert,
squash, reorder; bisect, submodules; conflict resolution beyond aborting; side-by-side diff;
discarding single lines; pull with rebase and force push (taken out with the old branch bar). A
git command needing a list, a message or a per-line decision is exactly what an agent should be
asked to do, where the answer, the conflict and the fix are all visible.

PRs and CI status are still open. Provider accounts aren't a login of the pane's either — they live
in the add-repository dialog, the one place talking to a host rather than a repository.

### Keep git off the main process, and count its invocations

Each of these was paid for once and measured; the numbers are in the comment at each site.

- Git stays in its own process — in the main process it puts typing lag back one command at a
  time, since that process also relays pty output.
- Starting git is what costs, so count *invocations*. `readState` gets by with two; `readStashes`
  is the third a refresh spends; anything added to the refresh path has to earn its process.
  `listIgnored` (the Explorer's `excludeGitIgnore`) is deliberately per listing and opt-in.
- A refresh finding events waiting goes back through `scheduleRefresh`, never re-runs at once.
- `readStatus` runs `git --no-optional-locks status`; don't fix the index-write feedback loop with
  another entry in `isIgnoredEvent`.
- `src/main/event-loop-monitor.ts` writes stalls to `event-loop.log` in `userData` every session,
  not behind a switch, so a stall is noticed while working. `logSlow` names a block whose own
  duration is worth knowing (`Repository.emit`'s `JSON.stringify`, reconcile's `JSON.parse`).

## Saved commands

The sidebar's lower half is a project's saved shell commands, under a `commands` key in a
`tet.json` in the repository's own root (`src/main/commands.ts`), not TET's `userData` — they
describe the project, so they travel and can be committed. A command is a plain string, or an
object once it needs a `name`, `cwd` or `env` (`{"command": "npm run build", "cwd": "web"}`) —
written the way you'd type it standing in that folder. The array's order is the screen order;
rows reorder by dragging (`useDragReorder`, shared with the project list).

**There is no shell in between.** `splitCommand` (`src/shared/command.ts`) reads the line as a
program plus arguments, started directly — the same on every machine. Pipes, redirection, `&&`,
`$(...)` and `$VAR` don't work; an operator surviving the split as its own word is refused with a
notice. `env` is a field for exactly this reason — no syntax writes a variable into a command that
works everywhere — and it outranks the inherited environment. `"shell": true` hands the line to
`AgentDefinition.runArgs` and only works where it was written. Where the line goes on Windows is
`resolveCommand`'s call (`src/main/pty.ts`, every case measured).

**Running one opens a terminal tab whose process is the command**, in its own directory, ending
when it does; `createCommandTab` is `createTab` with a program, so it shares the lazy spawn,
output batching and close path of every other tab. `TerminalSession` tells a clean end from a
failure by exit code (`stopped` vs `error`); an `error` tab draws `ExclamationIcon` in the mark
slot. A tab opened from outside the terminals pane is brought to front through `App.showTab`, a
one-off write into the layout, not a prop the pane re-applies. Saved-command tabs carry no
session marks.

A `tet.json` that's missing, unparseable or oddly shaped is simply no commands — it's the user's
file. A project with no `tet.json` **at all** gets its commands looked up unasked, at most once
per project per session. The wand beside `+` asks the first installed agent with `askArgs` (in
`AGENTS`' order) with `SUGGEST_PROMPT`; the reply is read as the first bracketed JSON array and
added without review — a wrong entry is one right-click from deletion. One `CommandList` serves
every project, so a wand result is keyed to the project it asked about.

## Explorer

The diff dialog's Explorer tree (`Explorer.tsx`, fed by `Repository.listExplorer`) is configured
from the same `tet.json`, shaped like a VS Code `.code-workspace` and read by `readExplorerView`
in `commands.ts` as defensively as the commands — the tree gets data and configuration in one
read and never parses the file itself:

- `folders` — `[{"path": "src/main/frontend", "name": "frontend"}, {"path": "."}]`, VS Code's
  multi-root workspace; overlap allowed, each file listed once, a selection revealed in the
  *innermost* root containing it. Missing or empty means the whole repository as one tree.
- `settings["files.exclude"]` — glob → `true`, matched against the **repository-relative** path
  (`**/node_modules` at any depth, `node_modules` top-level only). `.git` is hidden regardless.
- `settings["explorer.excludeGitIgnore"]` — default off: one `git ls-files` per listing.
- `settings["explorer.compactFolders"]` — **default on**; roots are never compacted.
- `settings["explorer.sortOrder"]` — default `default`; `modified` is the one value that costs
  a `stat` per entry.

"Add Folder to Workspace", "Remove Folder from Workspace" and "Exclude from Files" write
`tet.json` from the tree's context menu; `name` and the three `settings` entries are file-only, as
in VS Code. The watcher reports every write of `tet.json` as `commands:changed`, so the dialog
re-lists whoever wrote the file.

## Settings

One dialog for everything TET keeps about *itself* rather than a repository, opened from the one
button belonging to neither a project nor a pane (pane "a"'s strip). It asks nothing — a switch
applies the moment it's flipped — so one button closes it. Tabbed (Appearance, Notifications,
Shortcuts, Files, Info) with the add-repository dialog's `.dialog-tabs`, which is why neither has
a `.dialog-title`. Values live in `settings.json` in `userData` (`src/main/settings.ts`), written
whole and read back defensively.

**A setting reaches an agent through `AgentPaths`**, handed over at `prepareSpawn` rather than
imported, so the persisted copy stays the only one. That is the honest limit of a switch: an agent
gets its setup once per project and can't be reached afterwards, so a change applies to projects
opened after it — and the dialog says so. The color theme travels the same way, with one switch
per agent (`themeAgents`) for whether that agent is told to draw in tet's theme or left to its
own; which way the *background* is stays either way, since that is a fact about the window, not a
taste.

Deliberately not in there: the session marks (finished out of sight, waiting on an answer).
Neither is a notification to turn off.

## Everything the user is told is a notice

`notify(severity, message)` from `src/renderer/components/Notices.tsx` is the only way to say
something to the user — no view keeps a message of its own, nothing is written into the pane where
it happens. A plain function, not a prop or hook, modelled on VS Code's `window.showErrorMessage`.
The main process uses the same channel (`app:notice`). All three severities disappear after 8
seconds or on click; an identical message already standing is dropped, not stacked.

Not a notice: a status — a tab colored for an uninstalled agent, the progress bar, the head next
to a project's name. Those are conditions a view draws for as long as they hold.

Nor a *question*. `Dialog.tsx` puts both kinds the same way: a plain function anything can call,
one `Dialogs` drawing whatever's pending, one question at a time. `confirm` resolves to whether
the user went through (plus its one optional checkbox); `prompt` resolves to a name or null, and
can carry a per-project history dropdown (`commit-history.ts`, the commit message's). **The main
process asks nothing** — `repo:delete-branch` and `repo:discard` just do it; the question lives in
the view offering the action, which knows the remote or the file count. Electron's native
`dialog.showMessageBox` isn't used. Only ask before something irreversible; a question always
answered the same way isn't worth asking.

## One progress indicator per pane

Every pane that can be slow carries its own `.progress-bar` showing only what is happening in
*it* — a single spot for the whole app was tried first and read as "something, somewhere". One
component serves all (`ProgressBar.tsx`), dropped into whichever header declares `position:
relative`. **Never add a second bar inside one pane** — a new slow reason there is a new condition
feeding the one it already has. Today: each terminal pane (`Pane`'s `showProgress`, from
`TerminalDescriptor.starting`; the bootstrap listing, with no tab to point at, falls to pane "a"),
the git pane's two sections (`branch.busy` under BRANCHES, `acting` under LOCAL CHANGES — two
headers, two kinds of action), the diff dialog (`DiffView`'s `onBusy`) and its changes list, and
the command list's wand.

**A spinner in place of an icon is not a second one of these.** The bar is about the pane; a
spinner is about the one thing the icon stands for, and takes its place rather than a slot beside
it — a tab's agent icon while its session works a turn. An action button disabled for being
underway only dims. The project row is the one place a spinner stands alone, having no icon to
replace.

## Both ends of a turn

A session says whether it's *working* (spinner), *stopped for an answer* (question mark), or
*finished out of sight* (speech bubble) — one mechanism read at three points of the same turn,
drawn on the tab and on its project's row. A question is a standing fact, only *hidden* while its
tab is in front of the user and back the moment it isn't; a finished turn is a one-off notice
cleared by looking. A stopped session never spins anywhere (`hasBusyTab`, and `Pane`'s own
check): it is precisely *not* working. A sidebar bell for "finished" was tried and reverted — two
glyphs for one condition read as two conditions.

**On a tab all marks take the agent icon's place**, ranked **error/missing > waiting > working >
finished** (reasoned in `Pane.tsx`). In the project row the three turn marks are buttons stepping
through their sessions. All three are `--vscode-focusBorder` under one `.session-mark` rule; the
error mark alone is `--vscode-errorForeground`, not a fourth turn state.

**Nothing here is read off the terminal.** Each agent reports its own turn through
`AgentPaths.onSessionBusy` / `onSessionWaiting` / `onSessionFinished`: opencode on the event
stream TET already subscribes to (`session.status`, `permission.asked`, `question.asked`); Claude
Code and Codex through hook processes that `touch` a marker named after the session id into
`<agentDir>/busy/`, `finished/` and `waiting/`, picked up by `watchMarkers`
(`src/main/marker-watch.ts`, watch *plus* a timer sweep — win32 `fs.watch` misses files). The
hooks register regardless of notification settings; only their toast is optional. Reusing the Stop
hook is the point: it carries the `background_tasks` guard, so a turn that only launched a
subagent isn't "finished". Markers found at startup are deleted unreported.

**No agent reports that a question was answered**, and none needs to: the answer is typed into
the tab that asked, so a question clears on input that can be an answer (`answersQuestion` in
`session-manager.ts`) or either end of a turn — one rule for all three agents. **No hook fires for
a turn the user cut short** either; the net is each agent's own transcript (`turnEndedAt` in
`src/agents/*/sessions.ts`, with the forensics that tell an interrupt from a withheld marker).

State lives as `TerminalDescriptor.busy` / `waitingAt` / `finishedAt` per tab in the main
process. Two halves keep it honest: the **main process** sets it, never asking whether it should
(a turn reported before any tab claims its session waits in `pendingTurns` on a timer); the
**renderer** decides what's *shown* and clears what was seen, the rule living once in
`App.markedTabs`/`waitingTabs` so two views can't disagree. `App` holds every project's tabs for
the same reason it holds repository states: the project list needs all of them at once.

## Ending a session

A session is **asked to quit before it is killed** (`TerminalSession.stop`): the Ctrl+C bytes its
own convention expects (`AgentDefinition.quitPresses`), then a kill for what's still running.
`stop` resolves once the process is actually gone — `destroyTab` deletes what the CLI persisted
right after. A hard kill never lets a CLI run its exit handlers, and Claude Code keeps something
there that matters (a `~/.claude.json` record that, left armed twice, turns its fullscreen
renderer off machine-wide — the story is in `terminal-session.ts`). Stopping is asynchronous, so
`before-quit` holds the quit back and asks again once the sessions are gone; `closeTabs` starts
every doomed tab's stop before waiting on any.

## Agent-specific vs shared code

Each agent gets a folder under `src/agents/`, described by one `AgentDefinition`
(`src/agents/agent.ts`). The shared terminal layer never imports an agent's own code, only calls
its callbacks — a new agent is a new folder, one entry in `src/agents/index.ts`, one case in
`AgentIcon` (`src/renderer/components/agent-icons.tsx`, the only agent-specific thing outside
`src/agents/`, since that folder belongs to the main process).

- `executable`, `args`, `env`, `versionArgs` — how to start it, and how to tell "not installed"
  from a spawn that failed for another reason
- `askArgs` — one question answered on stdout, no terminal; a background question must not leave
  a session behind (each agent has its own way, commented in its `index.ts`)
- `runArgs` — one command run *in* a terminal; only the shell has it
- `sessions` — listing, resume args, rename, delete, optional `watch`
- `prepareApp` — run once before any project opens, for what a killed run left behind
- `prepareSpawn` — async setup before the first spawn, **the only place an agent may write
  anything**; a rejection marks the agent unstartable, so only reject for what truly makes it
  unusable (opencode's server, not a failed notification script)
- `resolveUrlPrefix` — completes a url the agent's TUI wrapped across rows
- `createIsSessionReady` — the per-agent guess at "the CLI drew its first real frame"
- `quitPresses` — how many Ctrl+C bytes make it quit by itself
- `plainCtrlCKills`, `takesRightMouse`, `swapsBlueMagenta` — measured facts the *renderer* acts
  on; they travel to it as flags on `AgentInfo`, since the renderer can't import `src/agents/`

### Never assume the agents behave alike

They are three separate products that happen to sit in the same kind of tab. Every time the same
question has been put to all of them, the answers differed — and the differences were only ever
found by **measuring the real binary through this same pty**, never by reading its source or its
docs, and never by reasoning from one agent to another:

- `createIsSessionReady`'s byte thresholds: 500 / 800 / 600, one per agent, all tuned by hand.
- `quitPresses`: Claude Code wants two Ctrl+C and withdraws the offer after about a second;
  Codex and opencode quit on one, and a second byte sent to a Codex already leaving *kills* the
  shutdown it would have completed. No single interval serves all three.
- The right mouse button: Claude Code and opencode take it themselves through mouse reporting,
  Codex deliberately leaves it to the terminal (`takesRightMouse`).
- Colours: opencode's `"theme": "system"` adopts the terminal palette but swaps blue and magenta
  (`swapsBlueMagenta`; `buildXtermTheme` swaps them back — observed, not derived); Codex ignores the
  palette entirely until `-c tui.theme=ansi`, and on win32 guesses light/dark from the console,
  not the terminal (hence `launch.cmd` and the OSC 4 handling in `src/agents/codex/index.ts`);
  Claude Code paints dark unless told otherwise, so tet passes `theme` in its `--settings` file (a
  custom theme in tet's own colors was built and taken back out — a ~230 ms dark frame, see
  `src/agents/claude/hooks.ts`).
- Turn signals: opencode has an event stream, Claude Code and Codex need hook processes touching
  marker files, and Codex only runs a hook it has hashed and decided to trust.
- Ctrl+C: Claude Code and opencode read `\x03` as an ordinary byte; to a Codex in cooked mode it
  is a process-level `CTRL_C_EVENT` that kills it, so it is never sent there (`plainCtrlCKills`
  draws the line).

So when adding anything that touches how a CLI is driven, the default is a field on
`AgentDefinition` with a value per agent, not one shared constant with a comment guessing at the
others. And what goes in that field is what was measured — a value carried over from the agent
next to it is a guess wearing a number.

### One SQLite database under every opencode and Codex process

TET runs one `opencode serve` per repository, but every instance shares one machine-wide
`opencode.db`. So servers come up one at a time (`OpencodeServer.queue` — parallel boot lost the
write-lock race), and what a killed run left running is taken down before the first of them starts
(`server-registry.ts` — never by pid alone, only once it answers on its recorded url with its
recorded password). That cleanup is what `prepareApp` is for. Codex's `$CODEX_HOME` state db has
the identical race, reproduced rather than avoided, which is why there is no persistent
`codex app-server`: rename and delete go through a short-lived JSON-RPC call instead
(`src/agents/codex/app-server-client.ts`), never two at once.

### Codex's hook trust

Codex only *runs* a hook whose hash it trusts; handed an unknown one, an interactive session opens
on a blocking "Hooks need review" screen. `src/agents/codex/hooks.ts` reproduces that hash — a
private, unversioned serialization, so if a future release changes it the screen reappears once
(not silent, not a crash; re-check `hooks/src/engine/discovery.rs::hook_hash`). Two things found
only by testing the real spawn path, both commented there: the trust entry must live inside the
*value* of one combined `-c hooks={…}` argument, and that argument must be built from TOML
literal strings.

## The control channel: `tet-ctl`

An agent can ask the app around it for things the filesystem and git can't give it — the theme,
the project list, the terminal tabs. `src/main/control-server.ts` listens on a named pipe (win32)
or a socket file in `userData`, one JSON line per connection, and answers with the same singletons
`ipc.ts` holds: a second transport onto the same logic, never a second implementation
(`addProject`/`removeProject` in `projects.ts` are shared for exactly that). The wire contract and
the verb list are `src/shared/control.ts`; the CLI is `src/cli/tet-ctl.ts`, bundled on its own and
run by a launcher in `userData/bin` under tet's own electron as node (a `node` on the machine is
not a given). What reaches a terminal is decided in `spawnAgentProcess` (`pty.ts`), in layers
**above** `process.env`: the socket, a per-run token, the launcher directory on PATH, and the tab's
own project and tab id — above, because a tet started from one of its own shell tabs inherits the
outer one's values. Only ptys get them; the opencode server and git do not. The agent learns the
command from the context file (`shell-context.ts`), which is never empty for that reason.

Deliberately not there: the split layout (renderer state only), git (the agent has `git`), provider
accounts, and `quit`. `restart-app` is the one verb that ends sessions — every one in every
project, the caller's included — and takes `--confirm`, which an agent passes only when the user
asked. A theme change answers `restartRequired`; that is a fact for the agent to relay, never a
reason to restart on its own. A verb that ends its caller (its tab, its project, the app) replies
before it acts, or the CLI dies with nothing on stdout.

## Never touch the user's agent configuration

Everything TET generates lives under its own `userData` and is pointed at from outside:

- Claude Code: a generated settings file passed as `--settings`. `~/.claude/settings.json` is
  never read, written or replaced.
- opencode: `OPENCODE_CONFIG_DIR` on the **server** process, additive and shared across
  repositories (an unfamiliar config dir costs a minutes-long install) — so each repository's
  generated plugin needs a unique filename *and* a runtime guard on `TET_PROJECT_ROOT`, and is
  only written when its content changes. `OPENCODE_TUI_CONFIG` on the **terminal** process
  carries nothing but `"theme": "system"` (`tui-config.ts`), layered over the user's own.
- Codex: `-c key=value` overrides for that one process only — verified nothing is written back.
  `~/.codex/config.toml` and `~/.codex/hooks.json` are never read, written or replaced.

## Files other processes read

The context file and shell transcript are written by TET and read by a separate process. Write
beside the target and `rename` into place, never in place — on Windows a read landing mid-write
fails outright. Marker files sit outside that rule: the *filename* is the whole message.

## Cross-platform requirement

Must work on Windows, Linux and macOS. Never add OS-specific behaviour without an equivalent for
the others.

- Build paths with `path.join`; route process spawning through `resolveCommand` (`src/main/pty.ts`).
- Generated `.ps1` files need a UTF-8 BOM; generated `sh` scripts must be LF, whatever the
  source's line endings.
- Anything written *into* a generated script needs literal quoting (`os-notify.ts` has the two
  helpers): a repo folder or user name may hold a `$`, and the interpolating forms once printed
  half a repository's name in a toast.
- Claude Code's hook shell on win32 varies (PowerShell, cmd.exe, Git Bash all observed). Avoid
  shell builtins and nested quoting; invoke a plain exe with `-File "<script>.ps1"`.

## The keyboard belongs to the terminal

A terminal tab holds a foreign program owning every key while focused, and TET's handler runs
*before* xterm encodes anything (`attachCustomKeyEventHandler` in `terminal-views.ts`). **It takes
nothing an agent could have received**, decided by reading xterm's own `Keyboard.ts` rather than
assuming — the findings (which combinations reach no branch) are in `src/renderer/shortcuts.ts`,
the one list both `App.tsx`'s listener and the settings dialog read from. Check a new shortcut
against that reading, not against intuition. None of the window shortcuts close a tab. Shift+Enter,
Ctrl+V and Ctrl+C are handled *for* the terminal, not taken from it; Ctrl+C with a selection
always copies, and its per-agent rules are above.

## The renderer

- Terminal output goes straight to xterm, never through React state. Instances live in
  `src/renderer/terminal-views.ts`, outside React, keyed by project *and* tab (tab ids are only
  unique within their project). Output arrives batched, one flush for every terminal.
- An xterm is built the first time its tab is in front of the user, not on mount — every tab of
  every project mounts at startup, and building each was most of the window's start.
- **The views under `App` are memoized, and `App` hands them stable props.** `App` re-renders on
  every tab and repository push from any project; `React.memo` on `TerminalsPane`, `ProjectList`,
  `CommandList`, `GitPane`, `BranchTree` and `DiffDialog` only holds while props stay stable: a
  callback is a `useCallback`, an object a `useMemo`, an empty list a shared constant (`NO_TABS`,
  `NO_IDS`). An inline arrow on one of these silently switches its memo off.
- A merely hidden terminal keeps its layout (`visibility`, not `display`) — xterm needs a laid-out
  element to measure itself. A pane using `display: none` needs refitting on return.
- **The element xterm mounts into is `.terminal-host`, never `.terminal`** — xterm gives its own
  element the class `terminal`, so a rule named for the plain word lands on both (a doubled gutter
  for months). xterm's own classes are `xterm`, `xterm-viewport`, `xterm-screen` and `terminal`.
- A file dragged over a terminal frames the pane with a `::after` overlay, never a border — a
  border would shrink the box xterm measures and refit the pty. A file dropped anywhere *else* is
  swallowed in `main.tsx`, or Electron navigates the window to it. Dropped and pasted files type
  their path through `term.paste`; content without a path goes to a temp file first, swept a day
  old at startup.
- **Nothing at the terminal's right edge may be left to an xterm default, and CSS isn't what
  settles it** — the scrollbar and overview ruler are xterm's own, so `theme.ts`'s colors decide.
- Resizing reflows xterm and notifies the pty together, only once dragging settles
  (`RESIZE_DEBOUNCE_MS`) — an immediate local reflow was tried and reverted, since ConPTY corrupts
  a CLI's redraw when a resize lands mid-way (an upstream bug VS Code hits too).
- `provideLinks` runs on **every render** while the pointer's over the terminal, and an agent TUI
  repaints constantly. Nothing expensive, no logging, in that path.
- A terminal's xterm theme is built **per terminal**, not once for the window (`buildXtermTheme`,
  for opencode's swap above).
- Measurements are shared, not invented per view: a bar along an edge is 35px (tab strip, title
  bar, `.section-header`, the diff dialog's bar); the action button is 22px; the border between
  panes is 1px `--vscode-panel-border`. Check the neighbouring view before inventing a size.
- **An icon is one size everywhere, and it takes two numbers.** The box is `--icon-size` (13px);
  the other is how much of its grid the path covers — every icon declares the `extent` it was
  **measured** at (`getBBox` on each child grown by half its stroke), and `Svg` crops the viewBox
  so all cover `TARGET_EXTENT`. Extents are tuned to the *geometric mean*, not the longer side.
  Neither number is optional: unequal extents in a shared box is what the app looked like for
  months. State an icon's size in CSS, never rely on the `width`/`height` attributes.
- **A new icon comes from Lucide first** (lucide.dev, ISC), vendored on its native 24-unit grid
  (`fitIcon`/`fitStroke` take the grid) — the hand drawings in `icons.tsx` are what's left of the
  icons Lucide had no match for. A hollow shape can still read badly at 13px; that is a per-icon
  legibility call, not a reason to redraw by hand.
- **When two things that should look identical don't, measure them — don't read the code harder.**
  Rebuild a page with the *built* stylesheet, serve over http, read `getComputedStyle`. Use layout
  size, not `getBoundingClientRect`, on anything `.spinning`.
- **Anything that marks or points at something is 1px in `--vscode-focusBorder`**: the drop
  indicator, the active tab's underline, the drag-over frame, the dragged sash. A new one copies an
  existing rule — two that differ read as two meanings. Every session mark sits under one
  `.session-mark` rule.
- **Icons and marks are monochrome**; the only colour any takes is that blue. Two sanctioned
  exceptions — the changes list's status letters (`gitDecoration-*`) and the error mark
  (`--vscode-errorForeground`) — both passing the one test: a colour is allowed where Dark Modern
  already names one for that meaning, nowhere else.
- Colors come from `--vscode-*` variables only (`src/renderer/vscode-theme.css`); add a new
  variable under VS Code's own name rather than hardcoding. Exception: the diff's syntax colors,
  which Shiki hands back per token (`diff-highlight.ts`). Shiki's editor-surface colors are
  patched with those variables at load (`buildShikiColors`) and monaco takes its theme from
  shiki's, so the variables are the one source for all three.
- **A theme is a value set in `vscode-theme.css`** — `:root` is Dark Modern, every other a
  `:root[data-theme="<id>"]` block naming only what differs — plus an entry in
  `src/shared/themes.ts` for what lives outside the stylesheet (shiki theme, window chrome,
  per-agent hints). Values come from VS Code's theme files, not from eyeballing. The id travels
  `settings.json` → `currentTheme` → `additionalArguments` → preload → `data-theme` in
  `main.tsx`, synchronously, so the first frame is right. **A change applies after a restart**:
  xterm, shiki, monaco and the window chrome all bake it in at construction.
- Two hover colors, not interchangeable: a *row* takes `--vscode-list-hoverBackground`, an
  *action button* the translucent `--vscode-toolbar-hoverBackground` wherever it sits. A selected
  row keeps its selection color while hovered.
- The renderer is one bundle, so every Shiki grammar in `diff-highlight.ts`'s list ships — a list
  of what a repository plausibly holds, not all two hundred. Imported lazily.
- `.pane-hidden` is last in `styles.css` on purpose: it overrides the `display` the panes set on
  themselves, all single-class selectors too.

## npm scripts

- `npm run compile` — bundle main, preload and renderer
- `npm run typecheck`
- `npm run lint`
- `npm test` — compile, then node's own runner over `dist-test/`. Three files: the control
  server with its electron-side dependencies faked, driven through the built `tet-ctl`
  (`control.test.ts`); the pure pieces around it — env layering, launcher, context file
  (`unit.test.ts`); and the real app started on a throwaway profile and driven through `tet-ctl`
  alone (`app.test.ts` — needs a display, `xvfb-run` on Linux). Nothing looks into the window:
  what the renderer did shows in the main process, or it is checked by hand.
- `npm start` — typecheck, compile, then launch (see "Do not restart the app yourself" first). The
  typecheck is there because esbuild only bundles: an unimported identifier is a global to it, and
  the app dies on load with a `ReferenceError` a `tsc` run would have named at the import.

## Releasing

When asked for a release, run it — no need to re-derive these steps first:

```
npm version patch   # or minor / major
git push && git push --tags
```

`npm version` bumps `package.json` and tags in one step. The tag push triggers
`.github/workflows/build.yml`, which builds all three platforms and publishes to a GitHub Release;
the repo is public so `electron-updater` (`src/main/auto-update.ts`) can read releases without a
token. Windows and Linux (AppImage) auto-install on the next quit — never forced, since a terminal
tab is a live agent session. macOS and the `.deb` build only get a notice linking to the release.
