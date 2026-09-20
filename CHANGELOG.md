# Changelog

Newest release first. Each release's section is what its GitHub Release shows as notes: what
changed for the user, not the commit list.

## 0.10.0 (2026-09-20)

- Search for repository was added. It now finds matches inside files. Results are
  grouped per file.
- **Markdown preview.** A `.md` file opens rendered beside the editor.
- **The editor tab toggles between the diff and the plain file.** A changed file's tab switches
  between monaco's inline diff and the file as it stands.
- **Fixes.** Writing to a terminal whose process has already exited no longer reports an error;
  settings save only what actually changed; a Markdown preview's image follows redirects only
  while they stay on https; and the git pane opens fewer git and sbx processes on refresh.

## 0.9.2 (2026-09-19)

- **Dracula theme.** Dracula joins the dark themes, in the window, the terminals and the editor.
- **Checkboxes and radio buttons in the theme's colors.** They are drawn like VS Code's instead
  of the system's, and the color scheme is picked with VS Code's radio buttons.
- **The commit dialog no longer keeps a message history.** The list of recent and pinned commit
  messages under the message field is gone.

## 0.9.1 (2026-09-18)

- **Worktrees say when git is too old.** Creating and renaming a worktree needs git 2.48 or
  newer; with an older git, both menu entries say so instead of failing halfway.
- **Sandboxed agents open only files of their repository.** A file an agent in the sandbox asks
  the editor to open is refused when it is missing or leads, through a link, outside the
  repository.

## 0.9.0 (2026-09-18)

- **Worktrees.** A worktree is added from the branch tree at the default branch, together with
  its own branch, and opens as a project of its own, indented under its repository in the
  sidebar. It is renamed and deleted together with its branch and remembers the branch it came
  from, shown in its project row.
- **Secrets for sandboxed agents.** The sandbox settings take secrets — a name, the hosts it is
  for and its value — which sbx's proxy injects into requests to those hosts, so the agent never
  sees the value. Values are kept encrypted on this machine, never in `tet.json`, shown masked
  once stored, and a rebuilt sandbox gets them back.
- **The sandbox settings say what the policy refuses.** Paths and secret hosts that sbx's policy
  (or your organization's) would not allow are marked in red, on the row and on its tab; tabs that
  can't be used are disabled with the reason instead of hidden.
- **Colored saved commands.** A saved command can be given a color from the terminal's bright
  palette.

## 0.8.11 (2026-09-17)

- **Sandbox ports are actually published.** Ports from the sandbox settings are compared against
  what the sandbox itself has published, so one that sbx refused earlier, or that was configured
  before the sandbox existed, is tried again at the next Save — and a newly created sandbox gets
  its ports right away.
- **Windows runs the program that comes first on PATH.** A command is resolved the way cmd.exe
  resolves it, folder by folder, so a `.cmd` shim placed in front of a program wins over an `.exe`
  further down PATH.
- **`tet-ctl help` reads better.** Its verbs are grouped by the question they answer, and a tab
  running in a sandbox is listed only what it may actually run there.

## 0.8.10 (2026-09-17)

- **Batch files run again on Windows.** Saved commands that start a `.cmd` file reading its own
  arguments, such as Maven's `mvn`, no longer fail with exit code 255.

## 0.8.9 (2026-09-17)

- **Several editor tabs.** Files open in a preview tab that the next file replaces; an edit,
  "Keep Open" or a double-click in the Explorer keeps it, and the next file gets a tab of
  its own.
- **The git pane works like GitHub Desktop.** Fetch and pull move local branches that are only
  behind their upstream, pull no longer refuses a diverged branch, push goes to the branch's own
  upstream, and deleting the checked-out branch switches to the default branch first. Remote
  branches can be deleted from their row, rebasing commits already pushed asks first, and stash
  actions hit the right stash even after one was made in a terminal.
- **Agents know about `tet-ctl`.** Every agent learns of `tet-ctl` through its system prompt, and
  `tabs-output` reads what any tab of the same project printed, agent or shell.
- **Sandboxes stay in their project.** `tet-ctl` from a sandboxed tab sees only its own project
  and cannot open tabs that would run on the host.
- **Clearer SBX settings.** The dialog names the organization governing the SBX policy, marks
  allowed paths the policy would refuse, and reports a failing sbx daemon instead of asking you to
  sign in.
- **Fixes.** AltGr combinations no longer trigger tab shortcuts, saving Settings no longer
  overwrites a setting `tet-ctl` changed meanwhile, a tab opened while its agent was missing starts
  once the agent is installed, and clones with a provider account work where the temp folder is
  `noexec`.

## 0.8.8 (2026-09-16)

- **Sandboxed tabs open faster.** The checks a sandboxed tab makes before it starts now run at
  the same time instead of one after another, and the sandbox is woken while they run, so an
  agent tab in a project with `sbx` reaches its prompt noticeably sooner.
- **Hooks survive a rebuilt sandbox.** After a sandbox was rebuilt, or removed outside tet with
  `sbx rm`, `prune` or `reset`, the next agent started in it ran without tet's hooks, so its tab
  showed no turn marks. The sandbox is set up again from scratch.

## 0.8.7 (2026-09-16)

- **Sandboxed projects start quicker.** A sandbox's bind mounts are applied several at a time
  instead of one after another, so opening a project with `sbx` takes noticeably less time.

## 0.8.6 (2026-09-16)

- **`tet.json` edits keep your formatting.** Adding folders, excludes, commands or sandbox
  settings changes only the affected keys; comments, trailing commas and layout stay as written.
- **Arguments reach Windows shims literally.** Agents and commands started through a `.cmd` shim
  receive arguments containing `&`, `>`, `%` or quotes unchanged, and stopping one ends the
  program behind the shim as well.
- **Safer file writes.** Settings, generated agent configuration and shell transcripts are written
  atomically, so a crash or a concurrent reader never sees a half-written file.

## 0.8.5 (2026-09-15)

- **Trees laid out as in VS Code.** The Explorer and the git pane's branch tree share VS Code's
  row geometry: chevrons, file labels, file marks and section headers line up and are sized alike.
- **Buttons with the theme's border.** Buttons draw the border each VS Code theme defines, and
  the tab strip's action separators use the panel border.
- **Quieter icons.** Icons in the side pane are dimmed a little further.

## 0.8.4 (2026-09-15)

- **IntelliJ themes.** Dark IntelliJ and Light IntelliJ join the list, with IntelliJ's syntax
  colors in the editor.
- **Light Modern as in VS Code.** The light theme is back to VS Code's blue accent and terminal
  colors.
- **Theme changes reach running projects.** Agents of projects already open pick up a newly
  chosen theme for the tabs they start next.
- **`tet-ctl` fixes.** `editor-state` returns the editor's current text, and `tabs-start`,
  `tabs-restart` and `tabs-wait --status` report an error instead of silently doing nothing.

## 0.8.3 (2026-09-15)

- **Explorer file icons as in VS Code.** Files show the icons of VS Code's Seti theme, picked by
  the same file names and extensions VS Code uses.

## 0.8.2 (2026-09-15)

- **Light and dark themes are chosen apart.** Settings picks a color scheme and one theme for
  each kind; switching to a theme of the kind already on screen applies at once, without a
  restart.
- **New themes.** Dark GitHub and Light GitHub join the list, and Dark Slate gets its own syntax
  colors.
- **Colored file marks in the Explorer**, after the Seti icon colors VS Code uses.
- **The editor follows the disk.** A file open in the editor tab reloads when something else
  writes it, and no longer shows a stale version after a pull or reset.
- **The Explorer re-lists itself** when a file or folder appears or goes, ignored ones included.
- **More for agents in `tet-ctl`.** New verbs drive and inspect tabs, the editor, the Explorer
  and notices.
- **No more lost work.** Discarding or committing a path with `[`, `*` or `?` in its name no
  longer touches other files, renaming a compacted Explorer folder puts it in the right place,
  and editing saved commands while switching projects no longer overwrites another project's list.
- **Fixes.** Commit messages can be suggested before the first commit, renames that only change
  case work, AZERTY keyboards reach the tab shortcuts, and sandboxed pi and opencode sessions list
  and rename correctly.

## 0.8.1 (2026-09-14)

- **Notices stay long enough to read.** Info, warning and error notices stand for 10, 12 and 15
  seconds, and wait while the pointer is on them or the window is out of focus.
- **Settings and the add-repository dialog get a close button** in their tab strip.
- **Calmer side pane.** Switching between the git and files views fades in, and the Explorer no
  longer flashes its progress bar for a listing that finishes at once.
- **Long dropdowns scroll** instead of opening over their own field.

## 0.8.0 (2026-09-14)

- **TET keeps its data in `~/.tet`.** Settings, the project list, provider accounts and logs now
  live in one folder on every platform. Nothing is carried over from the old location: add your
  projects and sign in to your providers again after updating.
- **Sandboxed tabs never run on this machine.** When sbx is not ready, a sandboxing project's tab
  stops with an error instead of starting the agent outside the sandbox.
- **The SBX dialog says what the policy is missing.** Instead of a plain wall, it lists the rules a
  sandboxed tab needs that the network policy does not allow yet.
- **Faster terminal drawing.** Terminals render through WebGL, falling back to the previous
  renderer where that is not available.

## 0.7.1 (2026-09-14)

- **Files get their own side pane.** The Explorer has its own toggle beside the git one instead
  of sharing the git pane; the toggle of the view that is open is marked blue.
- **New tabs find their own session.** Agent tabs started at the same time no longer risk picking
  up each other's session, and a tab closed right after its first prompt takes its session with it.
- **A dead connection no longer hangs a fetch.** Git gives up on a connection that stays silent
  for about a minute, and the background fetch is stopped when it takes too long.
- **Sandboxes on Windows find TET's files** even when a folder's letter case on disk differs from
  the path TET asked for.
- **Updates are more robust.** A failed update puts the old version back even while a virus
  scanner holds its files, and leftovers of an earlier update no longer get in the way of the next.
- **The editor's save button** sits at the start of its bar, like the tab strip's actions.

## 0.7.0 (2026-09-14)

- **Installed by a script, no npm needed.** On macOS and Linux run
  `curl -fsSL https://raw.githubusercontent.com/samil-kale/tet/development/scripts/install.sh | sh`,
  on Windows `irm https://raw.githubusercontent.com/samil-kale/tet/development/scripts/install.ps1 | iex`.
- **Files open in an editor tab.** Double-click a changed file or ctrl-click a path in a terminal,
  and it opens in the project's editor tab; the next file reuses it.
- **Split by dragging.** The layout picker is gone: drag a tab onto the right side or the lower left of
  the terminals to split them.
- **The branch tree remembers what you folded.** Only local branches are open at first.

## 0.6.2 (2026-09-13)

- **The first start says what it is waiting for.** Before fetching Electron (over 100 MB, once),
  `tet` now prints what it downloads and where, instead of staying silent until a progress bar
  appears half a minute later.

## 0.6.1 (2026-09-13)

- **No changes for you.** The release itself is what is new: it reaches npm through trusted
  publishing, with no token involved.

## 0.6.0 (2026-09-13)

- **A turn cut short counts as ended.** A Claude Code turn interrupted with Escape no longer
  leaves its tab spinning.
- **Startup notices are no longer lost.** A message from the first seconds of a start now waits
  until the window can show it.

## 0.5.1 (2026-09-13)

- **Installer no longer blocked by Sophos.** Opened from a browser, the Windows installer was
  stopped as "Lockdown" by Sophos' exploit protection. It no longer checks for a running TET,
  so close TET yourself before installing over it.
- **Editing basics in the editor.** Toggle comments, matching brackets are highlighted, and
  brackets and quotes close as you type.

## 0.5.0 (2026-09-12)

- The diff and the editor are one widget now: the file stands there whole, with the changes
  marked in place and its right-hand side editable, so reading a change and making one no longer
  mean two different views. Whitespace-only changes are never counted, the strip beside the
  scrollbar shows where the changes sit and scrolls there on a click, and HEAD's side is read the
  way git would check it out, so it reads like the file rather than like its stored bytes. An
  image still shows both versions side by side or over each other; a deleted, binary or very
  large file opens read-only. The old whitespace toggle and the folded gaps are gone with the
  view they belonged to.
- An open diff keeps its base in step: committing or checking out under it no longer leaves the
  file marked as changed against what HEAD held before.
- The changes list commits what is selected in it, from its context menu — the whole message
  prompt as before, only for the files you picked. Discarding works on the selection too;
  stashing stays all-or-nothing.
- No toast for the tab you are looking at, and the marks follow the same rule: a turn that ends
  in a visible tab of the project in front of you, in a focused window with no dialog over it,
  leaves neither a toast nor a speech bubble. Ends it behind a dialog, in another window or with
  tet minimized, and both stand until you are back.
- A click on a toast brings tet forward and puts the tab it is about in front, whether the toast
  is still on screen or already in the notification center. While tet is not in front, the
  taskbar entry (dock icon on macOS) asks for a look until it is.
- A toast the system refuses to show is no longer silent: the reason goes to `errors.log` in
  TET's data folder, which is where a notification switched off in the OS shows up.
- Closing a tab whose agent session is already gone works instead of failing and putting the tab
  back.

## 0.4.0 (2026-09-10)

- Agent tabs can run inside a Docker sandbox (sbx), opt-in per project from the project row's
  "SBX Settings": Claude Code, Codex, opencode and pi each start in a container that sees the
  repository and nothing else, with the ports, the allowed folders and single files, and the
  skills, plugins and instructions to mount picked in the dialog and stored in the project's
  own `tet.json`. Past sessions of a sandboxed agent are listed, resumed, renamed and deleted
  like any other, `tet-ctl` works from inside, and a project whose agent isn't installed on the
  machine at all can still be worked in through the sandbox. Where sbx isn't ready the tab
  falls back to a plain local run instead of failing, and an organization-managed policy is
  said out loud in the dialog rather than silently ignored.
- Both ends of a turn now travel over tet's control channel instead of files on disk: the
  working, waiting and finished marks are quicker and no longer overtake each other, a question
  asked asynchronously keeps standing until it is really answered, opencode takes its question
  mark back when a permission is answered, and a question that outlives its turn no longer
  leaves a bubble beside it.
- Desktop notifications go through Electron's own notifier.
- The idle reminder registers its hook only when the switch is on, so nothing is run per idle
  prompt while it is off.
- Cloning and the provider accounts ask GitHub and GitLab through Chromium's network stack,
  which is what makes them work behind a system proxy.
- Every agent draws in tet's theme; the per-agent theme switches in Settings are gone.
- The project row's changes icon toggles the git pane when its project is already selected.
- Right-clicking a project opens its menu without selecting it.
- The saved commands' wand is gone, and with it its prompt in Settings.
- opencode sessions are listed from the plugin's own records, so opening the list no longer
  boots an `opencode` process.
- Codex takes Ctrl+C again: an empty composer quits it, a full one is cleared.
- A window whose renderer dies is loaded again instead of staying blank.
- Startup spreads its requirement checks out, so the first frame comes up sooner.

## 0.3.10 (2026-09-06)

- pi (pi.dev) joins Claude Code, opencode and Codex as a fourth agent: a terminal tab of its
  own, past sessions listed, resumed, renamed and deleted from the tab's menu, the working /
  waiting / finished marks on tab and project row, desktop notifications, and tet's theme
  applied for the run when the Appearance tab says so.
- The two questions tet asks an agent in the background (the commit message's, the saved
  commands wand's) are editable in a new Settings → Prompts tab, and through
  `tet-ctl settings-set-prompt`. A question left untouched keeps following tet's own text as it
  improves.

## 0.3.9 (2026-09-06)

- A new "Dark Slate" theme, a blue-grey take on the dark palette, in Settings → Appearance.
- Split view: switching between presets keeps the dividers where they are, only adding or
  removing a sash. The snap preview shown while dragging a tab now lands exactly where the
  dropped pane will.
- The diff dialog's editor no longer draws a shadow along a scrolled edge.

## 0.3.8 (2026-09-05)

- A project row shows a dot next to its name while the repository has uncommitted changes.
- Closing several tabs at once could leave one of their sessions behind, back as a tab on the
  next start. It no longer does.
- A progress notice dismissed early no longer clears the one shown after it.
- Menus, dialogs and notices take their shadow from the theme instead of a fixed black.
- The "Still waiting" notification switch says that it applies to Claude Code only.
- `tet-ctl` reaches the app over a loopback TCP port instead of a named pipe or socket file.
- The event loop log in `userData` is kept across sessions and rotated once it grows past a
  size limit.

## 0.3.7 (2026-09-05)

- Linux installers are back: the release build's test that kept 0.3.6's AppImage and `.deb`
  from being published no longer depends on what the build machine's shell prints at startup.
  Otherwise the same as 0.3.6.
- Release notes come from this changelog.

## 0.3.6 (2026-09-05)

- Split view: drag a tab onto a snap zone at the edge of the terminals to split them into up to
  four panes. A pane whose last tab is moved out or closed collapses away; the three-column
  preset is gone.
- A saved command opens its tab in the pane its last run lay in, restoring that layout where
  the current one has no pane there.
- Image diff: changed images show both versions side by side, with an overlay view that blends
  them onion-skin style.
- The add-repository dialog remembers the parent folder when the picked folder is itself a
  repository.
