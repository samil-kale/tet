# Changelog

Newest release first. Each release's section is what its GitHub Release shows as notes: what
changed for the user, not the commit list.

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
