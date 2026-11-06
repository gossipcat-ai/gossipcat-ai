import { symlinkSync, statSync } from 'fs';

/**
 * Create a symlink for a test. Returns false (so the caller can stop) only when
 * Windows refuses with EPERM because the account lacks the symlink privilege;
 * every other error is rethrown. Directory links use a junction on Windows,
 * which needs no privilege and which Node reports as a symlink; on POSIX the
 * type argument is ignored.
 */
export function trySymlink(target: string, path: string): boolean {
  try {
    let type: 'junction' | undefined;
    if (process.platform === 'win32') {
      try { if (statSync(target).isDirectory()) type = 'junction'; } catch { /* dangling target */ }
    }
    symlinkSync(target, path, type);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw e;
  }
}
