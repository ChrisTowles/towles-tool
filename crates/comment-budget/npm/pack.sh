#!/usr/bin/env bash
# Builds the npm tarballs for the machine it runs on.
#
# An npm tarball is just gzip with every path under `package/`, and `npm pack`
# writes one from a staged directory — so the release path needs no bundler and
# no workspace wiring, only cargo and npm.
#
# One host produces one platform package, because a macOS binary needs an SDK
# that cannot be vendored onto a Linux box. `--wrapper` additionally emits the
# platform-independent package that depends on them; exactly one runner in the
# release matrix passes it, so there is one copy rather than three.
#
#   npm/pack.sh dist
#   npm/pack.sh dist --wrapper
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
crate="$(dirname "$here")"
root="$(cd "$crate/../.." && pwd)"

SCOPE="@towles-tool"
EXE="comment-budget"
REPO="https://github.com/ChrisTowles/towles-tool"

out="${1:-}"
if [ -z "$out" ]; then
  echo "usage: npm/pack.sh <out-dir> [--wrapper]" >&2
  exit 2
fi
mkdir -p "$out"
out="$(cd "$out" && pwd)"
wrapper=""
[ "${2:-}" = "--wrapper" ] && wrapper=1

# Cargo.toml is the one place the version lives; every manifest below is
# stamped from it, so there is no second copy to forget to bump.
version="$(sed -n 's/^version = "\(.*\)"$/\1/p' "$crate/Cargo.toml" | head -1)"
[ -n "$version" ] || { echo "pack: no version in Cargo.toml" >&2; exit 1; }

# The published platforms. Windows and Intel macOS are deliberately absent:
# nothing in the release matrix builds them, and a package that resolves to a
# binary nobody produced is worse than no package at all.
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64)  platform=linux-x64-gnu   os=linux  cpu=x64   libc=glibc ;;
  Linux/aarch64) platform=linux-arm64-gnu os=linux  cpu=arm64 libc=glibc ;;
  Darwin/arm64)  platform=darwin-arm64    os=darwin cpu=arm64 libc= ;;
  *)
    echo "pack: $(uname -s)/$(uname -m) is not a published platform" >&2
    exit 1
    ;;
esac

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

# Stripped via the environment rather than a profile in Cargo.toml: the
# workspace sets `strip = false` so the app keeps symbolicated crash reports,
# and inheriting that would put ~10MB of debug info in every install of this.
CARGO_PROFILE_RELEASE_STRIP=symbols \
  cargo build --release --manifest-path "$crate/Cargo.toml" --bin "$EXE"

# The platform package: one binary, and the metadata a package manager reads to
# skip the machines that cannot run it.
pkg="$stage/$platform"
mkdir -p "$pkg/bin"
install -m 755 "$root/target/release/$EXE" "$pkg/bin/$EXE"
cp "$crate/LICENSE-MIT" "$crate/LICENSE-APACHE" "$pkg/"
{
  printf '{\n'
  printf '  "name": "%s/%s-%s",\n' "$SCOPE" "$EXE" "$platform"
  printf '  "version": "%s",\n' "$version"
  printf '  "description": "%s binary for %s",\n' "$EXE" "$platform"
  printf '  "license": "MIT OR Apache-2.0",\n'
  printf '  "repository": {"type": "git", "url": "git+%s.git", "directory": "crates/%s"},\n' "$REPO" "$EXE"
  printf '  "os": ["%s"],\n' "$os"
  printf '  "cpu": ["%s"],\n' "$cpu"
  if [ -n "$libc" ]; then printf '  "libc": ["%s"],\n' "$libc"; fi
  printf '  "files": ["bin", "LICENSE-MIT", "LICENSE-APACHE"],\n'
  printf '  "publishConfig": {"access": "public"}\n'
  printf '}\n'
} > "$pkg/package.json"
(cd "$pkg" && npm pack --pack-destination "$out" >/dev/null)

if [ -n "$wrapper" ]; then
  # Its package.json is committed rather than stamped: the platform packages it
  # depends on have to be pinned to an exact version, and `npm_pins` is the test
  # that keeps that copy honest against Cargo.toml.
  w="$stage/wrapper"
  mkdir -p "$w"
  cp "$here/$EXE/package.json" "$here/$EXE/postinstall.js" "$w/"
  install -m 755 "$here/$EXE/$EXE" "$w/$EXE"
  cp "$crate/README.md" "$crate/LICENSE-MIT" "$crate/LICENSE-APACHE" "$w/"
  (cd "$w" && npm pack --pack-destination "$out" >/dev/null)
fi

ls -1 "$out"/*.tgz
