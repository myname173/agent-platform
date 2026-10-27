#!/bin/sh
# Install the repo's git hooks into .git/hooks (per-clone; .git is not tracked).
# Re-run after cloning. Usage: sh scripts/install-git-hooks.sh
set -e

root=$(git rev-parse --show-toplevel)
src="$root/scripts/hooks"
dst="$root/.git/hooks"

[ -d "$src" ] || { echo "no hooks directory at $src"; exit 1; }
[ -d "$dst" ] || { echo "not a git repository: $dst missing"; exit 1; }

for f in "$src"/*; do
  [ -f "$f" ] || continue
  name=$(basename "$f")
  cp "$f" "$dst/$name"
  chmod +x "$dst/$name" 2>/dev/null || true
  echo "installed: .git/hooks/$name"
done

echo "done. (bypass once with: git push --no-verify)"
