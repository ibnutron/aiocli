import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export class WorkspaceViolationError extends Error {}

/**
 * The folders tools may touch: the workspace, then directories added with
 * /add-dir or --add-dir. Relative paths resolve against the workspace.
 */
export type Roots = string | string[];

/** Resolves `targetPath` against the workspace, refusing anything outside every root. */
export function resolveInWorkspace(roots: Roots, targetPath: string): string {
  const [workspaceRoot = '.', ...extra] = Array.isArray(roots) ? roots : [roots];
  const resolved = isAbsolute(targetPath) ? resolve(targetPath) : resolve(workspaceRoot, targetPath);
  const inside = [workspaceRoot, ...extra].some((root) => {
    const rel = relative(root, resolved);
    return !(rel.startsWith('..') || isAbsolute(rel));
  });
  if (!inside) {
    throw new WorkspaceViolationError(
      `Path "${targetPath}" is outside the workspace${extra.length ? ' and the added directories' : ''}`,
    );
  }
  return resolved;
}

export function readFile(workspaceRoot: Roots, path: string): string {
  return readFileSync(resolveInWorkspace(workspaceRoot, path), 'utf8');
}

export function writeFile(workspaceRoot: Roots, path: string, content: string): void {
  const absolute = resolveInWorkspace(workspaceRoot, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
}

export function editFile(workspaceRoot: Roots, path: string, oldString: string, newString: string): void {
  const absolute = resolveInWorkspace(workspaceRoot, path);
  const content = readFileSync(absolute, 'utf8');
  const occurrences = content.split(oldString).length - 1;
  if (occurrences === 0) {
    throw new Error(`old_string not found in ${path}`);
  }
  if (occurrences > 1) {
    throw new Error(`old_string is not unique in ${path} (${occurrences} matches)`);
  }
  writeFileSync(absolute, content.replace(oldString, newString), 'utf8');
}

export function listDir(workspaceRoot: Roots, path: string): string[] {
  const absolute = resolveInWorkspace(workspaceRoot, path);
  return readdirSync(absolute).map((entry) => {
    const isDir = statSync(join(absolute, entry)).isDirectory();
    return isDir ? `${entry}/` : entry;
  });
}

export function pathExists(workspaceRoot: Roots, path: string): boolean {
  try {
    return existsSync(resolveInWorkspace(workspaceRoot, path));
  } catch {
    return false;
  }
}
