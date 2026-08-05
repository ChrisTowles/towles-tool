#!/usr/bin/env bash
# Publishes the npm tarballs `pack.sh` built, skipping any version already on
# the registry. The registry is what makes a re-run a no-op, and it is the only
# thing that can answer "did this already ship?" across runners — which is why a
# half-finished release is safe to simply run again.
#
#   npm/publish.sh --dry-run dist/*.tgz
#   npm/publish.sh dist/*.tgz
set -euo pipefail

WRAPPER="@towles-tool/comment-budget"

dry_run=""
tarballs=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    *.tgz) tarballs+=("$arg") ;;
  esac
done

if [ ${#tarballs[@]} -eq 0 ]; then
  echo "publish: no tarballs; this runner built none of the platform packages" >&2
  exit 1
fi

field() {
  printf '%s' "$1" |
    node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync(0,'utf8')).$2))"
}

# Platform packages must land before the wrapper: it depends on them, and a
# wrapper published first is an install that resolves to nothing. Split by
# manifest name rather than by filename, because `npm pack` names a tarball
# after its package and the wrapper's name is a prefix of every other one.
platform=()
wrapper=()
for tarball in "${tarballs[@]}"; do
  if [ "$(field "$(tar -xzOf "$tarball" package/package.json)" name)" = "$WRAPPER" ]; then
    wrapper+=("$tarball")
  else
    platform+=("$tarball")
  fi
done

published=0
skipped=0

for tarball in ${platform[@]+"${platform[@]}"} ${wrapper[@]+"${wrapper[@]}"}; do
  manifest="$(tar -xzOf "$tarball" package/package.json)"
  name="$(field "$manifest" name)"
  version="$(field "$manifest" version)"

  if npm view "$name@$version" version >/dev/null 2>&1; then
    echo "skip    $name@$version (already published)"
    skipped=$((skipped + 1))
    continue
  fi

  if [ -n "$dry_run" ]; then
    echo "would   $name@$version <- $tarball"
    continue
  fi

  echo "publish $name@$version"
  npm publish "$tarball"
  published=$((published + 1))
done

echo "${published} published, ${skipped} already on the registry"
