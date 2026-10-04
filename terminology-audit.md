# Terminology audit

One concept, one name — in code, comments, CSS, user-facing text, `tet-ctl` and AGENTS.md.

## Context

### What came before: "lanes"

The side views left of the terminals had piled up names: *column*, *side column*, *sidebar*,
*side pane*, *side view*, *git pane*, *git view*, *files view*. They were unified into one term:

- **lane** — the projects lane, the git lane, the files lane.
- Folders: `src/renderer/lanes/{projects,git,files}/`, each importing no other lane (eslint
  `LANE_FOLDER`); their state in `src/renderer/lanes/use-lanes.ts`. What two lanes share lies below
  them (`src/renderer/git/`: `run-action.ts`, `worktree-questions.ts`, `GitLogin.tsx`).
- Identifiers: `Lane`, `LANES`, `useLanes`, `freeLane`, `pinnedLanes`, `toggleLane`, `GitLane`,
  `FilesLane`; CSS `.lane`, `.lane-content`, `.lane-toggle`.
- "pane" was meant to be left to the split view's panes alone.
- Settings: lane pins and order in `settings.json`'s `appearance.lanes`; widths and the free lane
  in layout storage.

### The prompt

> You saw what I wanted from lanes. Are there other places where we use different terms for the
> same thing? Please analyse the project and list them.

### Method

Three read-only search agents scanned the project in parallel, each told AGENTS.md's fixed
vocabulary and asked for concepts named in more than one way (identifiers, comments, CSS,
user-facing strings), with counts and example locations, ignoring pairs that genuinely mean
different things:

1. `src/renderer/` incl. `styles.css`
2. `src/main/`
3. `src/shared/`, `src/cli/`, `src/preload/`, AGENTS.md, CHANGELOG.md, README, `scripts/`, test
   names, and every user-facing string (dialogs, notices, menus, tooltips, `tet-ctl` help, the
   agents' system prompt, settings tab names)

Their findings were deduplicated into the list below. Counts are approximate (grep). Line numbers
are as of commit `50bfb43` plus the working tree at the time and may have drifted. Each item ends
with a **proposal**; none is decided yet.

---

## High impact — user-facing or against AGENTS.md

### 1. The git lane is called "repository"

- Strip toggle "Show/Hide the **repository**" (`src/renderer/tabs/Pane.tsx:58-59`, noun
  `"repository"` in `LANE_TOGGLES`).
- Shortcut "Show or hide the repository" (`src/renderer/shortcuts.ts:37`, id `toggleGit`).
- Everywhere else: lane id `git`, `GitLane`, `GitIcon`, `toggleGit`, settings tab "Git", "the git
  lane" (`src/shared/control.ts`, AGENTS.md ×4). README says "git pane" ×2, CHANGELOG "git pane" ×5.
- Conflicts with AGENTS.md: "repository" means the folder the user opened, as opposed to a
  worktree — and the git lane shows a worktree's git too.

**Proposal:** "git" (toggle "Show/Hide git", shortcut "Show or hide git").

### 2. The files lane: "files" vs "Explorer"

- Toggle "Show/Hide the files" (`tabs/Pane.tsx:60`), shortcut "Show or hide the files"
  (`shortcuts.ts:38`), but the lane's header says "EXPLORER" (`lanes/files/FilesLane.tsx:82`).
- Settings tab "Files" with a group "EXPLORER tree" (`dialogs/SettingsDialog.tsx:39,369-370`).
- Menu entry "Exclude from Files" (`lanes/files/Explorer.tsx:302`).
- `tet-ctl` verb `explorer-list`, but its summary says "What the **files lane** lists"
  (`src/shared/control.ts:547-550`); its test is titled "lists the files lane's files".
- IPC `repository:list-explorer`, `repository:explorer-settings`; meanwhile the `files:` namespace
  in `src/preload/preload.ts:184-189` holds drops and pastes, not the files lane.
- The Explorer's configuration alone has five names: "Workspace" ("Add Folder to Workspace" /
  "Remove Folder from Workspace", `Explorer.tsx:291,297` — VS Code's wording, but TET has no other
  "workspace" noun and AGENTS.md calls TET "a git workspace"), "Files" ("Exclude from Files"),
  "Explorer view" (`App.tsx:547`, AGENTS.md), "the project's view" (`Explorer.tsx:286`), "EXPLORER
  tree", "Explorer settings" (`SettingsDialog.tsx:27`).
- Counts: "Explorer" ~207 in src, 7 in AGENTS.md, 12 in CHANGELOG; "files lane" 5 in src.

**Proposal:** the lane is **files**, the tree in it is the **Explorer** (as AGENTS.md has it);
the verb, its summary, the menu entries and the settings group follow that split. The `files:` IPC
namespace for drops deserves its own name (e.g. `drops:`).

### 3. "pane" still means five things

AGENTS.md reserves *pane* for the split view's panes. It is also used for:

- **The lanes:** "files pane" (`lanes/files/Explorer.tsx:94,353`, `lanes/files/use-file-search.ts:9,13`,
  `styles.css:746`, `ui/icons.tsx:405` "files-pane headers"), "the pane" for the git lane
  (`lanes/git/GitLane.tsx:59`, `lanes/git/BranchTree.tsx:392`).
- **Resizable areas in general, lanes included:** `MIN_PANE_WIDTH` / `MIN_PANE_HEIGHT`
  (`ui/Sash.tsx:4-29`, used for lane widths in `lanes/use-lanes.ts`), `--pane-min-width`
  (`styles.css`), `usePaneSize` / `usePaneToggle` / `usePaneChoice` (`ui/layout-storage.ts`) storing
  lane widths, the free lane and the LOCAL CHANGES list/tree choice.
- **A lane's section:** "SEARCH pane" (×6 in src; AGENTS.md lines ~72 and ~289), `git/run-action.ts:18`
  ("the pane's own bar covers the whole section"), `styles.css:84`.
- **A dialog tab's body:** `ui/DialogFrame.tsx:92,98`, `.sbx-settings-pane`
  (`dialogs/SbxSettingsDialog.tsx:370`).
- **The whole tab area:** `TerminalsPane` (see 4).

**Proposal:** *pane* only for split-view panes; *section* for SEARCH; *lane* for lanes; neutral
names for the layout-storage hooks and size floors (e.g. `useStoredSize`, `MIN_AREA_WIDTH`).

### 4. The tab area has six names — and it isn't only terminals

AGENTS.md calls it "the tab area".

- `TerminalsPane` (component; it isn't a pane), "the terminals pane" (`App.tsx:199`), "the
  terminals" (`App.tsx:362`, `styles.css:1297`, `ui/Sash.tsx:11`).
- "split view" (×6; `tabs/pane-layout.ts:6` "terminal split view"), `.pane-layout`, `.panes-grid`.
- Terminal-named things that also hold editor tabs: `.terminal-pane` (a single pane — clashes
  with `TerminalsPane`, `styles.css:941`), `.terminal-stack` (`tabs/Pane.tsx:537`; the editor
  tab's slot sits inside it), `TAB_DRAG_TYPE = "application/x-tet-terminal-tab"`
  (`tabs/pane-layout.ts:29`).

**Proposal:** **tab area** for the whole, **pane** for one of its up to four parts; drop
"terminal" from names that hold editor tabs too.

### 5. Tab vs session vs terminal

AGENTS.md: a **tab** is the UI unit; a **session** is the agent's own conversation record.

- "Session" where a tab is meant: the "+" button titled "New session" (`tabs/Pane.tsx:529`) —
  its menu includes Shell, which has no session (VS Code: "New Terminal"); `new-session-menu`
  (`Pane.tsx:563`, `styles.css:1199`); the empty pane says "No sessions open." (`Pane.tsx:559`)
  though editor and shell tabs count too; project row buttons "Open the session waiting… / that is
  working / that finished" (`lanes/projects/ProjectList.tsx:305-310`); shortcut "Jump to the
  session that needs you" (`shortcuts.ts:41`); `SessionMark` / `use-session-marks.ts` for marks on
  tabs.
- Main: the variable `sessions` holds the tab registry (`SessionManagerRegistry`; `main.ts:200`,
  `ipc/deps.ts:30`, `projects.ts:31`), so `ipc/terminals.ts:43` reads
  `sessions.get(ref)?.handOff(tabId, …)` — a tab operation; `createIsSessionReady` /
  `isSessionReady` (`agents/agent.ts:158`, `terminals/session-manager.ts:799`) mean "the CLI is
  ready" (its own doc says "CLI ready", `agents/session-ready.ts:1`); `TerminalDescriptor`
  describes a tab; `control/control-verbs.ts:65` "has no terminals".
- A new shell tab has three names: "Open in terminal" (`ProjectList.tsx:266`), "New shell tab"
  (`shortcuts.ts:48`), "+" menu › Shell.
- Prose: "Ends every terminal in every project" (`src/shared/control.ts:380`,
  `SettingsDialog.tsx:239`), "Its terminals keep running" (`git/worktree-questions.ts:51`);
  AGENTS.md mixes "terminals" and "tabs" the same way.
- **Factually wrong:** `tabs-close` says "Close a tab and **end** its session"
  (`src/shared/control.ts:515`); the UI says "Close tab and **delete** its session"
  (`Pane.tsx:512`), which is what happens (`session-manager.ts:136`). An agent reading the help is
  misled.
- Correct as is: "Rename session" (`Pane.tsx:258`) and hand-over really act on the session — but
  `tet-ctl tabs-rename` says "Rename a tab".

**Proposal:** **tab** for the UI unit (as the `tabs-*` verbs already do), **session** only for the
agent's record; fix `tabs-close`'s summary now.

### 6. Notice vs desktop notification — and `notify` in both meanings

AGENTS.md: a **notice** is the in-window message (`notify()` in `ui/Notices.tsx:32`, `app:notice`).

- In main, the notice callback has three names: `notice(...)` / `onNotice` (~36, dominant;
  `main.ts:215`, `git/repository.ts:151`, `terminals/session-registry.ts:24`) and `notify` /
  `type Notify` (`update/auto-update.ts:26,62,70,220`, `uncaught.ts:16,28`).
- The `tet-ctl` verb `notify` and `ControlDeps.notify` (`control/control-verb.ts:165`,
  `main.ts:321`, `src/shared/control.ts:566-569`) show a **desktop** notification — `notify` means
  opposite things in the CLI and the code.
- The desktop notification has four names: "toast" (~95 in code: `util/notifications.ts`
  `ToastTarget`, `main.ts:268` `showToastTarget`, session-manager's `toast`), "notification"
  (`showDesktopNotification`, `notifications.ts`, `startNotifications`, settings `notifications.*`,
  `settings-set-notification`), "Desktop notifications" (Settings dialog
  `SettingsDialog.tsx:353`, README), "OS notification" (`settings-set-notification`'s summary,
  `src/shared/control.ts:230`, CHANGELOG); the settings tab says "Notifications".
- `styles.css:2553` calls notices "messages"; `styles.css:2592` mentions "VS Code's toast shadow".

**Proposal:** **notice** for in-window, **desktop notification** for the OS; `notify` only for
notices (rename the verb's handler side, or the verb).

### 7. "Remove repository" vs "remove project"

- UI: "Remove repository" (menu entry and confirm dialog, `ProjectList.tsx:181,187,284`),
  "Add repository" (`ProjectList.tsx:349`, `App.tsx:538`), notice "add the repository again"
  (`src/main/projects.ts:182`).
- `tet-ctl`: `projects-remove` "Remove a project", `projects-add` "Open a folder as a project";
  IPC `projects:open`, `projects:remove`; the lane header says "PROJECTS".
- AGENTS.md: "Removing a project deletes the worktrees…" — exactly what the "Remove repository"
  dialog does, while its wording suggests the worktrees survive.
- "Add repository" follows GitHub Desktop; "Remove repository" misleads.

**Proposal:** "Remove project"; "Add repository" may stay.

### 8. Worktree wording against AGENTS.md

- `WorktreeInfo.main` (shared) and "the main one" (`lanes/git/BranchTree.tsx:128`),
  `linkedWorktrees = …filter(!worktree.main)` (`BranchTree.tsx:100,132`) — AGENTS.md forbids
  "main worktree".
- A worktree TET didn't make: `foreign` (×7: `ProjectList.tsx:96,330,333`, CSS
  `.project-item.foreign`), `NOT_MADE_BY_TET` (×9), "did not make" (×4), "made elsewhere" (×2, the
  AGENTS.md phrase).
- Worktree rows carry the class `.project-item` (`ProjectList.tsx:289,333`) although a worktree is
  not a project.
- `ownWorktree` described as "a linked worktree's id" (`src/main/git/repository.ts:65`) — git's
  admin-dir name, but AGENTS.md says a worktree has no id.

**Proposal:** `WorktreeInfo.repository` (or `isRepository`) instead of `main`; one term for a
worktree TET didn't make ("made elsewhere"); a row class not named after projects.

---

## Medium impact

### 9. "Waiting" has five names

- `waiting` (~43, dominant: `SessionMark kind="waiting"`, `waitingTabIds`, `onShowWaiting`).
- `needsAttention` / `showNeedsAttention` (×8: `shortcuts.ts:17,40`, `App.tsx:343`,
  `tabs/use-session-marks.ts:29,148`).
- `needsYou` (settings key, `store/settings.ts:18`, `main.ts:147`, `SettingsDialog.tsx:100`) —
  its siblings `finished` and `idleReminder` are named after the event.
- Labels: "Action needed" (`SettingsDialog.tsx:100`), "the session that needs you"
  (`shortcuts.ts:41`), "waiting for an answer" (row tooltip, AGENTS.md), "Waiting for input" /
  "Waiting for your answer" (desktop notifications, `terminals/session-manager.ts:1239-1243`),
  "waiting on the user" (`tet-ctl`).

**Proposal:** **waiting** everywhere (`showWaiting`, `notifications.waiting`, "Waiting for an
answer").

### 10. working / busy / idle / progress

- An agent's running turn: `working` (`kind="working"`, `isWorking`, "is working"), but also
  `busy` (`RefMarks.busy`, `showBusy` in `use-session-marks.ts:17,87`, `onShowBusy`, "busy tabs"
  `App.tsx:240`).
- `tet-ctl tabs-wait --busy/--idle` (`src/shared/control.ts:437`): "--idle" means "not working a
  turn", while the hook event `idle` and the setting `idleReminder` use "idle" for something else.
- Showing a progress bar has about seven names: `busy` (prop on `DialogFrame`/`Section`),
  `running` (`useRunning`, aliased in `ui/Dialog.tsx:209,238`, `ui/DialogFrame.tsx:27`),
  `showProgress`, `showSearchProgress` (`FilesLane.tsx:84,142`), `acting`, `branch.startedHere`
  (`GitLane.tsx:70,80,134`), `gitBusy` (`ProjectList.tsx:347`), `checking`.
- Clash: `showProgress` is a boolean in `FilesLane` and a function raising a progress notice in
  `ui/Notices.tsx:48`.

**Proposal:** **working** for a turn, **busy** for a progress bar; `tabs-wait --working/--done`
or similar.

### 11. Section titles vs code names

| Title on screen | Code / comments | AGENTS.md |
|---|---|---|
| PROJECTS | `ProjectList`, "project list" (×10; also means the projects data, `tabs/use-project-layouts.ts:25`) | "projects lane" |
| COMMANDS | `CommandList`, "commands list" (`ui/Sash.tsx:23`), "saved command" (×11) | COMMANDS, saved commands |
| BRANCHES (`GitLane.tsx:79`) | `BranchTree`, "branch tree" (×7), `.branch-tree`, key `branch-tree.sections` | "the branch tree" |
| LOCAL CHANGES (`GitLane.tsx:132`) | `ChangesList`, "changes list" (×5) | "the changes" |
| SEARCH | `FileSearch`, `use-file-search`, "search view" (`FileSearch.tsx:55`) | "SEARCH pane" |
| EXPLORER | `Explorer`, "Explorer tree" | Explorer |

**Proposal:** decide per row whether the title or the code name wins (e.g. BRANCHES ↔ branch
tree is fine if stated once).

### 12. SBX vs sbx, and the SBX settings' many names

- The dialog: "SBX Settings" (title, dominant; `sbx/sbx-settings.ts:58,76`,
  `control/control-sbx-verbs.ts:22,39,92`), "SBX dialog" / "sbx dialog" (AGENTS.md,
  `sbx/sbx-local.ts:55`, `sbx/sbx-cli.ts:121`, `ipc/projects.ts:65`), "sbx settings"
  (`requirements.ts:82`, `store/tet-json.ts:478`), "SBX configuration"
  (`dialogs/SbxSettingsDialog.tsx:201`), "sbx values" (AGENTS.md; `projects.ts:223`,
  `sbx/sbx.ts:325`, `terminals/tab-place.ts:209`); in code `SbxProjectConfig` (~31),
  `readSbxConfig`, `saveSbxConfig`, IPC `sbx:get-config` whose verb twin is `sbx-get`; log "could
  not apply the sbx config change" (`main.ts:192`).
- The switch: `sbx.enabled` / `sbx-set-enabled`, "the sbx switch" (`main.ts:187`,
  `session-manager.ts:404`), "sandboxing is off/on" (`control-sbx-verbs.ts:76`,
  `sbx/sbx-save.ts:203`, `tab-place.ts:281`), "SBX was enabled" (`session-manager.ts:726`);
  `control-sbx-verbs.ts:76` mixes two in one message.
- Sign-in: `signedIn` / `signIn` (~44, dominant, user text "SBX is not signed in to Docker") vs
  `loggedIn` (×7, `SbxStatus.loggedIn`: `sbx/sbx-status.ts:208,235`, `sbx/sbx-policy.ts:49`,
  `ipc/sbx.ts:25`), `runSbxLogin` / `runSbxLogout`, IPC `sbx:login` / `sbx:logout` next to
  `sbx:sign-in` (`ipc/sbx.ts:30-37`); `control-sbx-verbs.ts:122-126` reads
  `const loggedIn = await deps.sbx.signedIn(); … signedIn: loggedIn`. (`sbx login` the CLI command
  is legitimately "login".)
- Casing in messages: "SBX" ×31 in UI and main errors, but lowercase "sbx could not create…"
  (`sbx/sbx.ts:123,460`), "sbx login failed" (`control-sbx-verbs.ts:141`), "At least one agent or
  sbx" (`dialogs/RequirementsDialog.tsx:41`), "Refused by sbx" (`src/shared/sbx-rules.ts:92`).
- The sandbox called "container": "its container" (`requirements.ts:53`), "a container's [clock]"
  (`terminals/turn-order.ts:7`). ("container path" / `toContainerPath` are sbx's own vocabulary —
  fine.)

**Proposal:** **SBX** for the feature and its dialog ("SBX Settings"), **sbx** for the CLI;
**sign in / sign out** for TET's side; **sandbox** for the sandbox.

### 13. TET vs tet in user-facing text

- Same dialog, both: "applies after **tet** is restarted" (`SettingsDialog.tsx:319`) next to
  "Restart **TET**" (`:237`).
- Lowercase in user-facing messages: "tet's hooks", "tet's project data"
  (`sbx/sbx-status.ts:124,143`), "tet needs 0.45 or later" (`sbx-status.ts:223`), "tet's own
  folder" (`sbx/sbx.ts:460`), "before tet can sandbox" (`SbxSettingsDialog.tsx`), the `[tet]`
  prefix printed into terminals (`terminals/terminal-session.ts:96,106`).
- ~97 user-facing strings say "TET"; CHANGELOG prose tet ×21 / TET ×10; AGENTS.md tet ×12 /
  TET ×27; README only TET. (The install scripts' `tet:` prefix is the command name — fine.)

**Proposal:** **TET** in prose and user-facing text; `tet` only for the command.

### 14. The data folder: `dataRoot` vs `storageRoot`

- `dataRoot` (~103) and "data folder" in prose — dominant, matches `data-root.ts` and AGENTS.md.
- `storageRoot` (~14) for the same value: `sbx/sbx-status.ts:18-21` (`storageRoot = dataRoot`),
  `terminals/tab-place.ts:102,121,230`, `terminals/session-registry.ts:19,24`,
  `terminals/session-manager.ts:175,314,502`.
- pi's extension calls its agent folder `storageDir` (`agents/pi/extension.ts:12`); elsewhere
  `agentDir`.

**Proposal:** `dataRoot` and `agentDir` only.

### 15. "key" means two things

- A worktree's folder key (AGENTS.md): `worktree.key` (×10).
- The `projectRefKey` string for the repository or a worktree: `resolved.key` (×41), `activeKey`
  (×42), comments "a repository's or worktree's key" (`App.tsx:177`, `pane-layout.ts:675`,
  `terminal-views.ts:589`, `use-project-layouts.ts:24`).
- Error messages show the raw `projectRefKey` (`ipc/terminals.ts:23` "Not open: …",
  `control/control-verbs.ts:65,400`, `control/control-verb.ts:274`) — AGENTS.md: a key only where
  unavoidable; the display name (`ResolvedRef.name()`) is dominant elsewhere.
- "Not found" errors in four wordings: "Project not found" (`projects.ts:231,277`,
  `store/resolved-ref.ts:21`), "unknown project: …" (`control-verb.ts:261`,
  `control-verbs.ts:55`), "Repository not open" (`MISSING_REPOSITORY`, `ipc/deps.ts:45`), "… is
  not open".
- `projectPath` in `sbx/sbx.ts:104-121` holds the repository's or worktree's folder; `ipc/sbx.ts:20`
  says "the project's folder".

**Proposal:** `refKey` (or similar) for the `projectRefKey` string, `key` for the worktree's;
names, not keys, in messages; one "not open" wording.

### 16. "in front" vs active vs selected

- Comments: "in front" (~30).
- Identifiers: `activeKey`, `activeRef`, `activeResolved`, `active-project.ts`, `rememberActive`,
  `activeAtStart`; `onSelect` / `setActiveKey` ("as a row or the git lane selects it",
  `App.tsx:177`); `resolved: shown` in `BranchTree.tsx`; `activeProject` in `SettingsDialog.tsx`.

**Proposal:** pick one of "active" / "in front" for both.

### 17. A hook's report: "signal" vs "report"

- `TabState.signalAt` ("the latest applied turn signal", `terminals/tab-state.ts:30`),
  `lastSignalAt`, `SIGNAL_STALE_MS` (`terminals/turn-order.ts:10-15`).
- `reportedAt` (`session-manager.ts:1105-1131`), `sessionReportAt` (`tab-state.ts:12`),
  `reportApplies(...)`.
- `signalAt` also means an AbortSignal's argument index in `util/utility-client.ts:73`,
  `util/utility-host.ts:15`.

**Proposal:** **report** (dominant, ~120).

### 18. IPC channels vs `tet-ctl` verbs, and verb naming

- Same thing, different names: `terminals:*` ↔ `tabs-*`, `environment:*` ↔ `env-*`,
  `repository:state` ↔ `repo-state` (the one "repo" users see), `app:restart` ↔ `restart-app`,
  `sbx:get-config` ↔ `sbx-get`.
- Verb order: `list-themes`, `list-agents`, `list-keybinding-presets` vs `projects-list`,
  `tabs-list`, `editor-list`, `explorer-list`, `notices-list`, `env-list`.
- Singular vs plural: `worktree-*`, `editor-*` vs `projects-*`, `tabs-*`, `notices-*`.
- Create vs add: `tabs-create` and the UI's "Create worktree" / "New worktree"
  (`git/worktree-questions.ts:34-36`) vs `worktree-add`, `projects-add`, IPC
  `projects:add-worktree`; AGENTS.md "worktrees (add, rename, delete)".
- Usage lines show only `[--project <id>]`; `--worktree` appears only in the help's limits text as
  `--worktree <branch>` (`src/shared/control-side.ts:33`) although it also takes a key.
- Summaries say "for a project" where the verb acts on the repository or a worktree: `repo-state`
  ("What the git lane shows for a project"), `editor-open` ("the project's preview tab"),
  `explorer-list`.

**Proposal:** noun-first verbs throughout (`themes-list`, `agents-list`, …), one plural rule, one
of add/create; "the repository or a worktree" in summaries.

### 19. Agent names

- `displayName` "Claude" (`agents/claude/index.ts:32`) → menu "Hand over to Claude"; Settings and
  `tet-ctl` say "Claude Code only" (`SettingsDialog.tsx:103`, `src/shared/control.ts:230`);
  AGENTS.md and README "Claude Code"; a theme is also named "Claude".
- "Pi" (`displayName`, README) vs "pi" (AGENTS.md, CHANGELOG ×9).
- "Codex CLI" (README ×2) vs "Codex".

**Proposal:** each product's own name, once: "Claude Code", "Codex", "pi" or "Pi".

### 20. Saved command: `ProjectCommand` vs `SavedCommand`

- "saved command" in prose and `isSavedCommandTab` (`terminals/tab-state.ts:136`), matching
  AGENTS.md.
- The tet.json entry type `ProjectCommand` (shared) vs the launch form `SavedCommand`
  (`terminals/tab-place.ts:175`); also `createCommandTab`, `CommandPlace`, IPC `commands:list`.

**Proposal:** `SavedCommand` for both, or say the distinction in a comment.

---

## Low impact

### 21. "mark" for file icons

`FileMark`, `FileMarkIcon`, `FileMarkColor`, `.file-mark` (`lanes/files/file-mark.tsx`,
`styles.css:761-781`), "the Explorer's marks" (`styles.css:733`) — all from `file-icons.ts`;
AGENTS.md says "Seti's file icons", VS Code "file icon theme". Clashes with AGENTS.md's marks
(`RowMark` "the one mark", session marks). `.icon-mark` is used for plain status icons too
(`dialogs/SbxAccounts.tsx:133`, `ProjectList.tsx:318`).
**Proposal:** **file icon**.

### 22. Expand/collapse vs fold/open

Identifiers and UI: `expanded`, `collapsed`, `useCollapsedSections`, "Collapse All" / "Expand
All". Comments: "fold", "folds persist", `FoldAllButton`, `isOpen`, "A folder's fold state"
(`ui/tree.ts:121`). "fold" also means compacting folders (`ui/tree.ts:91-96`, `compactTree`). The
diff option's comments say "folded" (`editor-views.ts:326`), its button "Collapse Unchanged
Regions".
**Proposal:** **collapse/expand**.

### 23. Twistie vs chevron vs arrow

`Twistie` / `TWISTIE_WIDTH` (`ui/tree-row.tsx`), `ChevronIcon` and "chevron" in
`BranchTree.tsx:71,524`, `.select-arrow` (`ui/Dropdown.tsx:66`), `.context-menu-chevron`
commented "A submenu's arrow" (`styles.css:1188`).
**Proposal:** **chevron** (or VS Code's "twistie" for trees only).

### 24. "section" means three things

A lane's `Section` / `.section-header` (AGENTS.md); BranchTree's groups `TreeSection`,
`.tree-section`, `useCollapsedSections("branch-tree.sections")` (`BranchTree.tsx:51-90`);
`RowSection` in dialogs.
**Proposal:** "group" for the branch tree's groups.

### 25. Diff wording

"Open diff" (`lanes/git/ChangesList.tsx:293`) vs the editor toggle "Show/Hide Changes"
(`editor/EditorHost.tsx:138`); `showDiff`, `CompareIcon`; the image diff's "comparison layout"
(`styles.css:1575`). VS Code: "Open Changes".
**Proposal:** one label for the action.

### 26. "preview" means three things

VS Code's preview tab (`snapshot.preview`, `useEditorPreview`, `previewEditorTab`, "Keep Open");
the Markdown preview (`previewShown`, `previewByDefault`, `PreviewView`, `renderPreview`, only
some names qualified `markdownPreview`, `showMarkdownPreview`; labels "Show/Hide Preview",
"Toggle Preview" `editor-views.ts:953`, "Open Preview" `file-menu.ts:23`); the split view's drop
preview (`snapPreview`, "the preview" in `pane-layout.ts:371,440,525`, `TerminalsPane.tsx:329`).
**Proposal:** "Markdown preview" and "snap preview" spelled out; one label for the Markdown
toggle.

### 27. Sash vs divider

`Sash` / `.sash` ("The draggable divider between two panes", `ui/Sash.tsx:29`) for lanes and
sections; the split view calls the same lines dividers (`useDividerFraction`, `DividerShares`,
`colDivider`, storage key `divider.*` in `TerminalsPane.tsx:18-24,130-156,304-350`,
`pane-layout.ts:431-441`). VS Code: sash.
**Proposal:** **sash**.

### 28. Row vs item

Comments say "row" (project row ×11, tree row, match row); CSS says `-item` (`.project-item`,
`.tree-item` rendered by `TreeRow`, `.command-item`, `.account-item`, `.repository-item`).
**Proposal:** **row**.

### 29. Hand over vs hand off

UI "Hand over to X" (`tabs/Pane.tsx:360`), notice "Could not hand the session over"; settings
"Session handoff" (`SettingsDialog.tsx:95`); code `terminals:handoff`, `handOff`, `handOffAgents`;
`tabs-handoff` "takes over". Mostly the natural noun/verb pair; the mismatch is "hand off" in code
vs "hand over" in the UI.
**Proposal:** "hand over" / "handover".

### 30. Smaller items

- "dirty": unsaved edits in an editor tab ("Unsaved changes") and a working tree with changes on a
  project row (`ProjectList.tsx:37,53`, `App.tsx:285`; UI "Uncommitted changes",
  `ProjectList.tsx:312`).
- "title bar": the window's `.titlebar` and `DialogFrame`'s header (`ui/DialogFrame.tsx:97`,
  `styles.css:1783`).
- "prompt" has four meanings: `prompt()` (a question with a field; "the commit prompt"), the
  agents' prompt texts (Prompts tab, `PromptId`), an agent's "permission prompt"
  (`SettingsDialog.tsx:100`), the shell prompt (`terminal-views.ts:554`).
- "Environment (optional)" in the saved-command dialog (`CommandList.tsx:81`) holds per-command
  variables — the same word as the Environment tab and `env-*`.
- "Could not" (~56) vs "Couldn't" (2: `lanes/use-lanes.ts`, `src/shared/sbx-rules.ts:119`).
- `AgentRuntime.sbxOnly` (agent missing on this machine, runs only in sbx) vs `TabState.sandboxOnly`
  (tab opened from a sandbox) — different meanings, near-identical names; likewise
  `SandboxSessionMount` (relative to the agent folder) vs `SbxSessionMount` (absolute host path).
- "this machine" (~69) vs "the host" (~54) in comments; user text consistently says "this
  machine"; "host" is also network hosts and provider hosts.
- "drop" also means delete: `dropRefData`, `dropWorktreeData` (`projects.ts:212,256`) beside drops
  as pasted content.
- "workspace" is TET's own (`openWorkspace`, `main.ts:243`) and sbx's (the repository's or
  worktree's folder, `sbx/sbx.ts:83`).
- "verb" for IPC handlers (`ipc/deps.ts:44`).
- Token wording: "Personal access token" (Add Repository), "Access tokens" / "Token" (SBX
  accounts), "Password or token" (git login) — different credentials, possibly fine.
- Sign-in wording in the git login: "Sign in", "Authentication failed", "wants a login"
  (`git/GitLogin.tsx:81-84`).
- Leftover lane vocabulary in live docs: README "git pane" (lines 84, 104), "search pane" (85),
  "sidebar" (105); CHANGELOG 0.16.5 (lines 8-9) "Side views… side columns… pinned column". Older
  CHANGELOG sections are published release notes (AGENTS.md: the GitHub Release is the text).

---

## Not findings — consistent or deliberately different

- Pane ids `a`–`d` vs their labels "Left", "Top Right" (`PANE_LABELS`): ids vs user-facing labels,
  intended.
- snap zone, free lane / pinned, strip / tab strip, menu "entry": consistent.
- "repo" in `AddRepositoryDialog` / `providers:repos`: hosted remote repositories from a provider's
  API.
- folder vs dir: "folder" in user text (~90-111); "dir" only in local variables.
- "LOCAL CHANGES" (header) vs "changes list" (prose).
- secret vs variable in sbx: sbx's own distinction.
- handoff / take over (noun and verb), control channel / control server (the whole vs its HTTP
  part), relaunch (Electron's API) / restart, agent vs "the CLI", provider (no "forge"): consistent.
- `sbx login` (the CLI subcommand) and "container path" / `toContainerPath`: sbx's own vocabulary.
- "settings" (no "preferences" anywhere), saved command / COMMANDS, `notices-list`: consistent.

## Next step

Decide a term per item; then unify item by item as with lanes — folders, then comments and
user-facing text, then code, validating after each step.
