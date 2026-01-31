import * as path from 'path';
import { config } from '../config.js';

export function getWorkspaceRoot(): string {
  const root = config.WORKSPACE_DIR || process.env.HOME || process.cwd();
  return path.resolve(root);
}

export function isPathWithinRoot(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep);
}

export function resolvePathWithinRoot(root: string, target: string): string | null {
  const resolved = path.resolve(target);
  if (!isPathWithinRoot(root, resolved)) {
    return null;
  }
  return resolved;
}
