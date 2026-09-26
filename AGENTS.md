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
  `terminals/` (pty, sessions, hooks), `control/` (`tet-ctl`), `ipc/` (the `TETApi` handlers,
  registrars by area, each taking only the singletons it touches), `agents/`, `providers/`; flat
  is the app itself — `main.ts` (window, startup), settings, projects, requirements, sbx.
- `src/renderer/`: `terminal/` (xterm, split view, link providers), `git/` (the side pane's git
  view), `files/` (its other one: the Explorer tree, the SEARCH pane, Seti's file icons),
  `diff/` (the editor tab: monaco + shiki), `sidebar/`, `dialogs/`, `ui/`, `themes/`; flat is the
  shell — `App`, `Startup`, `styles.css`, `shortcuts.ts`.
- Each agent is a folder under `src/main/agents/`, described by one `AgentDefinition` (`agent.ts`
  documents every field). Shared code imports only the registry (`agents/index.ts`), `agent.ts`'s
  types and the agent-neutral `ask.ts` and `system-prompt.ts`. A new agent is a new folder, one
  registry entry, its id in `AGENT_IDS` (and `SBX_AGENT_IDS`, `src/shared/types.ts`), and one case
  in `AgentIcon` (`src/renderer/ui/agent-icons.tsx`, the only agent-specific code outside
  `agents/`; user-facing text may name agents).
- A project is a git repository — a folder without one is refused. Its id is `tet.id` in the
  repository's own git config (`projects.ts`'s `resolveProjectId`), shared by its worktrees, and
  everything TET keeps of it lies in `~/.tet/projects/<id>/` (`project-dirs.ts`: `main/` and
  `worktrees/<key>/`, each with `host/<agent>` and `sandbox/<agent>`). Nothing a sandbox must not
  see ever goes there: sbx is granted the folder whole. Where something runs — the main worktree
  or a worktree — is a `CheckoutRef`, never an id of its own; one string (`checkoutKey`) only
  where a single key is unavoidable.
- `tet.json` in a repository's root describes the project and travels with it: saved `commands`,
  the Explorer view and `sbx`. Read defensively (`src/main/tet-json.ts`): missing or malformed
  means nothing configured. A worktree has none of its own: it takes its project's (`configRoot`)
  and its sbx values, forwards none of the ports, and changes nothing of it — its row, Explorer and
  COMMANDS offer no settings, `tet-ctl` refuses them.

## Never assume the agents behave alike

Claude Code, Codex, opencode and pi are four products in the same kind of tab, alike in nothing:
readiness, how Ctrl+C quits, the right mouse button, colors, turn signals, resize redraw. So
anything about how a CLI is driven is an `AgentDefinition` field with a value per agent (or what
its `prepareSpawn` returns, e.g. the fullscreen args that make a resize redraw in place),
commented there with how it was found. **Measured through this same pty** is preferred, never
taken from another agent; a value only docs or source could give says so in its comment. The one
exception is the right mouse button, decided per click by the terminal's mouse mode
(`terminal-views.ts`), not per agent.

## Never touch the user's agent configuration

Everything TET generates for an agent lives under `~/.tet` (`data-root.ts`) and is pointed at from
outside — what belongs to a checkout in its `host/<agent>` or `sandbox/<agent>` folder
(`project-dirs.ts`), each side handed only its own; only pasted or dropped files go to the OS temp
directory (`ipc/files.ts`).
`prepareSpawn` and `prepareSandboxSpawn` are the only places an agent writes configuration;
beyond them it touches only its own sessions: when the user renames or deletes one, and the one a
background question leaves (`cleanupAsk`).

- Claude Code: a generated `--settings` file; never `~/.claude/settings.json`.
- Codex: `-c key=value` for that one process; never `~/.codex/config.toml` or `hooks.json`.
- opencode: `OPENCODE_CONFIG_DIR` (additive) and `OPENCODE_TUI_CONFIG`; never an `opencode.json`.
- pi: a generated extension via `-e`; never `PI_CODING_AGENT_DIR`.

## Cross-platform

Must work on Windows, Linux and macOS; no OS-specific behaviour without an equivalent for the
others.

- Paths through `path.join`; every agent, shell and `sbx` spawn through `resolveCommand`
  (`src/main/terminals/pty.ts`), never `shell: true`.
- A generated `sh` script is LF, and anything written into it is quoted with `shellSingleQuote`
  (`src/main/script-text.ts`).
- A hook command runs under whichever shell the agent picks: keep it a bare
  `tet-ctl hook <event>`.
- A file another process reads (hook settings, opencode records, launchers) is written beside the
  target and renamed into place.

## Git

- Git is never reimplemented and never run from the renderer. `src/main/git/git.ts` wraps the CLI
  in its own `utilityProcess` (`git-host.ts`, via `git-client.ts`): nothing in `git.ts` or
  `git-host.ts` imports electron, everything crossing the boundary survives a structured clone.
- Starting git is the cost, so count invocations: anything added to the refresh path must earn its
  process (the budget is commented at `git.ts`'s `readState`).
- `Repository` is the single source of truth for the git pane and the terminals; every git command
  that changes an open repository goes through `Repository.runAction` (renderer:
  `git/run-action.ts` — `useBranchActions` for branch commands, `useFileAct` for the changes list
  and the Explorer). Reads run beside it, and so does the periodic fetch, which actions wait on.
- Remote commands run with `NETWORK_ENV`. **TET writes into no credential helper itself**: a login
  typed into tet reaches git through askpass (`GitLoginStore.run`), and git stores it in the
  user's helper; where there is none, tet keeps it sealed in `~/.tet/git-logins.json`.
- tet never diffs: it hands monaco's inline diff editor two texts (`Repository.readFile`).
- **A linked worktree is a worktree and belongs to its project; it is not a project.** It only
  behaves like one in places (its own row, tabs and git pane) — never design from "a worktree is a
  project". TET makes its worktrees at `~/.tet/projects/<id>/worktrees/<key>/checkout`; the key is
  given once and never changes, and every worktree TET made opens with its project, listed under
  its row (`Project.worktrees`) and in the branch tree's WORKTREES (`RepositoryState.worktrees`,
  `WorktreeInfo.key`), both read off the disk. One made elsewhere (plain `git worktree add`, an
  older TET) has no key: shown greyed, never opened, never renamed or deleted by TET. A worktree
  and its branch are one: made together at the default branch (`worktreeBase`), named by the
  branch, deleted together, and never switched; renaming it renames the branch alone, its folder
  and terminals stay. Its base is tet's own `branch.<name>.base` (`git.ts`'s `worktreeAdd`).
  Removing a project deletes the worktrees TET made, with their branches.

**Scope.** Everything the git pane does fits in a context menu, an icon button or a question. Of
that, GitHub Desktop's set: the branch tree (branches, remotes, tags, stashes), checkout, branch
and tag create/rename/delete, merge and rebase onto a branch, abort, per-file diff, discard,
`.gitignore`, fetch/pull/push, commit of all changes or the selection, stash of all and
apply/pop/drop, remote URL, worktrees (add, rename, delete), init and clone (GitHub/GitLab via
`GitProvider`), and a commit message suggested by an installed agent. Where Desktop differs from
git's defaults, follow Desktop. The project row's entries are repository-wide and never touch the
working tree — a worktree's own row excepted, which is that tree, and its merge into the base, run
where the base is checked out.

Don't add without being asked: staging or per-line staging, history or graph, cherry-pick, revert,
squash, reorder, bisect, submodules, conflict resolution beyond aborting, side-by-side text diff,
discarding single lines, pull with rebase, force push. A command needing a list, a message field
or a per-line decision is for an agent.

## UI rules

- **Layout**: projects in the left sidebar, each with its worktrees; the tab strip is one
  checkout's terminals plus its editor tabs — VS Code's preview rule, one preview tab per checkout
  (`editor-tab.ts`). Git and
  files are not tabs but one side pane toggled from the strip.
- **Split view**: up to four panes in fixed presets, reached only by dragging a tab onto a snap
  zone. Every rule is in `src/renderer/terminal/pane-layout.ts`, the state in
  `use-project-layouts.ts`, called from `App`.
- **Everything the user is told is a notice** — `notify()` (`src/renderer/ui/Notices.tsx`; main
  sends `app:notice`) — **unless a dialog on screen says it** (below). No other view keeps a
  message of its own; a status (marks, progress bar) is not a notice.
- **Every question is `confirm`/`prompt` from `Dialog.tsx`**, asked by the view offering the
  action; the main process asks nothing, no native message boxes. Ask only before something
  irreversible — removing a project asks only when it takes worktrees along; its own data goes
  unasked. Card dialogs are drawn in `DialogFrame`. The one exception: an agent's
  `env-request`, answered in `EnvDialog`, one at a time (`environment.ts`).
- **A dialog on screen says what concerns it; prefer this to a notice.** Words alone, no mark,
  coloured by what it is. A failure belongs where the answer was typed: under that field
  (`Field`'s `error`); in a row of a list as the error mark's tooltip beside it (`RowMark`, the
  one mark; on a dialog tab, `DialogTab.mark`); else left in the button row, level with the
  buttons (`DialogFrame`'s `error`) where the fields are several or across tabs — what was typed
  is held so it can be corrected, and it is git's own words for a name it will not take, never
  tet's guess at them. A list that could not be loaded shows its failure in its place
  (`DialogError`).
  What the unsaved edits as a whole lead to goes in the same place (`DialogFrame`'s `message`),
  e.g. `RestartNote` while they reach running tabs only once restarted. A notice is for what has
  no dialog up to carry it; a `confirm`
  has no field, so it notifies.
- To get this, **a question runs its own answer** (`PromptOptions.submit`): the dialog stays up
  while the action runs, so what runs it hands the failure back instead of notifying it
  (`git/run-action.ts`). A new verb a dialog calls answers its failure rather than sending
  `app:notice`.
- **Nothing is written until Save**; Cancel and Escape drop edits. The exception is the SBX
  dialog's Docker sign-in and sign-out and the Add Repository dialog's account removal and
  namespace pick, which act at once. A setting reaches an agent at its setup
  (`AgentPaths`), so it applies to projects opened afterwards; the theme and the idle reminder
  redo the setup of open ones (`themeChanged`, `idleReminderChanged`).
- **A section of typed rows never says it is empty** (`RowSection`): it shows one blank row to
  type into, on opening and once the last is removed (`atLeastOne`), and Save drops a blank row.
  Only rows a picker adds (the SBX paths) get a line saying there are none.
- **One progress indicator per section** (`ProgressBar.tsx`, `Section`'s `busy`): a new slow
  reason feeds the existing bar. In a dialog that bar is `DialogFrame`'s `busy`, so a busy state
  held by a nested view is lifted to the view owning the frame. No spinners for progress: the one
  spinner is a session's working mark.
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
  except shiki's syntax colors and the dialog overlay's fixed dim. A theme is one stylesheet
  (imported in `main.tsx`) plus an entry in `src/shared/themes.ts`; a syntax theme shiki lacks adds
  its JSON beside it and a line in `diff-highlight.ts`.
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
  command, opencode's plugin and pi's extension by posting the same request. The one exception: no
  agent's hook fires for a turn the user cut short, so reconcile ends a turn by the agent's own
  session record (`AgentSessionInfo.turnEndedAt`) — never starts one, never marks.
- The main process sets the state (`CheckoutSessionManager.hookEvent`); the renderer decides what is
  shown (`App.markedTabs`) and clears what was seen (`terminals.seen`).
- A session is asked to quit (`quitPresses`) before it is killed — a hard kill skips a CLI's exit
  handlers.

## The control channel: `tet-ctl`

Lets an agent ask the app for what the filesystem and git can't give (theme, projects, tabs). A
second transport onto the logic behind `ipc/`, never a second implementation. Contract and
verbs: `src/shared/control.ts`; server: `src/main/control/control-server.ts`; CLI:
`src/cli/tet-ctl.ts`.

- `restart-app` passes `--confirm` only when the user asked. `restartRequired` is relayed to the
  user, never acted on.
- Agents learn of `tet-ctl` once per session: `systemPrompt`
  (`src/main/agents/system-prompt.ts`), appended to each agent's system prompt (Codex: its
  `SessionStart` hook's added context), never replacing the user's instructions.
- **Environment variables** (`src/main/environment.ts`): tokens and passwords an agent needs, typed
  only into TET's dialog (`env-request`), never the chat; kept in the clear (every tab gets them anyway), global, and
  set in every tab at its start (`pty.ts`'s `buildEnv`), over what the machine sets itself — said
  in a notice.
  A running tab takes them up only when restarted: the dialog's Save restarts the asking one.
  None in a sandbox, and the verbs refused *and* unmentioned there — not in `help`, not in its
  system prompt.
- A caller is a project, a worktree (`TET_WORKTREE`, its key) and a tab; its ids count only with
  the token made for them (`control-token.ts`): a terminal gets its tab's token, never the run's.
  Without flags a verb acts on the caller's checkout, `--project` alone on a project's main
  worktree, `--worktree` on one of its worktrees (`resolveCheckout`).
- `tabs-send` and `tabs-output` answer only for a tab of the caller's own project, any of its
  checkouts (`ownProjectOnly`); from a sandbox, every verb only for the caller's own checkout.
  `tabs-send` never from inside a sandbox. `tabs-output`, `tabs-close` and `tabs-rename` from a
  sandbox reach only tabs running there: a host tab is the machine's, and its output may print the
  host's control token.
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
  so the same listing code serves both. Of `~/.tet` it sees only its checkout's `sandbox/<agent>`
  folder, and a worktree's sandbox is its own (its workspace is fixed at `sbx create`); under
  governance one rule, `~/.tet/projects/**`, allows TET's folders and its worktrees.
- Generated setup targets where it runs, not `process.platform` (`HookTarget`).
- **tet.json holds what was applied.** Save checks each row against sbx's policy (hosts through
  `sbx policy check` under governance, paths and knowledge through the rules `sbx-policy.ts`
  evaluates) and against this machine (a path exists, a port is free, a value is stored). A row
  that fails, or that sbx refuses while applying, is neither saved nor applied; the rest goes
  through. A Save sbx cannot answer for (a listing fails, a sandbox will not start) stops before
  changing anything — could-not-say is no refusal. One check for the dialog, `sbx-set-*` and a session's start (`readSbxProblems`).
- **The dialog checks live** whatever can be checked, and marks a failing row with the error mark
  saying what is wrong — never that it will not be saved.
- **A session's start applies tet.json as it stands and never writes it.** What the policy forbids
  or this machine lacks is skipped and told in one notice per dialog tab and reason, its rows
  listed (`Couldn't set hosts:` … `Forbidden by governance`): how a user learns that governance
  took over.

## Startup

`src/main/requirements.ts` checks git, the agents and sbx before the workspace opens; without git,
or with neither an agent nor sbx, `RequirementsDialog` is a wall and **installs nothing**.
`process.env.PATH` is rewritten before that check (`augmentAgentPath`) and everything spawned
inherits it.

## npm scripts

- `npm run compile`, `npm run typecheck`, `npm run lint`
- `npm test` — compile, then node's test runner over `dist-test/`, one file per seam; nothing looks
  into the window. `app.test.ts` starts the real app on a throwaway profile (needs a display,
  `xvfb-run` on Linux); `install.test.ts` runs only with `TET_INSTALL_TEST=1` after `npm run dist`
  (on Windows it writes shortcuts and the PATH entry for the account).
- `npm start` — typecheck, compile, launch (see "Do not restart the app yourself").
  `npm start -- --simulate=git,claude` shows the requirements dialog, `--simulate=sbx-mode` a
  machine with only git and sbx; `--user-data-dir=<dir>` gives a run its own profile.
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
