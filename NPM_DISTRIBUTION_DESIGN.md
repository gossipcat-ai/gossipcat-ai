# Gossipcat NPM Distribution & Update Tool — Design Document

**Status:** Design phase (no code written)  
**Date:** 2026-04-06  
**Scope:** Package gossipcat as `gossipcat` on npm registry, add `gossip_update()` MCP tool, unify build pipeline

---

## 1. NPM Package Configuration

### 1.1 Root package.json Changes

**Current state:**
- Monorepo root: `gossip-v2` (private)
- Workspace structure: `packages/*` (relay, orchestrator, client, tools, types, dashboard-v2) + `apps/*` (cli)
- Separate build outputs: `dist-mcp/` (esbuild bundle), `dist-dashboard/` (Vite build)

**Changes needed:**

```json
{
  "name": "gossipcat",
  "version": "0.1.0",
  "description": "Multi-agent orchestration for Claude Code with real-time consensus and performance tracking",
  "private": false,
  "license": "Apache-2.0",
  "bin": {
    "gossipcat": "dist/cli/index.js"
  },
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./mcp": {
      "default": "./dist-mcp/mcp-server.js"
    },
    "./dashboard": {
      "default": "./dist-dashboard/index.html"
    }
  },
  "files": [
    "dist/",
    "dist-mcp/",
    "dist-dashboard/",
    ".mcp.json"
  ],
  "scripts": {
    "build": "npm run build --workspaces && npm run build:mcp && npm run build:dashboard",
    "build:cli": "cd apps/cli && tsc",
    "build:mcp": "esbuild apps/cli/src/mcp-server-sdk.ts --bundle --platform=node --target=node22 --outfile=dist-mcp/mcp-server.js --external:ws --external:@modelcontextprotocol/sdk --tsconfig=tsconfig.json && cp -r packages/orchestrator/src/default-skills dist-mcp/default-skills",
    "build:dashboard": "cd packages/dashboard-v2 && npm run build",
    "postinstall": "node scripts/postinstall.js"
  },
  "publishConfig": {
    "access": "public"
  }
}
```

**Key decisions:**

| Setting | Value | Reason |
|---------|-------|--------|
| `private` | `false` | Enable npm publishing |
| `files` | `dist/*`, `dist-mcp/*`, `dist-dashboard/*`, `.mcp.json` | Distribute pre-built bundles, not source |
| `bin` | `gossipcat` → `dist/cli/index.js` | CLI entry point (currently apps/cli) |
| `exports` | `.mcp`, `.dashboard` subpaths | MCP server and dashboard as optional exports |
| `postinstall` | `scripts/postinstall.js` | Generate `.mcp.json` for Claude Code after install |

---

## 2. Postinstall Script Enhancement

### 2.1 Detection Logic: Global vs Local Install

**Current behavior:** postinstall.js writes `.mcp.json` with hardcoded path: `dist-mcp/mcp-server.js`  
**Problem:** Paths differ between:
- Global npm install: `/usr/local/lib/node_modules/gossipcat/dist-mcp/mcp-server.js`
- Local project install: `./node_modules/gossipcat/dist-mcp/mcp-server.js`
- Git clone development: `/Users/goku/Desktop/gossip/dist-mcp/mcp-server.js`

**Detection strategy:**

```javascript
// Determine install method via environment + package.json location
function detectInstallMethod() {
  // Case 1: npm global install
  // - npm sets `npm_config_prefix` (global prefix, e.g., /usr/local)
  // - __dirname points to node_modules/gossipcat
  const isGlobal = process.env.npm_config_global === 'true';
  
  // Case 2: npm local install (project dependencies)
  // - __dirname = /path/to/project/node_modules/gossipcat
  // - package.json exists at ../../../package.json (project root)
  const isLocalInstall = existsSync(join(__dirname, '..', '..', '..', 'package.json'));
  
  // Case 3: git clone / development mode
  // - .git exists at repo root
  // - package.json at root
  const isDevClone = existsSync(join(__dirname, '..', '.git'));
  
  return { isGlobal, isLocalInstall, isDevClone };
}
```

**MCP server path resolution:**

```javascript
function resolveMcpServerPath(root, { isGlobal, isLocalInstall, isDevClone }) {
  if (isDevClone) {
    // Git clone: relative path within repo
    return join(root, 'dist-mcp', 'mcp-server.js');
  }
  if (isGlobal || isLocalInstall) {
    // npm package: path is within installed node_modules
    // Both resolve to same relative structure: node_modules/gossipcat/dist-mcp/mcp-server.js
    return join(root, 'dist-mcp', 'mcp-server.js');
  }
  throw new Error('Unable to detect installation method');
}
```

**Output `.mcp.json` examples:**

```javascript
// Global install (/usr/local/lib/node_modules/gossipcat)
{
  "mcpServers": {
    "gossipcat": {
      "command": "node",
      "args": ["/usr/local/lib/node_modules/gossipcat/dist-mcp/mcp-server.js"]
    }
  }
}

// Local project install (./node_modules/gossipcat)
{
  "mcpServers": {
    "gossipcat": {
      "command": "node",
      "args": ["./node_modules/gossipcat/dist-mcp/mcp-server.js"]
    }
  }
}

// Git clone
{
  "mcpServers": {
    "gossipcat": {
      "command": "node",
      "args": ["/Users/goku/Desktop/gossip/dist-mcp/mcp-server.js"]
    }
  }
}
```

### 2.2 Unified Build on Postinstall?

**Option A: Pre-built distribution (recommended)**
- Ship `dist-mcp/mcp-server.js` and `dist-dashboard/` pre-built in npm package
- postinstall only generates `.mcp.json`
- **Pros:** Fast install (no compilation), smaller node_modules footprint
- **Cons:** Larger package tarball, OS-specific builds needed

**Option B: Build on postinstall**
- Ship source, run `npm run build:mcp && npm run build:dashboard` in postinstall
- **Pros:** Single-source-of-truth, OS-independent
- **Cons:** Slow npm install (30+ sec), esbuild must be distributed, dashboard build requires Node 22+

**Recommendation:** **Option A (pre-built)**
- Most npm packages pre-build for speed
- postinstall would only run `npm run build:dashboard` if dashboard sources are included (see §2.3)

### 2.3 Dashboard Distribution Strategy

**Current state:** Vite builds to `dist-dashboard/`, served by relay at runtime via `/dashboard` HTTP route

**Choices:**

| Option | Included in Package | Built Where | Serve Path |
|--------|---------------------|--------------|-----------|
| **A. Pre-built** | `dist-dashboard/assets` + `index.html` | CI/pre-publish | `relay.dashboardUrl` (baked-in) |
| **B. Source included** | `packages/dashboard-v2/src/**` | postinstall | `relay.dashboardUrl` (dynamic) |
| **C. Skip dashboard** | No | N/A | Optional: users build locally if needed |

**Recommendation:** **Option A (pre-built)**
- Dashboard is read-only UI served by relay HTTP server
- Pre-build in CI before publish to npm
- Reduces postinstall complexity and install time
- If users customize dashboard later, they fork and build locally

**Implementation:**
- Root `build` script: `npm run build --workspaces && npm run build:mcp && npm run build:dashboard`
- CI workflow publishes built artifacts to npm
- postinstall only generates `.mcp.json`

---

## 3. gossip_update() MCP Tool

### 3.1 Tool Contract

```typescript
server.tool(
  'gossip_update',
  'Check for and apply gossipcat updates. Auto-detects install method (global/local npm or git clone). Fetches latest version from npm registry, compares with current version, downloads/extracts if newer.',
  {
    auto_apply: z.boolean().default(true)
      .describe('If true, automatically apply update. If false, only check and report.'),
    check_only: z.boolean().default(false)
      .describe('Just check version without updating. Overrides auto_apply.'),
    dry_run: z.boolean().default(false)
      .describe('Simulate update without modifying files (development).'),
  },
  async ({ auto_apply, check_only, dry_run }) => {
    const { handleGossipUpdate } = await import('./handlers/gossip-update');
    return handleGossipUpdate({ auto_apply, check_only, dry_run });
  }
);
```

### 3.2 Version Check Implementation

**Fetch from npm registry:**

```typescript
async function checkNpmRegistry(): Promise<{ latest: string; current: string; hasUpdate: boolean }> {
  // Fetch package metadata from npm public registry (no auth required)
  const response = await fetch('https://registry.npmjs.org/gossipcat');
  const data = await response.json();
  
  const latest = data['dist-tags'].latest;
  const current = require(join(process.cwd(), 'package.json')).version;
  
  return { latest, current, hasUpdate: latest > current };
}
```

**Version comparison:**
- Use semver comparison: `compare(latest, current) > 0`
- Warn if `latest` is prerelease (e.g., `0.2.0-rc1`) and current is stable

### 3.3 Install Method Detection

Reuse same logic as postinstall (§2.1):

```typescript
function detectInstallMethod() {
  const isGlobal = process.env.npm_config_global === 'true';
  const isLocalInstall = existsSync(join(process.cwd(), 'node_modules', 'gossipcat'));
  const isDevClone = existsSync(join(process.cwd(), '.git')) && 
                     existsSync(join(process.cwd(), 'apps/cli/src/mcp-server-sdk.ts'));
  
  return { isGlobal, isLocalInstall, isDevClone };
}
```

### 3.4 Update Execution by Install Method

| Method | Command | Rationale |
|--------|---------|-----------|
| **Global npm** | `npm install -g gossipcat@latest` | Standard npm global update |
| **Local npm** | `npm update gossipcat` (in project dir) | Updates package.json, runs postinstall |
| **Git clone** | `git pull origin master && npm run build` | Pull latest, rebuild locally |

**Pseudocode:**

```typescript
async function applyUpdate(installMethod, version) {
  if (dry_run) {
    return { status: 'dry_run', command: <computed command>, message: 'Would update...' };
  }
  
  switch (installMethod) {
    case 'global':
      // npm install -g gossipcat@latest
      return await spawnSync('npm', ['install', '-g', `gossipcat@${version}`]);
    
    case 'local':
      // npm update gossipcat
      // This runs package.json's postinstall hook automatically
      return await spawnSync('npm', ['update', 'gossipcat']);
    
    case 'git_clone':
      // git pull && npm run build
      const gitPull = spawnSync('git', ['pull', 'origin', 'master']);
      if (gitPull.status !== 0) throw new Error('git pull failed');
      return await spawnSync('npm', ['run', 'build']);
    
    default:
      throw new Error('Unknown install method');
  }
}
```

### 3.5 Relay Restart on Update

**Problem:** After npm updates gossipcat, relay process is still running old code.

**Solution:** gossip_update() should signal relay to shutdown:

```typescript
// After successful update:
if (!check_only && auto_apply) {
  // Graceful shutdown signal
  if (ctx.relay) {
    await ctx.relay.shutdown();
  }
  
  return {
    content: [{
      type: 'text',
      text: `✓ Updated to v${newVersion}. Claude Code will reconnect to updated relay automatically.`
    }]
  };
}
```

**Relay reconnection:** Claude Code's MCP infrastructure will see the process exit and restart `mcp-server.js`. New process reads fresh `dist-mcp/mcp-server.js` (if global) or loads from node_modules (if local).

### 3.6 Output Messages

```
✓ Checking for updates...
  Current: v0.1.0
  Latest:  v0.1.1 (patch)
  
  Update available. Running: npm install -g gossipcat@0.1.1
  ✓ Updated. Relay will reconnect automatically.
```

```
ℹ Already up to date (v0.1.0)
```

```
⚠ Prerelease detected (v0.2.0-rc1). To install: gossip_update(check_only: true)
```

---

## 4. Build Pipeline Unification

### 4.1 Current State

Two separate build commands:
- `npm run build:mcp` — esbuild to `dist-mcp/mcp-server.js`
- `npm run build:dashboard` — vite to `dist-dashboard/`

Each builds independently. CI must run both.

### 4.2 Unified Build Command

**Root package.json:**

```json
"scripts": {
  "build": "npm run build --workspaces && npm run build:mcp && npm run build:dashboard",
  "build:cli": "cd apps/cli && tsc",
  "build:mcp": "npx esbuild apps/cli/src/mcp-server-sdk.ts --bundle --platform=node --target=node22 --outfile=dist-mcp/mcp-server.js --external:ws --external:@modelcontextprotocol/sdk --tsconfig=tsconfig.json && cp -r packages/orchestrator/src/default-skills dist-mcp/default-skills",
  "build:dashboard": "cd packages/dashboard-v2 && npm run build",
  "postinstall": "node scripts/postinstall.js"
}
```

**CI workflow (publish to npm):**

```yaml
- name: Build all artifacts
  run: npm run build

- name: Publish to npm
  run: npm publish
  env:
    NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### 4.3 Version Synchronization

**Proposal:** Single source of truth in root package.json

All workspace packages read version from root:

```json
{
  "packages/relay/package.json": { "version": "0.1.0" },
  "packages/orchestrator/package.json": { "version": "0.1.0" },
  ...
}
```

**Tool:** npm's `npm version` auto-increments root + all workspaces:

```bash
npm version patch  # 0.1.0 → 0.1.1
npm version minor  # 0.1.0 → 0.2.0
npm version major  # 0.1.0 → 1.0.0
```

**Update gossip_status banner:**

Currently hardcoded: `gossipcat v0.1.0`

Read from root package.json at runtime:

```typescript
const packageJson = require(join(process.cwd(), 'package.json'));
const version = packageJson.version || '0.1.0';
const banner = [..., `   /\\_/\\   gossipcat v${version}`, ...];
```

---

## 5. Risks & Mitigations

### 5.1 Risk: Absolute Path in .mcp.json

**Risk:** Shipped `.mcp.json` with hardcoded paths won't work on other machines.  
**Mitigation:** postinstall always regenerates `.mcp.json` based on actual install location (§2.1). Don't ship `.mcp.json` in package; generate it on install.

**Fix in files array:**

```json
"files": [
  "dist/",
  "dist-mcp/",
  "dist-dashboard/",
  "scripts/"
]
```

(exclude `.mcp.json` from package tarball)

### 5.2 Risk: External Build Dependencies

**Risk:** Vite + esbuild are devDependencies; CI must have them to build before publish.

**Current:** devDependencies installed globally; CI builds then publishes.

**OK if:** CI always runs `npm run build` before `npm publish`. Add safety check:

```bash
# package.json prepublishOnly
"prepublishOnly": "npm run build && npm test"
```

### 5.3 Risk: Dashboard Bundle Size

**Risk:** Pre-built dashboard assets (~200KB gzipped) ship in every npm package install.

**Mitigation:** Dashboard is optional. Users who don't use Claude Code relay can skip it (gossipcat works fine headless). Consider separate `@gossipcat/dashboard` package if size becomes issue.

### 5.4 Risk: Git Clone → npm Package Confusion

**Risk:** A user might:
1. Clone repo from GitHub
2. Later install gossipcat from npm globally
3. .mcp.json now points to npm package, not git clone

**Mitigation:** postinstall logic (§2.1) detects dev clone vs npm install. If user develops on git clone, they should stay on git clone. If they switch to npm, postinstall regenerates `.mcp.json` correctly. Document this in README.

### 5.5 Risk: Workspace Dependency Versions

**Risk:** Root depends on `@gossip/relay`, `@gossip/orchestrator`, etc. as wildcard (`*`). When published, should pin versions.

**Current package.json structure:**

```json
// apps/cli/package.json
"dependencies": {
  "@gossip/relay": "*",
  "@gossip/orchestrator": "*"
}
```

When published to npm as `gossipcat`, the `@gossip/*` packages don't exist on npm (only locally).

**Solution:** 

Option 1: Publish all workspace packages to npm under `@gossipcat/*` scope:
- `@gossipcat/relay` → `/packages/relay`
- `@gossipcat/orchestrator` → `/packages/orchestrator`
- `gossipcat` → root (metapackage that depends on the above)

Option 2: Bundle everything into single `gossipcat` package (current esbuild approach for MCP server).

**Recommendation:** **Option 2 (current approach)**
- esbuild already bundles `dist-mcp/mcp-server.js` with all internal deps
- No need to publish separate `@gossipcat/*` packages to npm
- Keep internal packages as workspace-only
- Only `gossipcat` is public

---

## 6. Implementation Plan

### Phase 1: Package Configuration (Day 1)
- [ ] Update root package.json: set `private: false`, add `files`, `bin`, `exports`, `publishConfig`
- [ ] Update scripts: `build` → unified, `postinstall` → enhanced
- [ ] Create `.npmignore` to exclude source and .git
- [ ] Verify `npm run build` produces all three outputs: `dist/`, `dist-mcp/`, `dist-dashboard/`

### Phase 2: Postinstall Enhancement (Day 1-2)
- [ ] Enhance `scripts/postinstall.js`: detect install method (global/local/git clone)
- [ ] Resolve correct MCP server path for each case
- [ ] Test postinstall locally: `npm install . -g`, verify `.mcp.json` path is absolute
- [ ] Test postinstall in project: `npm install ..`, verify `.mcp.json` path is relative

### Phase 3: gossip_update() Tool (Day 2-3)
- [ ] Create `apps/cli/src/handlers/gossip-update.ts`
- [ ] Implement version check via npm registry API
- [ ] Implement install method detection (reuse postinstall logic)
- [ ] Implement update execution: spawn npm/git commands based on method
- [ ] Wire relay shutdown on successful update
- [ ] Register `gossip_update()` tool in MCP server (after gossip_status for reference)
- [ ] Output messages: success, up-to-date, prerelease warnings

### Phase 4: Build & Publishing (Day 3-4)
- [ ] Update CI workflow to run `npm run build` before publish
- [ ] Add `prepublishOnly` hook to verify build + tests
- [ ] Create release checklist: bump version, commit, tag, push, npm publish
- [ ] Verify published package can be installed globally: `npm install -g gossipcat@latest`
- [ ] Verify postinstall runs and generates correct `.mcp.json`

### Phase 5: Documentation (Day 4)
- [ ] Update README: installation instructions for npm global, local, git clone
- [ ] Document `gossip_update()` tool usage
- [ ] Document install method detection (why paths differ)
- [ ] Add troubleshooting section: wrong .mcp.json path, update failures

---

## 7. File Changes Summary

### New/Modified Files

| File | Change | Reason |
|------|--------|--------|
| `package.json` | name, version, bin, files, exports, scripts | npm publishable config |
| `scripts/postinstall.js` | enhance with install detection | correct .mcp.json paths |
| `apps/cli/src/handlers/gossip-update.ts` | new | gossip_update() handler |
| `apps/cli/src/mcp-server-sdk.ts` | add gossip_update tool | MCP registration |
| `.npmignore` | new | exclude source from tarball |
| CI workflow | add build step | pre-publish build |
| `README.md` | installation + gossip_update docs | user guidance |

### Unchanged Files

- `tsconfig.json` — already correct
- `apps/cli/src/mcp-server-sdk.ts` version hardcoding → replaced with dynamic read
- `packages/orchestrator/src/default-skills/` — shipped as-is in dist-mcp

---

## 8. Version Numbering & Release Strategy

**Current:** Root is `0.1.0`, workspace packages follow

**Strategy:**
1. Use `npm version [patch|minor|major]` to bump root + all workspaces
2. CI auto-detects version from package.json
3. Publish with `npm publish` (CI runs `prepublishOnly` hooks)
4. Tag git: `git tag v0.1.0` (manual or via CI)

**Prerelease:**
- `npm version prerelease` → `0.2.0-rc.0`
- CI publishes as `npm publish --tag rc`
- Users can opt-in: `npm install -g gossipcat@rc`

**gossip_update() behavior:**
- By default, only updates to latest stable (`dist-tags.latest`)
- With `pre_release: true` flag, checks `dist-tags.next` (prerelease)

---

## 9. Gotchas & Edge Cases

### 9.1 esbuild Externals

Current build excludes `ws` and `@modelcontextprotocol/sdk` as external. These must be in runtime dependencies of the npm package root:

```json
"dependencies": {
  "@modelcontextprotocol/sdk": "^1.27.1",
  "tsconfig-paths": "^4.2.0",
  "ws": "^8.19.0",
  "@clack/prompts": "^1.1.0"
}
```

Verify: `npm ls ws` after installing gossipcat to confirm it's available at runtime.

### 9.2 default-skills Directory

Build copies `packages/orchestrator/src/default-skills` to `dist-mcp/default-skills`.

Verify in postinstall or at runtime:
```typescript
const skillsPath = join(__dirname, '..', 'dist-mcp', 'default-skills');
if (!existsSync(skillsPath)) {
  throw new Error('default-skills not found — corrupted installation?');
}
```

### 9.3 .claude/agents/ Directory

Relay expects user to have `.claude/agents/*.md` files in their project for native agents. This is not shipped with npm package; users create them via gossip_setup().

### 9.4 Global npm + User Project Root

If user globally installs `npm install -g gossipcat`, the `.mcp.json` lands in their project root (wherever Claude Code is running).

This is correct — Claude Code looks for `.mcp.json` in the project root it's opened, not in `node_modules`.

### 9.5 npm local install with lock files

If project has `package-lock.json`, `npm update gossipcat` may not pull latest if lock file pins an older version. Document users should use `npm install gossipcat@latest` for explicit version.

---

## 10. Next Steps

1. **Acceptance:** Review this design document, confirm approach with team
2. **Implementation:** Follow Phase 1-5 plan (4-5 days total)
3. **Testing:** 
   - npm global install + postinstall
   - project local install + postinstall
   - git clone + development
   - gossip_update() check/apply cycles
4. **Release:** Tag v0.1.0, publish to npm, announce
