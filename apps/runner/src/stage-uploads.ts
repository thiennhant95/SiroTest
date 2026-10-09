/**
 * stage-uploads.ts — per-run upload staging with REAL filenames.
 *
 * Library bytes live in shared storage as `<fileId>-<name>` (uniqueness).
 * Uploading that path leaks the internal id into the page (`<input
 * type=file>` shows it) and breaks apps that validate filenames. Staging
 * copies each file into the isolated workDir under its ORIGINAL library
 * name and returns the rewritten fileId → staged-path map for
 * `VV_FILE_PATHS`. Collisions within one run get a numeric suffix.
 * WorkDir cleanup (step 8) removes the copies — no server bookkeeping.
 */
import { copyFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

function safeName(raw: string | undefined, fallback: string): string {
  const base = basename(raw ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
  return base.length > 0 ? base.slice(0, 120) : fallback;
}

export async function stageUploadFiles(
  workDir: string,
  filePaths: Record<string, string>,
  fileNames?: Record<string, string>,
): Promise<Record<string, string>> {
  const ids = Object.keys(filePaths).sort();
  if (ids.length === 0) return {};
  const dir = join(workDir, 'files');
  await mkdir(dir, { recursive: true });
  const staged: Record<string, string> = {};
  const taken = new Set<string>();
  let n = 0;
  for (const id of ids) {
    n += 1;
    const src = filePaths[id]!;
    let name = safeName(fileNames?.[id] ?? basename(src), `upload-${n}`);
    // Never stage the storage-unique `<id>-<name>` form when we know better:
    // prefer the library original; dedupe within this run only.
    let candidate = name;
    let dup = 2;
    while (taken.has(candidate)) {
      const dot = name.lastIndexOf('.');
      candidate = dot > 0 ? `${name.slice(0, dot)}-${dup}${name.slice(dot)}` : `${name}-${dup}`;
      dup += 1;
    }
    taken.add(candidate);
    const dest = join(dir, candidate);
    try {
      await copyFile(src, dest);
    } catch (err) {
      throw new Error(`upload staging failed for '${candidate}': ${err instanceof Error ? err.message : String(err)}`);
    }
    staged[id] = dest;
  }
  return staged;
}
