#!/usr/bin/env bash
# Usage: ./scripts/release.sh <version>     (e.g. 0.1.1)
# Publishes gossipcat to GitHub Releases — no npm publish required.
#
# What this does:
#   1. Bumps package.json version (no git tag — we tag at the end)
#   2. Builds MCP bundle + dashboard
#   3. Packs a tarball
#   4. Creates a GitHub release with the tarball + auto-generated notes
#   5. Commits the version bump, tags, pushes
#
# After this runs, users install via:
#   npm install -g https://github.com/gossipcat-ai/gossipcat-ai/releases/latest/download/gossipcat.tgz
#
# Requirements: gh (GitHub CLI) authenticated, clean git working tree on master.

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <version>" >&2
  echo "Example: $0 0.1.1" >&2
  exit 1
fi

version=$1

# Sanity checks
if [ -n "$(git status --porcelain | grep -v '^?? ')" ]; then
  echo "❌ Working tree has uncommitted changes. Commit or stash first." >&2
  git status --short >&2
  exit 1
fi

current_branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$current_branch" != "master" ]; then
  echo "❌ Releases must be cut from master (currently on $current_branch)." >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "❌ GitHub CLI 'gh' not found. Install: https://cli.github.com/" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "❌ gh is not authenticated. Run: gh auth login" >&2
  exit 1
fi

echo "→ Bumping version to $version"
npm version "$version" --no-git-tag-version >/dev/null

echo "→ Building MCP bundle"
npm run build:mcp

echo "→ Building dashboard"
npm run build:dashboard

echo "→ Packing tarball"
rm -f gossipcat-*.tgz
npm pack >/dev/null
tarball="gossipcat-${version}.tgz"
if [ ! -f "$tarball" ]; then
  echo "❌ Expected $tarball after npm pack, got:" >&2
  ls gossipcat-*.tgz >&2 || true
  exit 1
fi

# Also produce a stable "latest" filename so the install URL never changes
cp "$tarball" "gossipcat.tgz"

echo "→ Committing version bump"
git add package.json package-lock.json 2>/dev/null || git add package.json
git commit -m "chore(release): v${version}"

echo "→ Tagging v${version}"
git tag -a "v${version}" -m "gossipcat v${version}"

echo "→ Pushing to origin"
git push origin master
git push origin "v${version}"

echo "→ Creating GitHub release"
gh release create "v${version}" \
  "$tarball" \
  "gossipcat.tgz" \
  --title "gossipcat v${version}" \
  --generate-notes

# Cleanup local tarballs (gitignored but still clutter)
rm -f "$tarball" "gossipcat.tgz"

echo ""
echo "✅ Released v${version}"
echo ""
echo "Install command:"
echo "  npm install -g https://github.com/gossipcat-ai/gossipcat-ai/releases/latest/download/gossipcat.tgz"
echo ""
echo "Pinned version:"
echo "  npm install -g https://github.com/gossipcat-ai/gossipcat-ai/releases/download/v${version}/gossipcat-${version}.tgz"
