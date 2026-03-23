import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createHash, randomBytes } from 'crypto';
import { execFileSync } from 'child_process';

function getOrCreateSalt(projectRoot: string): string {
  const saltPath = join(projectRoot, '.gossip', 'local-salt');
  try {
    return readFileSync(saltPath, 'utf-8').trim();
  } catch {
    // File doesn't exist — create atomically (wx flag fails if file already exists)
    const salt = randomBytes(16).toString('hex');
    mkdirSync(join(projectRoot, '.gossip'), { recursive: true });
    try {
      writeFileSync(saltPath, salt, { flag: 'wx' });
      return salt;
    } catch {
      // Another process created it first — read theirs
      return readFileSync(saltPath, 'utf-8').trim();
    }
  }
}

export function getUserId(projectRoot: string): string {
  try {
    const email = execFileSync('git', ['config', 'user.email'], { stdio: 'pipe' }).toString().trim();
    const salt = getOrCreateSalt(projectRoot);
    return createHash('sha256').update(email + projectRoot + salt).digest('hex').slice(0, 16);
  } catch { return 'anonymous'; }
}

/** Normalize git remote URL to canonical form: hostname/owner/repo */
export function normalizeGitUrl(url: string): string | null {
  if (!url) return null;
  try {
    const withProtocol = url.replace(/^([^@]+@)?([^:\/]+):(?!\/)/, 'ssh://$2/');
    const parsed = new URL(withProtocol);
    const pathname = parsed.pathname.replace(/^\//, '').replace(/\.git$/, '');
    return `${parsed.hostname}/${pathname}`;
  } catch {
    return url.replace(/^(https?:\/\/|git@|ssh:\/\/)/, '').replace(/\.git$/, '').replace(/:/, '/');
  }
}

export function getTeamUserId(email: string, teamSalt: string): string {
  return createHash('sha256').update(email + teamSalt).digest('hex').slice(0, 16);
}

export function getGitEmail(): string | null {
  try {
    const email = execFileSync('git', ['config', 'user.email'], { stdio: 'pipe' }).toString().trim();
    return email || null;
  } catch { return null; }
}

export function getProjectId(projectRoot: string): string {
  try {
    const remoteUrl = execFileSync(
      'git', ['config', '--get', 'remote.origin.url'],
      { cwd: projectRoot, stdio: 'pipe' }
    ).toString().trim();
    const normalized = normalizeGitUrl(remoteUrl);
    if (normalized) {
      return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
    }
  } catch { /* no remote */ }
  return createHash('sha256').update(projectRoot).digest('hex').slice(0, 16);
}
