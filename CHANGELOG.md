# Changelog

Newest release first. Each release's section is what its GitHub Release shows as notes: what
changed for the user, not the commit list.

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
