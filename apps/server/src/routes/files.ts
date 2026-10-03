import type { FastifyInstance, FastifyRequest } from 'fastify';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertSafePath, storageRoot } from '@playwright-studio/runner';
import { db } from '../db.js';
import { requireAuth, requireProjectAccess } from '../auth.js';
import { ApiError } from '../errors.js';
import { parseOrThrow, fileUpload } from '../schemas.js';

/**
 * P1 wave-2 — file library for upload steps.
 *
 * - Upload is plain JSON { name, contentBase64, mimeType? } (Fastify has no
 *   multipart pre-wired; JSON keeps the 1 MB default body discipline except
 *   on this route, which opts into an 11 MB bodyLimit for the 10 MB/file cap).
 * - Caps: 10 MB decoded per file, 100 MB total per project (explicit 400).
 * - Filenames are sanitized (no dirs, no traversal, header-safe); bytes land
 *   in `storage/files/<fileId>-<safe>` and the DB keeps a storage-RELATIVE
 *   path only (absolute server paths never reach clients).
 * - DELETE is guarded: a file referenced by any test definition (`fileId`
 *   field, found by recursive JSON scan) cannot be removed (409 FILE_IN_USE).
 * - `resolveFilePaths()` maps fileIds → absolute disk paths for the runner.
 */

export const FILE_MAX_BYTES = 10 * 1024 * 1024;
export const PROJECT_FILES_MAX_BYTES = 100 * 1024 * 1024;
/** Route bodyLimit: base64 inflates ~4/3, plus JSON framing headroom. */
export const FILE_UPLOAD_BODY_LIMIT = 12 * 1024 * 1024;

export function sanitizeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').slice(0, 120);
  const trimmed = cleaned.replace(/^[._]+/, '').replace(/[. ]+$/, '');
  if (!trimmed) throw new ApiError('VALIDATION_ERROR', `Invalid file name "${raw}"`, 400);
  return trimmed;
}

/** Shared with transfer.ts (project import reuses the upload validation). */
export function decodeFileBase64ForImport(contentBase64: string, _name: string): Buffer {
  return decodeBase64(contentBase64);
}

function decodeBase64(contentBase64: string): Buffer {
  const compact = contentBase64.replace(/\s+/g, '');
  if (compact.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new ApiError('VALIDATION_ERROR', 'contentBase64 must be valid base64', 400);
  }
  const buf = Buffer.from(compact, 'base64');
  if (buf.length === 0) throw new ApiError('VALIDATION_ERROR', 'contentBase64 decodes to empty content', 400);
  if (buf.length > FILE_MAX_BYTES) {
    throw new ApiError('VALIDATION_ERROR', `file is ${buf.length} bytes (max ${FILE_MAX_BYTES})`, 400);
  }
  return buf;
}

type Sniffed = 'png' | 'jpeg' | 'gif' | 'pdf' | 'zip' | null;

/** Minimal magic-byte sniff (known binaries only; everything else is opaque). */
export function sniffKind(buf: Buffer): Sniffed {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'gif';
  if (buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'pdf';
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) return 'zip';
  return null;
}

const MIME_BY_KIND: Record<Exclude<Sniffed, null>, string[]> = {
  png: ['image/png'],
  jpeg: ['image/jpeg', 'image/jpg'],
  gif: ['image/gif'],
  pdf: ['application/pdf'],
  zip: ['application/zip', 'application/x-zip-compressed'],
};

/**
 * Light magic check: when the bytes are a known binary AND the caller
 * declared a concrete mime, the two must agree (else explicit 400).
 * Generic/unknown declarations (octet-stream, text/*, …) always pass.
 */
export function assertMagicMatches(buf: Buffer, mimeType: string | undefined): string {
  const kind = sniffKind(buf);
  if (!mimeType) return kind ? MIME_BY_KIND[kind]![0]! : 'application/octet-stream';
  if (!/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(mimeType)) {
    throw new ApiError('VALIDATION_ERROR', `mimeType "${mimeType}" must look like type/subtype`, 400);
  }
  if (kind && mimeType !== 'application/octet-stream') {
    const allowed = MIME_BY_KIND[kind]!;
    const familyOk =
      (kind === 'zip' && mimeType.endsWith('+zip')) ||
      (kind === 'jpeg' && mimeType.startsWith('image/'));
    if (!allowed.includes(mimeType.toLowerCase()) && !familyOk) {
      throw new ApiError(
        'VALIDATION_ERROR',
        `content magic looks like ${kind} (${allowed[0]}) but mimeType is "${mimeType}"`,
        400,
      );
    }
  }
  return mimeType;
}

function filesDir(): string {
  return join(storageRoot(), 'files');
}

async function requireAccessToProject(req: FastifyRequest, projectId: string): Promise<void> {
  if (!req.user) throw new ApiError('UNAUTHORIZED', 'Missing credentials', 401);
  const userRow = await db().user.findUnique({ where: { id: req.user.id } });
  if (userRow?.role === 'admin') return;
  const member = await db().projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: req.user.id } },
  });
  if (!member) throw new ApiError('FORBIDDEN', `No access to project ${projectId}`, 403);
}

/** Test ids whose definition references this file (recursive `fileId` scan). */
export async function findReferencingFileTests(projectId: string, fileId: string): Promise<string[]> {
  const tests = await db().test.findMany({ where: { projectId }, select: { id: true, definitionJson: true } });
  const hits: string[] = [];
  const walk = (node: unknown): boolean => {
    if (typeof node === 'string') return node === fileId;
    if (Array.isArray(node)) return node.some(walk);
    if (node && typeof node === 'object') {
      return Object.entries(node).some(([k, v]) => (k === 'fileId' ? v === fileId : walk(v)));
    }
    return false;
  };
  for (const t of tests) {
    try {
      if (walk(JSON.parse(t.definitionJson))) hits.push(t.id);
    } catch {
      // Corrupt definitions are another route's problem; ignore here.
    }
  }
  return hits;
}

export type FileMeta = {
  id: string;
  projectId: string;
  name: string;
  mimeType: string | null;
  sizeBytes: number;
  path: string;
  createdBy: string;
  createdAt: Date;
};

/**
 * Runner-side helper: map fileIds → absolute disk paths (project-scoped).
 * Throws when an id is missing, foreign, or its bytes are gone from disk.
 */
export async function resolveFilePaths(
  projectId: string,
  fileIds: string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const fid of fileIds) {
    const row = await db().fileAsset.findUnique({ where: { id: fid } });
    if (!row || row.projectId !== projectId) {
      throw new Error(`File ${fid} not found in project ${projectId}`);
    }
    const abs = assertSafePath(storageRoot(), row.path);
    try {
      await stat(abs);
    } catch {
      throw new Error(`File ${fid} bytes are missing from storage (${row.path})`);
    }
    out[fid] = abs;
  }
  return out;
}

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  // List metadata only (never content bytes).
  app.get('/projects/:projectId/files', { preHandler: requireAuth }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    await requireProjectAccess(req);
    return db().fileAsset.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } });
  });

  app.post(
    '/projects/:projectId/files',
    { preHandler: requireAuth, bodyLimit: FILE_UPLOAD_BODY_LIMIT },
    async (req, reply) => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAccess(req);
      const project = await db().project.findUnique({ where: { id: projectId } });
      if (!project) throw new ApiError('NOT_FOUND', `Project ${projectId} not found`, 404);
      const body = parseOrThrow(fileUpload, req.body);
      const safe = sanitizeFileName(body.name);
      const buf = decodeBase64(body.contentBase64);
      const mime = assertMagicMatches(buf, body.mimeType);
      const used = await db().fileAsset.aggregate({
        where: { projectId },
        _sum: { sizeBytes: true },
      });
      if ((used._sum.sizeBytes ?? 0) + buf.length > PROJECT_FILES_MAX_BYTES) {
        throw new ApiError(
          'VALIDATION_ERROR',
          `project file library would exceed ${PROJECT_FILES_MAX_BYTES} bytes — delete unused files first`,
          400,
        );
      }
      const created = await db().fileAsset.create({
        data: {
          projectId,
          name: safe,
          mimeType: mime,
          sizeBytes: buf.length,
          path: 'files/pending',
          createdBy: req.user!.id,
        },
      });
      const rel = `files/${created.id}-${safe}`;
      await mkdir(filesDir(), { recursive: true });
      await writeFile(assertSafePath(storageRoot(), rel), buf);
      const saved = (await db().fileAsset.update({
        where: { id: created.id },
        data: { path: rel },
      })) as FileMeta;
      return reply.code(201).send(saved);
    },
  );

  app.get('/files/:fid/download', { preHandler: requireAuth }, async (req, reply) => {
    const { fid } = req.params as { fid: string };
    const row = (await db().fileAsset.findUnique({ where: { id: fid } })) as FileMeta | null;
    if (!row) throw new ApiError('NOT_FOUND', `File ${fid} not found`, 404);
    await requireAccessToProject(req, row.projectId);
    let bytes: Buffer;
    try {
      bytes = await readFile(assertSafePath(storageRoot(), row.path));
    } catch {
      throw new ApiError('NOT_FOUND', `File ${fid} bytes are missing from storage`, 404);
    }
    const safe = sanitizeFileName(row.name);
    return reply
      .header('content-type', row.mimeType ?? 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${safe}"`)
      .header('content-length', bytes.length)
      .send(bytes);
  });

  app.delete('/files/:fid', { preHandler: requireAuth }, async (req, reply) => {
    const { fid } = req.params as { fid: string };
    const row = (await db().fileAsset.findUnique({ where: { id: fid } })) as FileMeta | null;
    if (!row) throw new ApiError('NOT_FOUND', `File ${fid} not found`, 404);
    await requireAccessToProject(req, row.projectId);
    const referencing = await findReferencingFileTests(row.projectId, fid);
    if (referencing.length > 0) {
      throw new ApiError(
        'FILE_IN_USE',
        `File ${fid} is referenced by ${referencing.length} test(s) — remove the fileId reference(s) first`,
        409,
        { testIds: referencing },
      );
    }
    await db().fileAsset.delete({ where: { id: fid } });
    try {
      await unlink(assertSafePath(storageRoot(), row.path));
    } catch {
      // DB row is gone; a missing byte file needs no further action.
    }
    return reply.code(204).send();
  });
}
