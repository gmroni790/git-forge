// Line/file diffs for PR files and merge accounting. Deterministic, O(n).

import type { Oid, PullFile } from './types.ts';

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop(); // drop a single trailing empty piece
  return lines;
}

/**
 * Split on '\n' (drop a single trailing empty piece from a trailing newline);
 * trim common prefix/suffix lines; additions = remaining new lines,
 * deletions = remaining old lines. Deterministic, O(n).
 */
export function diffLines(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  return { additions: newEnd - start, deletions: oldEnd - start };
}

/**
 * One entry per path that differs (added/modified/removed), sorted by
 * filename. additions/deletions via diffLines on utf8 text (blobs here are
 * text). `sha` = new blob oid (or old blob oid for removed files).
 */
export function diffFileMaps(
  oldMap: Map<string, { oid: Oid; mode: string }>,
  newMap: Map<string, { oid: Oid; mode: string }>,
  getBlob: (oid: Oid) => Buffer | null,
): PullFile[] {
  const paths = new Set<string>([...oldMap.keys(), ...newMap.keys()]);
  const out: PullFile[] = [];
  for (const path of [...paths].sort()) {
    const oldEntry = oldMap.get(path);
    const newEntry = newMap.get(path);
    if (oldEntry && newEntry && oldEntry.oid === newEntry.oid && oldEntry.mode === newEntry.mode) continue;
    const oldText = oldEntry ? (getBlob(oldEntry.oid)?.toString('utf8') ?? '') : '';
    const newText = newEntry ? (getBlob(newEntry.oid)?.toString('utf8') ?? '') : '';
    const { additions, deletions } = diffLines(oldText, newText);
    const status = !oldEntry ? 'added' : !newEntry ? 'removed' : 'modified';
    out.push({
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      sha: newEntry ? newEntry.oid : (oldEntry as { oid: Oid }).oid,
    });
  }
  return out;
}
