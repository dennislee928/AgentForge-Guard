#!/bin/sh
# Tests install.sh against a fake local release (file:// URLs). No network.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) t=aarch64-apple-darwin ;;
  Darwin-x86_64) t=x86_64-apple-darwin ;;
  Linux-x86_64) t=x86_64-unknown-linux-gnu ;;
  Linux-aarch64) t=aarch64-unknown-linux-gnu ;;
  *) echo "skip: unsupported host"; exit 0 ;;
esac

v=9.9.9-test.1
rel="$work/release/v$v"
mkdir -p "$rel" "$work/stage/afg-v$v-$t"
printf '#!/bin/sh\necho "fake afg $*"\n' >"$work/stage/afg-v$v-$t/afg"
chmod 755 "$work/stage/afg-v$v-$t/afg"
mkrelease() { # a valid release: archive + SHA256SUMS
  tar czf "$rel/afg-v$v-$t.tar.gz" -C "$work/stage" "afg-v$v-$t"
  (cd "$rel" && { sha256sum ./*.tar.gz 2>/dev/null || shasum -a 256 ./*.tar.gz; } | sed 's# \./# #' >SHA256SUMS)
}
mkrelease

run() { # extra env...
  env PATH="/usr/bin:/bin" AFG_BASE_URL="file://$work/release" AFG_VERSION="$v" "$@" sh "$root/install.sh"
}

# 1. Happy path: installs an executable afg.
run AFG_INSTALL_DIR="$work/bin" 2>"$work/log" || { cat "$work/log"; fail "install failed"; }
[ "$("$work/bin/afg" --version)" = "fake afg --version" ] || fail "installed binary does not run"
grep -q "checksum ok" "$work/log" || fail "checksum not reported"

# 2. Tampered archive: refused, nothing installed.
printf 'x' >>"$rel/afg-v$v-$t.tar.gz"
if run AFG_INSTALL_DIR="$work/bin2" 2>"$work/log"; then fail "tampered archive was installed"; fi
grep -q "checksum mismatch" "$work/log" || fail "no checksum mismatch message"
[ ! -e "$work/bin2/afg" ] || fail "binary installed despite mismatch"

# 3. Archive missing from SHA256SUMS: refused.
: >"$rel/SHA256SUMS"
if run AFG_INSTALL_DIR="$work/bin3" 2>"$work/log"; then fail "unlisted archive was installed"; fi
grep -q "not listed in SHA256SUMS" "$work/log" || fail "no unlisted message"

# 4. Required signature without cosign: refused by the cosign guard, on an otherwise valid release.
mkrelease
if PATH="/usr/bin:/bin" command -v cosign >/dev/null 2>&1; then
  echo "skip 4: cosign is on the minimal PATH"
else
  if run AFG_INSTALL_DIR="$work/bin4" AFG_REQUIRE_COSIGN=1 2>"$work/log"; then fail "installed without required cosign"; fi
  grep -q "AFG_REQUIRE_COSIGN=1 but cosign is not installed" "$work/log" || { cat "$work/log"; fail "no required-cosign message"; }
  [ ! -e "$work/bin4/afg" ] || fail "binary installed without required cosign"
fi

# 5. Shell-metacharacter version: refused.
if env PATH="/usr/bin:/bin" AFG_BASE_URL="file://$work/release" AFG_VERSION='1.0;id' AFG_INSTALL_DIR="$work/bin5" sh "$root/install.sh" 2>"$work/log"; then fail "bad version accepted"; fi
grep -q "invalid version" "$work/log" || fail "no invalid version message"

echo "install.sh: 5/5 passed"
