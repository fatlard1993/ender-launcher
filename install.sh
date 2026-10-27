#!/bin/sh
# Install ender, or bring it up to date: one binary that needs nothing else installed.
#
#   curl -fsSL https://raw.githubusercontent.com/fatlard1993/ender-launcher/main/install.sh | sh
#
# ENDER_INSTALL names the directory it goes in (~/.local/bin by default), ENDER_VERSION a release (the newest by
# default), and ENDER_RELEASES where a release's files are downloaded from instead of GitHub, such as a mirror.
set -eu

repo='fatlard1993/ender-launcher'
directory="${ENDER_INSTALL:-$HOME/.local/bin}"

fail() {
	echo "ender: $1" >&2
	exit 1
}

case "$(uname -s)" in
	Linux) system=linux ;;
	Darwin) system=darwin ;;
	*) fail "no build for $(uname -s); on Windows, run install.ps1 in PowerShell" ;;
esac

case "$(uname -m)" in
	x86_64 | amd64) chip=x64 ;;
	arm64 | aarch64) chip=arm64 ;;
	*) fail "no build for a $(uname -m) processor" ;;
esac

if [ -n "${ENDER_RELEASES:-}" ]; then
	base="$ENDER_RELEASES"
elif [ -n "${ENDER_VERSION:-}" ]; then
	base="https://github.com/$repo/releases/download/v${ENDER_VERSION#v}"
else
	base="https://github.com/$repo/releases/latest/download"
fi

if command -v curl > /dev/null; then
	fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget > /dev/null; then
	fetch() { wget -q "$1" -O "$2"; }
else
	fail 'needs curl or wget to download with'
fi

binary="ender-$system-$chip"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT

echo "Downloading $binary"
fetch "$base/$binary" "$staging/$binary" || fail "$base/$binary did not download"
fetch "$base/SHA256SUMS" "$staging/SHA256SUMS" || fail "$base/SHA256SUMS did not download"

expected="$(grep " $binary\$" "$staging/SHA256SUMS" | cut -d' ' -f1)"

if command -v sha256sum > /dev/null; then
	actual="$(sha256sum "$staging/$binary" | cut -d' ' -f1)"
else
	actual="$(shasum -a 256 "$staging/$binary" | cut -d' ' -f1)"
fi

[ -n "$expected" ] && [ "$expected" = "$actual" ] || fail "$binary is not the file the release lists; nothing was installed"

mkdir -p "$directory"
chmod +x "$staging/$binary"
# macOS refuses to run a downloaded binary nobody signed until its quarantine is lifted
[ "$system" = darwin ] && xattr -d com.apple.quarantine "$staging/$binary" 2> /dev/null || true
mv "$staging/$binary" "$directory/ender"

echo "Installed $("$directory/ender" --version) at $directory/ender"

case ":$PATH:" in
	*":$directory:"*) echo 'Start with: ender new' ;;
	*) echo "$directory is not on your PATH; add it in your shell's profile, or run $directory/ender" ;;
esac
