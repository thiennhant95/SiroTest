/**
 * ai-provider.ts — server-side AI wiring for P2 routes (routes/ai.ts).
 *
 * - {@link getAIProvider} selects the LLM provider when `AI_API_KEY` is set
 *   (or `AI_PROVIDER=kilo` for the keyless Kilo free tier), otherwise the
 *   deterministic rule provider (never fakes AI).
 * - {@link loadProjectSecrets} + {@link redactForLLM} guarantee secret values
 *   and absolute server paths are stripped BEFORE any text is sent to an LLM.
 */
import { providerStatus, selectProvider, type AIProvider } from '@vv/ai';
import { db } from './db.js';
import { decryptSecret, redactSecretsText, stripServerPaths } from './security.js';

export function getAIProvider(): AIProvider {
  return selectProvider();
}

/** Safe for GET /ai/status — engine/provider/model only, never the key. */
export function aiStatus(): { engine: 'rules' | 'llm'; provider: string; model?: string } {
  return providerStatus(getAIProvider());
}

/**
 * Load plaintext secret values for a project (+ optional environment) so
 * failure text can be redacted before it reaches an LLM. Returns [] on any
 * error (redaction degrades to path-stripping, never throws the route).
 * The plaintext values never leave this module except into redactForLLM.
 */
export async function loadProjectSecrets(projectId: string, environmentId?: string): Promise<string[]> {
  try {
    const rows = await db().variable.findMany({
      where: {
        projectId,
        isSecret: true,
        ...(environmentId !== undefined ? { environmentId } : {}),
      },
      select: { valueEncrypted: true },
    });
    const out: string[] = [];
    for (const r of rows) {
      try {
        const plain = decryptSecret(r.valueEncrypted);
        if (plain) out.push(plain);
      } catch {
        /* undecryptable cell — skip, do not fail the route */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Redact secret values, then strip absolute server paths. */
export function redactForLLM(text: string, secrets: string[]): string {
  return stripServerPaths(redactSecretsText(text, secrets));
}
