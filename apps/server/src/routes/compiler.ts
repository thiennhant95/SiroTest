import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth.js';
import { ApiError } from '../errors.js';
import { db } from '../db.js';
import { sanitizeExportFilename } from '../security.js';

const SUPPORTED_STEPS = new Set([
  'goto', 'reload', 'goBack', 'goForward',
  'click', 'doubleClick', 'fill', 'clear', 'press', 'check', 'uncheck',
  'select', 'hover', 'waitForElement', 'waitForTimeout', 'waitForURL',
  'assertVisible', 'assertHidden', 'assertText', 'assertContainsText',
  'assertValue', 'assertURL', 'assertTitle', 'assertEnabled',
  'assertDisabled', 'assertChecked', 'screenshot',
]);

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Compile a `{{VAR}}`-templated string to a TS expression.
 * - `{{NAME}}` refs become runtime `process.env` lookups (secrets never inlined).
 * - Pure literals are inlined escaped (they are non-secret by construction;
 *   secret fill values MUST use {{VAR}} refs, enforced below).
 */
function templateExpr(template: string): string {
  const re = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
  if (!re.test(template)) return `'${esc(template)}'`;
  re.lastIndex = 0;
  const parts: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) {
    if (m.index > last) parts.push(`'${esc(template.slice(last, m.index))}'`);
    parts.push(`(process.env['${m[1]}'] ?? '')`);
    last = m.index + m[0].length;
  }
  if (last < template.length) parts.push(`'${esc(template.slice(last))}'`);
  return parts.join(' + ');
}

/** Secret fill values must be {{VAR}} references — never inlined into code. */
function valueExpr(s: Record<string, unknown>): string {
  const value = String(s['value'] ?? '');
  if (s['sensitive'] === true && !/\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}/.test(value)) {
    throw new ApiError(
      'COMPILER_UNSUPPORTED_STEP',
      `Sensitive fill value must be a {{VARIABLE}} reference so the secret is resolved at run time, never inlined`,
      422,
      { step: s },
    );
  }
  return templateExpr(value);
}

function locatorExpr(target: Record<string, unknown> | null | undefined): string {
  if (!target) return `page.locator('body')`;
  const primary = (target as { primary?: Record<string, unknown> }).primary ?? target;
  const st = primary['strategy'];
  switch (st) {
    case 'role': return `page.getByRole('${esc(String(primary['role']))}'${primary['name'] ? `, { name: '${esc(String(primary['name']))}' }` : ''})`;
    case 'label': return `page.getByLabel('${esc(String(primary['value']))}')`;
    case 'placeholder': return `page.getByPlaceholder('${esc(String(primary['value']))}')`;
    case 'testId': return `page.getByTestId('${esc(String(primary['value']))}')`;
    case 'text': return `page.getByText('${esc(String(primary['value']))}')`;
    case 'css':
    case 'xpath': return `page.locator('${esc(String(primary['value']))}')`;
    default: return `page.locator('body')`;
  }
}

/** Minimal P0 compiler (full version lives in packages/playwright-compiler). */
export function compileDefinition(def: { steps?: Array<Record<string, unknown>>; name?: string }): string {
  const steps = def.steps ?? [];
  const lines: string[] = [
    `import { test, expect } from '@playwright/test';`,
    ``,
    `test('${esc(String(def.name ?? 'recorded test'))}', async ({ page }) => {`,
  ];
  for (const s of steps) {
    if (s['enabled'] === false) continue;
    const type = String(s['type']);
    if (!SUPPORTED_STEPS.has(type)) {
      throw new ApiError('COMPILER_UNSUPPORTED_STEP', `Unsupported step type: ${type}`, 422, { step: s });
    }
    const loc = locatorExpr((s['target'] ?? null) as never);
    switch (type) {
      case 'goto': lines.push(`  await page.goto(process.env.BASE_URL ?? '${esc(String(s['url'] ?? '/'))}');`); break;
      case 'click': lines.push(`  await ${loc}.click();`); break;
      case 'doubleClick': lines.push(`  await ${loc}.dblclick();`); break;
      case 'fill': lines.push(`  await ${loc}.fill(${valueExpr(s)});`); break;
      case 'press': lines.push(`  await ${loc}.press('${esc(String(s['key'] ?? 'Enter'))}');`); break;
      case 'check': lines.push(`  await ${loc}.check();`); break;
      case 'uncheck': lines.push(`  await ${loc}.uncheck();`); break;
      case 'select': lines.push(`  await ${loc}.selectOption('${esc(String(s['value'] ?? ''))}');`); break;
      case 'assertVisible': lines.push(`  await expect(${loc}).toBeVisible();`); break;
      case 'assertText': lines.push(`  await expect(${loc}).toHaveText('${esc(String(s['expected'] ?? s['value'] ?? ''))}');`); break;
      default: lines.push(`  // TODO: ${type}`);
    }
  }
  lines.push(`});`);
  return lines.join('\n');
}

export async function compilerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/tests/:id/compile', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const test = await db().test.findUnique({ where: { id } });
    if (!test) throw new ApiError('NOT_FOUND', `Test ${id} not found`, 404);
    const def = JSON.parse(test.definitionJson) as { steps?: Array<Record<string, unknown>>; name?: string };
    const code = compileDefinition(def);
    return { testId: id, code };
  });

  app.get('/tests/:id/export', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { format } = req.query as { format?: string };
    if (format && format !== 'spec') {
      throw new ApiError('VALIDATION_ERROR', 'Only format=spec is supported in P0', 400);
    }
    const test = await db().test.findUnique({ where: { id } });
    if (!test) throw new ApiError('NOT_FOUND', `Test ${id} not found`, 404);
    const def = JSON.parse(test.definitionJson) as { steps?: Array<Record<string, unknown>>; name?: string };
    const code = compileDefinition(def);
    return reply
      .header('content-type', 'text/x-typescript')
      .header('content-disposition', `attachment; filename="${sanitizeExportFilename(id)}"`)
      .send(code);
  });
}
