/** Minimal ZIP (stored, no compression) writer — avoids a heavy dep for Day 7 export. */

function crc32(data: Uint8Array): number {
  let table = (crc32 as unknown as { t?: Uint32Array }).t;
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    (crc32 as unknown as { t: Uint32Array }).t = table;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();

function dosTime(): number {
  const d = new Date();
  return (
    ((d.getHours() << 11) |
      (d.getMinutes() << 5) |
      (d.getSeconds() >> 1)) >>>
    0
  );
}
function dosDate(): number {
  const d = new Date();
  return ((((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) >>> 0);
}

export function buildZip(files: Record<string, string>): Blob {
  const names = Object.keys(files);
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const pushU16 = (arr: number[], v: number) => {
    arr.push(v & 0xff, (v >> 8) & 0xff);
  };
  const pushU32 = (arr: number[], v: number) => {
    arr.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
  };

  for (const name of names) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(files[name] ?? "");
    const crc = crc32(data);
    const head: number[] = [];
    // local file header
    pushU32(head, 0x04034b50);
    pushU16(head, 20);
    pushU16(head, 0);
    pushU16(head, 0); // stored
    pushU16(head, dosTime());
    pushU16(head, dosDate());
    pushU32(head, crc);
    pushU32(head, data.length);
    pushU32(head, data.length);
    pushU16(head, nameBytes.length);
    pushU16(head, 0);
    const header = new Uint8Array([...head, ...nameBytes]);
    chunks.push(header, data);

    const cen: number[] = [];
    pushU32(cen, 0x02014b50);
    pushU16(cen, 20);
    pushU16(cen, 20);
    pushU16(cen, 0);
    pushU16(cen, 0);
    pushU16(cen, dosTime());
    pushU16(cen, dosDate());
    pushU32(cen, crc);
    pushU32(cen, data.length);
    pushU32(cen, data.length);
    pushU16(cen, nameBytes.length);
    pushU16(cen, 0);
    pushU16(cen, 0);
    pushU16(cen, 0);
    pushU16(cen, 0);
    pushU32(cen, 0);
    pushU32(cen, offset);
    central.push(new Uint8Array([...cen, ...nameBytes]));
    offset += header.length + data.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end: number[] = [];
  pushU32(end, 0x06054b50);
  pushU16(end, 0);
  pushU16(end, 0);
  pushU16(end, names.length);
  pushU16(end, names.length);
  pushU32(end, centralSize);
  pushU32(end, offset);
  pushU16(end, 0);

  return new Blob(
    [...chunks, ...central, new Uint8Array(end)] as BlobPart[],
    { type: "application/zip" },
  );
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function specZipFiles(testName: string, code: string): Record<string, string> {
  const safe = testName.replace(/[^\w\-âuàảãạăêôơđ ]/gi, "").trim() || "test";
  return {
    [`${safe}.spec.ts`]: code,
    "package.json": JSON.stringify(
      {
        name: "studio-export",
        version: "1.0.0",
        private: true,
        scripts: { test: "playwright test" },
        devDependencies: { "@playwright/test": "^1.49.0" },
      },
      null,
      2,
    ),
    "playwright.config.ts": `import { defineConfig } from '@playwright/test';\n\nexport default defineConfig({\n  testDir: '.',\n  use: { trace: 'on-first-retry', screenshot: 'only-on-failure' },\n});\n`,
    "README.txt":
      `Run the exported test:\n  npm install\n  npx playwright install chromium\n  npx playwright test\n\nRuns with stock @playwright/test, no Studio needed.\n`,
  };
}
