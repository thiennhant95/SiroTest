import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';
import { ApiError } from '../errors.js';
import { datasetImport, parseOrThrow } from '../schemas.js';
import { DEFINITION_JSON_MAX_BYTES } from '../security.js';
import { DatasetParseError, parseDatasetImport } from '../csv.js';

/** Max rows per embedded dataset (mirrors test-model zod cap of 500). */
export const MAX_DATASET_ROWS = 500;

interface EmbeddedDataSet {
  id: string;
  name: string;
  rows: Record<string, string>[];
}

function readDefinition(test: { definitionJson: string }): {
  raw: Record<string, unknown>;
  datasets: EmbeddedDataSet[];
} {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(test.definitionJson) as Record<string, unknown>;
  } catch {
    throw new ApiError('VALIDATION_ERROR', 'Stored test definition is not valid JSON', 500);
  }
  const datasets = Array.isArray(raw['datasets'])
    ? (raw['datasets'] as EmbeddedDataSet[])
    : [];
  return { raw, datasets };
}

async function persistDatasets(
  testId: string,
  userId: string,
  raw: Record<string, unknown>,
  datasets: EmbeddedDataSet[],
  changeMessage: string,
): Promise<Record<string, unknown>> {
  const next = { ...raw, datasets };
  let size = 0;
  try {
    size = Buffer.byteLength(JSON.stringify(next), 'utf8');
  } catch {
    throw new ApiError('VALIDATION_ERROR', 'Definition is not JSON-serializable', 400);
  }
  if (size > DEFINITION_JSON_MAX_BYTES) {
    throw new ApiError(
      'VALIDATION_ERROR',
      `definition would be ${size} bytes (max ${DEFINITION_JSON_MAX_BYTES}) — delete a dataset or split the test`,
      400,
    );
  }
  const definitionJson = JSON.stringify(next);
  const updated = await db().test.update({ where: { id: testId }, data: { definitionJson } });
  const latest = await db().testVersion.findMany({
    where: { testId }, orderBy: { versionNumber: 'desc' }, take: 1,
  });
  await db().testVersion.create({
    data: {
      testId, versionNumber: (latest[0]?.versionNumber ?? 0) + 1,
      definitionJson, createdBy: userId, changeMessage,
    },
  });
  return { ...updated, definitionJson: next };
}

export async function datasetRoutes(app: FastifyInstance): Promise<void> {
  // POST /tests/:id/datasets/import { format: csv|json, name?, content }
  // Parses the payload and appends it to the definition-embedded `datasets`
  // (no separate table — same PATCH-definition semantics as variables UX).
  // An existing dataset with the same name gains the new rows (cap-checked).
  app.post('/tests/:id/datasets/import', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseOrThrow(datasetImport, req.body);
    let rows: Record<string, string>[];
    try {
      rows = parseDatasetImport(body.format, body.content);
    } catch (err) {
      const message = err instanceof DatasetParseError ? err.message : String(err);
      throw new ApiError('VALIDATION_ERROR', `Dataset import failed: ${message}`, 400);
    }
    if (rows.length === 0) {
      throw new ApiError('VALIDATION_ERROR', 'Dataset import failed: no data rows found (header only?)', 400);
    }
    const test = await db().test.findUnique({ where: { id } });
    if (!test) throw new ApiError('NOT_FOUND', `Test ${id} not found`, 404);
    const { raw, datasets } = readDefinition(test);
    const name = body.name?.trim() || `dataset-${datasets.length + 1}`;
    const existing = datasets.find((d) => d.name === name);
    // Column-shape guard when appending: new rows must carry the same columns.
    if (existing) {
      const cols = Object.keys(existing.rows[0] ?? {}).sort();
      const incoming = Object.keys(rows[0] ?? {}).sort();
      if (cols.join('|') !== incoming.join('|')) {
        throw new ApiError(
          'VALIDATION_ERROR',
          `Dataset import failed: columns [${incoming.join(', ')}] do not match existing dataset '${name}' [${cols.join(', ')}]`,
          400,
        );
      }
      if (existing.rows.length + rows.length > MAX_DATASET_ROWS) {
        throw new ApiError(
          'VALIDATION_ERROR',
          `Dataset import failed: '${name}' would hold ${existing.rows.length + rows.length} rows (max ${MAX_DATASET_ROWS})`,
          400,
        );
      }
      existing.rows.push(...rows);
    } else {
      if (rows.length > MAX_DATASET_ROWS) {
        throw new ApiError(
          'VALIDATION_ERROR',
          `Dataset import failed: ${rows.length} rows (max ${MAX_DATASET_ROWS})`,
          400,
        );
      }
      datasets.push({ id: `ds_${nanoid(8)}`, name, rows });
    }
    const saved = await persistDatasets(
      id, req.user!.id, raw, datasets,
      `dataset import (${body.format}, ${rows.length} rows → '${name}')`,
    );
    return reply.code(201).send({
      dataset: datasets.find((d) => d.name === name)!,
      definitionJson: saved['definitionJson'],
    });
  });

  // DELETE /tests/:id/datasets/:dsid — remove one embedded dataset.
  app.delete('/tests/:id/datasets/:dsid', { preHandler: requireAuth }, async (req, reply) => {
    const { id, dsid } = req.params as { id: string; dsid: string };
    const test = await db().test.findUnique({ where: { id } });
    if (!test) throw new ApiError('NOT_FOUND', `Test ${id} not found`, 404);
    const { raw, datasets } = readDefinition(test);
    const idx = datasets.findIndex((d) => d.id === dsid);
    if (idx === -1) throw new ApiError('NOT_FOUND', `Dataset ${dsid} not found`, 404);
    const [removed] = datasets.splice(idx, 1);
    const saved = await persistDatasets(
      id, req.user!.id, raw, datasets, `dataset delete ('${removed.name}')`,
    );
    return reply.code(200).send({ deleted: removed.id, definitionJson: saved['definitionJson'] });
  });
}
