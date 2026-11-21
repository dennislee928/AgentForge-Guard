#!/bin/sh
# Install the AgentForge Guard CLI (`afg`) from a GitHub Release.
#
#   curl -fsSL https://github.com/dennislee928/AgentForge-Guard/releases/latest/download/install.sh | sh
#
# Environment:
#   AFG_VERSION        release to install, e.g. 1.0.0-rc.1 (default: the latest stable release)
#   AFG_INSTALL_DIR    where to put `afg` (default: $HOME/.local/bin)
#   AFG_REQUIRE_COSIGN 1 = refuse to install unless the Sigstore signature verifies
#
# The archive is always checked against the release's SHA256SUMS; when `cosign`
# is installed, the archive's Sigstore bundle is verified too. Any mismatch aborts
# before anything is installed.
set -eu

REPO="dennislee928/AgentForge-Guard"
BASE_URL="${AFG_BASE_URL:-https://github.com/$REPO/releases/download}"
INSTALL_DIR="${AFG_INSTALL_DIR:-$HOME/.local/bin}"

say() { printf 'afg-install: %s\n' "$*" >&2; }
die() { say "error: $*"; exit 1; }

fetch() { # url dest
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto '=https,file' --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    die "curl or wget is required"
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else die "sha256sum or shasum is required"
  fi
}

target() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Darwin) os=apple-darwin ;;
    Linux)
      if (ldd --version 2>&1 || true) | grep -qi musl; then
        die "musl Linux is not supported by the prebuilt binaries; use: cargo install agentforge-guard"
      fi
      os=unknown-linux-gnu ;;
    *) die "unsupported OS $os; on Windows download the .zip from https://github.com/$REPO/releases or use npm" ;;
  esac
  case "$arch" in
    x86_64 | amd64) arch=x86_64 ;;
    arm64 | aarch64) arch=aarch64 ;;
    *) die "unsupported CPU $arch" ;;
  esac
  printf '%s-%s' "$arch" "$os"
}

latest() {
  [ -z "${AFG_BASE_URL:-}" ] || die "set AFG_VERSION when AFG_BASE_URL is overridden"
  # releases/latest redirects to releases/tag/v<version>.
  if command -v curl >/dev/null 2>&1; then
    url=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest") \
      || die "could not resolve the latest release; set AFG_VERSION"
  elif command -v wget >/dev/null 2>&1; then
    url=$(wget -S --spider -q "https://github.com/$REPO/releases/latest" 2>&1 \
      | sed -n 's/^ *[Ll]ocation: *//p' | tail -n 1 | tr -d '\r')
    [ -n "$url" ] || die "could not resolve the latest release; set AFG_VERSION"
  else
    die "curl or wget is required"
  fi
  v=${url##*/tag/v}
  [ "$v" != "$url" ] || die "no stable release found; set AFG_VERSION (e.g. 1.0.0-rc.1)"
  printf '%s' "$v"
}

main() {
  version="${AFG_VERSION:-$(latest)}"
  version=${version#v}
  case "$version" in
    *[!0-9A-Za-z.-]* | "") die "invalid version '$version'" ;;
  esac
  t=$(target)
  name="afg-v$version-$t"
  archive="$name.tar.gz"
  url="$BASE_URL/v$version"

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT INT TERM

  say "downloading $archive"
  fetch "$url/$archive" "$tmp/$archive" || die "download failed: $url/$archive"
  fetch "$url/SHA256SUMS" "$tmp/SHA256SUMS" || die "download failed: $url/SHA256SUMS"

  want=$(awk -v f="$archive" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS")
  [ -n "$want" ] || die "$archive is not listed in SHA256SUMS"
  got=$(sha256 "$tmp/$archive")
  [ "$want" = "$got" ] || die "checksum mismatch for $archive (expected $want, got $got)"
  say "checksum ok"

  if command -v cosign >/dev/null 2>&1; then
    fetch "$url/$archive.sigstore.json" "$tmp/$archive.sigstore.json" || die "download failed: $archive.sigstore.json"
    cosign verify-blob --bundle "$tmp/$archive.sigstore.json" \
      --certificate-identity-regexp "^https://github.com/$REPO/\.github/workflows/release\.yml@refs/tags/v" \
      --certificate-oidc-issuer https://token.actions.githubusercontent.com \
      "$tmp/$archive" >/dev/null 2>&1 || die "Sigstore signature verification failed for $archive"
    say "signature ok"
  elif [ "${AFG_REQUIRE_COSIGN:-0}" = 1 ]; then
    die "AFG_REQUIRE_COSIGN=1 but cosign is not installed"
  else
    say "cosign not found; skipped signature verification (checksum verified)"
  fi

  tar xzf "$tmp/$archive" -C "$tmp"
  [ -f "$tmp/$name/afg" ] || die "$archive does not contain afg"
  mkdir -p "$INSTALL_DIR"
  cp "$tmp/$name/afg" "$tmp/afg.new"
  chmod 755 "$tmp/afg.new"
  mv -f "$tmp/afg.new" "$INSTALL_DIR/afg"
  say "installed $INSTALL_DIR/afg ($version)"
  case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *) say "add $INSTALL_DIR to your PATH" ;;
  esac
}

main "$@"
