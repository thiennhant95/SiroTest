/**
 * P2 visual regression — pure PNG codec + pixel diff (NO new dependencies).
 *
 * Design decision (PNG decode/diff approach):
 * - Node has no built-in PNG decoder, and the task allows either adding
 *   `pngjs` to packages/reporter OR a minimal self-written implementation.
 *   We chose self-written (~200 lines) inside apps/runner because:
 *    1. zero new dependencies (no lockfile churn, no supply-chain surface),
 *    2. Playwright screenshots are always non-interlaced 8-bit RGB/RGBA, so
 *       supporting color types 2/6 + bit depth 8 + filters 0-4 is sufficient
 *       (anything else fails EXPLICITLY with VISUAL_FORMAT_UNSUPPORTED),
 *    3. the same functions run in two places: the runner process (unit
 *       tested) AND the isolated Playwright workdir (which has no
 *       node_modules of its own).
 * - Workdir delivery: `visualHelperSource()` serializes these exact functions
 *   via `fn.toString()` into `vv-visual-compare.cjs`. Therefore every helper
 *   below MUST stay self-contained: no top-level imports, no closures over
 *   module scope — only lazy `require('node:...')` calls and globals
 *   (`Buffer`, `process`) inside function bodies. `visual-p2.test.mjs`
 *   round-trips the serialized helper (write temp .cjs -> require -> compare)
 *   so serialization drift fails loudly.
 *
 * Diff semantics: a pixel differs when ANY channel differs; ratio =
 * diffPixels / totalPixels; failure when ratio > threshold. Dimension
 * mismatches fail explicitly (VISUAL_SIZE_MISMATCH) — never silently scaled.
 */

export const VISUAL_DEFAULT_THRESHOLD = 0.05;

/** Deterministic artifact filename for a baseline name (mirrors the package compiler). */
export function vvSanitizeVisualFileName(name: string): string {
  const safe = String(name).replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 120);
  return `visual-${safe.length > 0 ? safe : 'check'}.png`;
}

/** Diff artifact next to the actual screenshot. */
export function vvDiffFileName(actualPath: string): string {
  return /\.png$/i.test(actualPath)
    ? actualPath.replace(/\.png$/i, '.diff.png')
    : `${actualPath}.diff.png`;
}

export function sanitizeVisualFileName(name: string): string {
  return vvSanitizeVisualFileName(name);
}

/** Light IHDR dimension read (magic + width/height only, no inflate). */
export function vvReadPngDimensions(png: Buffer): { width: number; height: number } {
  assertPngSignature(png);
  if (png.length < 33) throw new Error('VISUAL_FORMAT_UNSUPPORTED: PNG too short for IHDR');
  if (png.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('VISUAL_FORMAT_UNSUPPORTED: first chunk is not IHDR');
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

export function readPngDimensions(png: Buffer): { width: number; height: number } {
  return vvReadPngDimensions(png);
}

function assertPngSignature(png: Buffer): void {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!png || png.length < 8 || !sig.every((b, i) => png[i] === b)) {
    throw new Error('VISUAL_FORMAT_UNSUPPORTED: not a PNG file (bad signature)');
  }
}

function vvCrc32Table(): number[] {
  const table: number[] = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

function vvCrc32(buf: Buffer, table: number[]): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function vvChunk(type: string, data: Buffer): Buffer {
  const table = vvCrc32Table();
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(vvCrc32(Buffer.concat([typeBuf, data]), table), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Decode an 8-bit non-interlaced RGB/RGBA PNG to RGBA pixels. */
export function vvDecodePng(png: Buffer): { width: number; height: number; data: Buffer } {
  assertPngSignature(png);
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (pos + 8 <= png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString('ascii', pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = png.readUInt32BE(pos + 8);
      height = png.readUInt32BE(pos + 12);
      bitDepth = png[pos + 16]!;
      colorType = png[pos + 17]!;
      const interlace = png[pos + 20]!;
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(
          `VISUAL_FORMAT_UNSUPPORTED: only 8-bit RGB/RGBA PNGs are supported (got bitDepth=${bitDepth} colorType=${colorType})`,
        );
      }
      if (interlace !== 0) throw new Error('VISUAL_FORMAT_UNSUPPORTED: interlaced PNGs are not supported');
      if (width <= 0 || height <= 0 || width > 16384 || height > 16384) {
        throw new Error(`VISUAL_FORMAT_UNSUPPORTED: implausible dimensions ${width}x${height}`);
      }
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (width === 0 || idat.length === 0) throw new Error('VISUAL_FORMAT_UNSUPPORTED: PNG has no IHDR/IDAT');
  const z = require('node:zlib') as typeof import('node:zlib');
  const raw = z.inflateSync(Buffer.concat(idat));
  const channels = colorType === 2 ? 3 : 4;
  const stride = width * channels;
  if (raw.length !== height * (stride + 1)) {
    throw new Error('VISUAL_FORMAT_UNSUPPORTED: IDAT size does not match IHDR dimensions');
  }
  const out = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++]!;
    const row = Buffer.alloc(stride);
    const bpp = channels;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      const filt = raw[p++]!;
      let v: number;
      if (filter === 0) v = filt;
      else if (filter === 1) v = (filt + a) & 0xff;
      else if (filter === 2) v = (filt + b) & 0xff;
      else if (filter === 3) v = (filt + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        v = (filt + pr) & 0xff;
      } else {
        throw new Error(`VISUAL_FORMAT_UNSUPPORTED: unknown filter ${filter}`);
      }
      row[i] = v;
    }
    row.copy(prev);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      out[o] = row[x * channels]!;
      out[o + 1] = row[x * channels + 1]!;
      out[o + 2] = row[x * channels + 2]!;
      out[o + 3] = channels === 4 ? row[x * channels + 3]! : 255;
    }
  }
  return { width, height, data: out };
}

export function decodePngImage(png: Buffer): { width: number; height: number; data: Buffer } {
  return vvDecodePng(png);
}

/** Encode RGBA pixels as an 8-bit non-interlaced RGBA PNG (filter 0). */
export function vvEncodePng(width: number, height: number, rgba: Buffer): Buffer {
  const z = require('node:zlib') as typeof import('node:zlib');
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.subarray(y * stride, (y + 1) * stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    vvChunk('IHDR', ihdr),
    vvChunk('IDAT', z.deflateSync(raw)),
    vvChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function encodePngImage(width: number, height: number, rgba: Buffer): Buffer {
  return vvEncodePng(width, height, rgba);
}

export interface VisualDiff {
  diffPixels: number;
  totalPixels: number;
  ratio: number;
  /** RGBA diff image (diff pixels in red, same pixels dimmed). */
  diff: Buffer;
}

/** Pixel diff of two decoded frames (dimensions must already match). */
export function vvDiffImages(
  a: { width: number; height: number; data: Buffer },
  b: { width: number; height: number; data: Buffer },
): VisualDiff {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(
      `VISUAL_SIZE_MISMATCH: actual is ${a.width}x${a.height} but baseline is ${b.width}x${b.height} (re-capture the baseline instead of scaling silently)`,
    );
  }
  const totalPixels = a.width * a.height;
  const diff = Buffer.alloc(a.data.length);
  let diffPixels = 0;
  for (let i = 0; i < totalPixels; i++) {
    const o = i * 4;
    const differs =
      a.data[o] !== b.data[o] ||
      a.data[o + 1] !== b.data[o + 1] ||
      a.data[o + 2] !== b.data[o + 2] ||
      a.data[o + 3] !== b.data[o + 3]!;
    if (differs) {
      diffPixels++;
      diff[o] = 255;
      diff[o + 1] = 0;
      diff[o + 2] = 0;
      diff[o + 3] = 255;
    } else {
      diff[o] = (a.data[o]! * 0.4) | 0;
      diff[o + 1] = (a.data[o + 1]! * 0.4) | 0;
      diff[o + 2] = (a.data[o + 2]! * 0.4) | 0;
      diff[o + 3] = 255;
    }
  }
  return { diffPixels, totalPixels, ratio: totalPixels === 0 ? 0 : diffPixels / totalPixels, diff };
}

export function diffPngImages(
  a: { width: number; height: number; data: Buffer },
  b: { width: number; height: number; data: Buffer },
): VisualDiff {
  return vvDiffImages(a, b);
}

/** Buffer-level compare (no env/filesystem) — used by unit tests and the server promote path. */
export function compareVisualBuffers(
  actual: Buffer,
  baseline: Buffer,
  threshold: number,
): { diffPixels: number; totalPixels: number; ratio: number; diffPng: Buffer | null } {
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(`VISUAL_THRESHOLD_INVALID: threshold must be a number in [0, 1] (got ${String(threshold)})`);
  }
  const a = vvDecodePng(actual);
  const b = vvDecodePng(baseline);
  const { diffPixels, totalPixels, ratio, diff } = vvDiffImages(a, b);
  if (ratio <= threshold) return { diffPixels, totalPixels, ratio, diffPng: null };
  return { diffPixels, totalPixels, ratio, diffPng: vvEncodePng(a.width, a.height, diff) };
}

export interface VisualCheckResult {
  updated: boolean;
  diffPixels: number;
  totalPixels: number;
  ratio: number;
  diffPath?: string;
}

/**
 * Workdir entrypoint (called from generated specs AND the visual stub):
 * compare one actual screenshot against the injected baseline map.
 *
 * - `VV_BASELINES`: JSON name -> absolute baseline path (runner injects).
 * - `VV_UPDATE_BASELINES=1`: capture mode — pass, the server promotes the
 *   actual artifact to a baseline afterwards (POST /tests/:id/baselines).
 * - Missing baseline (without update mode) fails with
 *   VISUAL_BASELINE_MISSING (first runs must capture explicitly, never
 *   silently adopt whatever the page shows).
 * - Over-threshold diffs write `<actual>.diff.png` next to the actual file
 *   (auto-collected as a run artifact) and throw VISUAL_DIFF_EXCEEDED with
 *   the {diffPixels, totalPixels, ratio} metrics in the message.
 */
export function compareVisualFromEnv(opts: { name: string; actualPath: string; threshold: number }): VisualCheckResult {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const { name, actualPath, threshold } = opts;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(`VISUAL_THRESHOLD_INVALID: threshold must be a number in [0, 1] (got ${String(threshold)})`);
  }
  let baselines: Record<string, string>;
  try {
    baselines = JSON.parse(process.env.VV_BASELINES ?? '{}') as Record<string, string>;
  } catch {
    throw new Error('VISUAL_BASELINES_INVALID: VV_BASELINES is not valid JSON (runner injects name -> absolute-path map)');
  }
  let actual: Buffer;
  try {
    actual = fs.readFileSync(actualPath);
  } catch {
    throw new Error(`VISUAL_ACTUAL_MISSING: actual screenshot not found at ${actualPath} (screenshot step failed before compare?)`);
  }
  if (process.env.VV_UPDATE_BASELINES === '1') {
    return { updated: true, diffPixels: 0, totalPixels: 0, ratio: 0 };
  }
  const baselinePath = baselines[name];
  if (typeof baselinePath !== 'string' || baselinePath.length === 0) {
    throw new Error(
      `VISUAL_BASELINE_MISSING: no baseline for visualCheck "${name}" — re-run with updateBaselines to capture it explicitly`,
    );
  }
  let baseline: Buffer;
  try {
    baseline = fs.readFileSync(baselinePath);
  } catch {
    throw new Error(`VISUAL_BASELINE_UNREADABLE: baseline file for "${name}" cannot be read (${baselinePath})`);
  }
  const { diffPixels, totalPixels, ratio, diffPng } = compareVisualBuffers(actual, baseline, threshold);
  if (diffPng === null) return { updated: false, diffPixels, totalPixels, ratio };
  const diffPath = vvDiffFileName(actualPath);
  fs.writeFileSync(diffPath, diffPng);
  const pct = (ratio * 100).toFixed(2);
  const allowed = (threshold * 100).toFixed(2);
  throw new Error(
    `VISUAL_DIFF_EXCEEDED: visualCheck "${name}": ${diffPixels}/${totalPixels} pixels differ (${pct}% > allowed ${allowed}%); diff: ${path.basename(diffPath)}`,
  );
}

/**
 * Self-contained CJS source for the isolated workdir (`vv-visual-compare.cjs`).
 * Built by serializing the exact functions above — the round-trip test in
 * apps/runner/tests/visual-p2.test.mjs guarantees the serialized helper
 * behaves identically to the runner-side implementation.
 */
export function visualHelperSource(): string {
  const fns = [
    vvSanitizeVisualFileName,
    vvDiffFileName,
    vvReadPngDimensions,
    assertPngSignature,
    vvCrc32Table,
    vvCrc32,
    vvChunk,
    vvDecodePng,
    vvEncodePng,
    vvDiffImages,
    compareVisualBuffers,
    compareVisualFromEnv,
  ];
  return [
    `'use strict';`,
    `// Generated by @playwright-studio/runner (visualHelperSource) — do not edit.`,
    `// P2 visual regression helper: self-contained PNG decode/diff (no dependencies).`,
    ...fns.map((f) => f.toString()),
    `module.exports = { compareVisualFromEnv, compareVisualBuffers, vvDecodePng, vvEncodePng, vvDiffImages, vvReadPngDimensions, vvSanitizeVisualFileName, vvDiffFileName };`,
    ``,
  ].join('\n');
}
