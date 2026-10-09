/**
 * trace-scrub.ts — redact secret values inside Playwright trace.zip artifacts.
 *
 * The runner redacts secrets from result.json / DB / WS events, but the
 * Playwright-generated trace.zip embeds RESOLVED values (action params,
 * embedded error text, network bodies). The zip is downloadable by anyone
 * with run read access — so after promotion we rewrite text entries
 * (`*.trace`, `*.stacks`, `*.network`, …) with secrets replaced by `***`.
 *
 * Safety: entries that do not UTF-8-decode cleanly are left byte-identical
 * (screenshots, fonts, videos). Best-effort — any failure leaves the
 * original zip untouched and never fails the run.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { redactSecrets } from './env.js';

export interface TraceScrubResult {
  scrubbed: boolean;
  entriesScrubbed: number;
}

export async function scrubTraceSecrets(traceZipPath: string, secrets: string[]): Promise<TraceScrubResult> {
  const live = [...new Set(secrets)].filter((s) => s.length > 0);
  if (live.length === 0) return { scrubbed: false, entriesScrubbed: 0 };
  let raw: Buffer;
  try {
    raw = await readFile(traceZipPath);
  } catch {
    return { scrubbed: false, entriesScrubbed: 0 };
  }
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(raw));
  } catch {
    return { scrubbed: false, entriesScrubbed: 0 };
  }
  let count = 0;
  for (const [name, data] of Object.entries(entries)) {
    let text: string;
    try {
      text = strFromU8(data);
      // Round-trip guard: only touch entries that decode to the exact bytes
      // (fflate replaces invalid sequences — those entries stay untouched).
      if (Buffer.from(strToU8(text)).length !== data.length) continue;
    } catch {
      continue; // binary entry — leave byte-identical
    }
    if (!live.some((s) => text.includes(s))) continue;
    entries[name] = strToU8(redactSecrets(text, live));
    count += 1;
  }
  if (count === 0) return { scrubbed: false, entriesScrubbed: 0 };
  try {
    await writeFile(traceZipPath, Buffer.from(zipSync(entries)));
  } catch {
    return { scrubbed: false, entriesScrubbed: 0 };
  }
  return { scrubbed: true, entriesScrubbed: count };
}
