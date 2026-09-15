#!/bin/sh
# Installs TET on macOS and Linux, or replaces the one installed:
#
#   curl -fsSL https://raw.githubusercontent.com/samil-kale/tet/development/scripts/install.sh | sh
#
# Fetches the newest release's archive for this machine (electron-builder.yml builds them, named
# as src/shared/release.ts's `assetName`) and unpacks it for this user alone, no root asked:
#   macOS  ~/Applications/TET.app, and `tet` in ~/.local/bin
#   Linux  ~/.local/share/tet, `tet` in ~/.local/bin and a desktop entry
# The app updates itself from then on (src/main/auto-update.ts), in the same places.
#
# Fetched with curl, which marks nothing it saves as quarantined: that is what lets macOS start
# the ad-hoc signed bundle without Gatekeeper asking. TET_RELEASES_URL stands in for GitHub's
# releases in test/install.test.ts.

set -eu

RELEASES="${TET_RELEASES_URL:-https://github.com/samil-kale/tet/releases}"

fail() {
  printf 'tet: %s\n' "$1" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"

case "$(uname -s)" in
  Darwin) os=mac ;;
  Linux) os=linux ;;
  *) fail "$(uname -s) is not supported here; on Windows run install.ps1" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "no build for $(uname -m)" ;;
esac
# A shell running under Rosetta reports x86_64 on an Apple silicon Mac, which wants the arm64 build.
if [ "$os" = mac ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi

# Replacing the files of a running TET takes its sessions down with it.
if [ "$os" = mac ]; then running=TET; else running=tet; fi
if command -v pgrep >/dev/null 2>&1 && pgrep -x "$running" >/dev/null 2>&1; then
  fail "TET is running; quit it first"
fi

# The newest release, off the redirect GitHub answers /latest with.
tag=$(curl -fsSI "$RELEASES/latest" | tr -d '\r' | sed -n 's#^[Ll]ocation: .*/tag/\([^/]*\)$#\1#p' | tail -n 1)
[ -n "$tag" ] || fail "could not find the newest release at $RELEASES"
# A copy of src/shared/release.ts's `assetName`: a change there updates this line too.
asset="TET-$os-$arch.tar.gz"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
printf 'tet: downloading %s (%s)\n' "$asset" "$tag"
curl -fL --progress-bar -o "$tmp/$asset" "$RELEASES/download/$tag/$asset" || fail "could not download $asset"
mkdir "$tmp/unpacked"
tar -xzf "$tmp/$asset" -C "$tmp/unpacked" || fail "could not unpack $asset"

bin_dir="$HOME/.local/bin"
mkdir -p "$bin_dir"

if [ "$os" = mac ]; then
  app=$(find "$tmp/unpacked" -maxdepth 2 -type d -name TET.app | head -n 1)
  [ -n "$app" ] || fail "no TET.app in $asset"
  dest="$HOME/Applications/TET.app"
  mkdir -p "$HOME/Applications"
  rm -rf "$dest"
  mv "$app" "$dest"
  # `open` rather than the binary: the app starts as its own, not as a child of this shell.
  cat >"$bin_dir/tet" <<'EOF'
#!/bin/sh
exec open -a "$HOME/Applications/TET.app" --args "$@"
EOF
else
  binary=$(find "$tmp/unpacked" -maxdepth 2 -type f -name tet | head -n 1)
  [ -n "$binary" ] || fail "no tet executable in $asset"
  dest="$HOME/.local/share/tet"
  mkdir -p "$HOME/.local/share"
  rm -rf "$dest"
  mv "$(dirname "$binary")" "$dest"
  # --no-sandbox: nothing unpacked without root can give electron's chrome-sandbox the setuid root
  # bit it wants, and AppArmor on Ubuntu 24.04+ blocks the unprivileged fallback, so electron would
  # abort at launch. What the renderer then runs without is Chromium's own process sandbox.
  cat >"$bin_dir/tet" <<'EOF'
#!/bin/sh
nohup "$HOME/.local/share/tet/tet" --no-sandbox "$@" >/dev/null 2>&1 &
EOF
  applications="$HOME/.local/share/applications"
  mkdir -p "$applications"
  cat >"$applications/tet.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=TET
Comment=Git workspace for coding agents
Exec="$dest/tet" --no-sandbox %U
Icon=$dest/icon.png
Categories=Development;
Terminal=false
EOF
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$applications" >/dev/null 2>&1 || true
  fi
fi
chmod +x "$bin_dir/tet"

printf 'tet: installed %s into %s\n' "$tag" "$dest"
case ":$PATH:" in
  *":$bin_dir:"*) printf 'tet: start it with `tet`\n' ;;
  *) printf 'tet: start it with `%s/tet`, or add %s to your PATH\n' "$bin_dir" "$bin_dir" ;;
esac
