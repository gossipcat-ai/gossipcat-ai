#!/usr/bin/env bash
# Release gossipcat to GitHub Releases. NO direct commits to master.
#
# Two-stage flow that respects branch protection:
#
#   Stage 1 — bump version via PR (call once with the new version):
#     ./scripts/release.sh 0.1.2
#     ↓
#     creates branch chore/release-0.1.2, bumps package.json,
#     pushes, opens PR. You merge it via gh/web UI as normal.
#
#   Stage 2 — tag + release from master (call again, no args, after merge):
#     git checkout master && git pull
#     ./scripts/release.sh
#     ↓
#     reads version from package.json, builds, packs, tags v<version>,
#     pushes tag, creates GitHub release with auto-generated notes.
#
# The script auto-detects which stage to run based on whether you pass
# a version arg. No state file, no surprises, no direct push to master.
#
# Requirements: gh (GitHub CLI) authenticated, clean git working tree.

set -euo pipefail

# Allow .claude/settings.local.json to be dirty — it's developer-local state
# that the script doesn't touch. Everything else must be clean.
dirty=$(git status --porcelain | grep -v -E '^\?\? ' | grep -v '\.claude/settings\.local\.json' || true)
if [ -n "$dirty" ]; then
  echo "❌ Working tree has uncommitted changes (excluding .claude/settings.local.json):" >&2
  echo "$dirty" >&2
  echo "Commit, stash, or revert first." >&2
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

############################################################
# Stage 1 — version bump via PR
############################################################
if [ $# -ge 1 ]; then
  version=$1

  current_version=$(node -p "require('./package.json').version")
  if [ "$current_version" = "$version" ]; then
    echo "ℹ️  package.json is already at v$version — skipping Stage 1." >&2
    echo "    Run without arguments to perform Stage 2 (build + tag + release)." >&2
    exit 1
  fi

  current_branch=$(git rev-parse --abbrev-ref HEAD)
  if [ "$current_branch" != "master" ]; then
    echo "❌ Stage 1 must be started from master (currently on $current_branch)." >&2
    exit 1
  fi

  branch="chore/release-${version}"
  echo "→ Creating branch $branch"
  git checkout -b "$branch"

  echo "→ Bumping package.json to v$version"
  npm version "$version" --no-git-tag-version >/dev/null

  git add package.json package-lock.json 2>/dev/null || git add package.json
  git commit -m "chore(release): v${version}"

  echo "→ Pushing $branch"
  git push -u origin "$branch"

  echo "→ Opening PR"
  gh pr create \
    --title "chore(release): v${version}" \
    --body "Version bump for v${version}. After merging this PR, run \`./scripts/release.sh\` (no args) from master to build, tag, and publish the GitHub release."

  echo ""
  echo "✅ Stage 1 complete — version bump PR opened."
  echo ""
  echo "Next:"
  echo "  1. Review and merge the PR via gh or the web UI"
  echo "  2. git checkout master && git pull"
  echo "  3. ./scripts/release.sh   # no args — runs Stage 2"
  exit 0
fi

############################################################
# Stage 2 — build + tag + release from master
############################################################
current_branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$current_branch" != "master" ]; then
  echo "❌ Stage 2 (release) must be run from master (currently on $current_branch)." >&2
  echo "   Did you forget to merge the version bump PR and pull master?" >&2
  exit 1
fi

# Make sure local master matches origin/master — never tag a stale commit
git fetch origin master --quiet
local_sha=$(git rev-parse HEAD)
remote_sha=$(git rev-parse origin/master)
if [ "$local_sha" != "$remote_sha" ]; then
  echo "❌ Local master ($local_sha) is not in sync with origin/master ($remote_sha)." >&2
  echo "   Run: git pull --ff-only" >&2
  exit 1
fi

version=$(node -p "require('./package.json').version")
tag="v${version}"

# Refuse to re-release a version that's already tagged
if git rev-parse "$tag" >/dev/null 2>&1; then
  echo "❌ Tag $tag already exists. Bump the version (Stage 1) before releasing again." >&2
  exit 1
fi

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

# Stable "latest" filename so the install URL never changes between releases
cp "$tarball" "gossipcat.tgz"

echo "→ Tagging $tag"
git tag -a "$tag" -m "gossipcat $tag"

echo "→ Pushing tag"
git push origin "$tag"

echo "→ Creating GitHub release"
gh release create "$tag" \
  "$tarball" \
  "gossipcat.tgz" \
  --title "gossipcat $tag" \
  --generate-notes

# Cleanup local tarballs
rm -f "$tarball" "gossipcat.tgz"

echo ""
echo "✅ Released $tag"
echo ""
echo "Install command (latest):"
echo "  npm install -g https://github.com/gossipcat-ai/gossipcat-ai/releases/latest/download/gossipcat.tgz"
echo ""
echo "Pinned version:"
echo "  npm install -g https://github.com/gossipcat-ai/gossipcat-ai/releases/download/${tag}/gossipcat-${version}.tgz"
