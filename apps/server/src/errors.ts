/** Stable machine-readable error codes (api-spec: every write uses these). */
export const ErrorCodes = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT_RECORDER_ACTIVE: 'CONFLICT_RECORDER_ACTIVE',
  RECORDER_NOT_ACTIVE: 'RECORDER_NOT_ACTIVE',
  INVALID_STATE: 'INVALID_STATE',
  COMPILER_UNSUPPORTED_STEP: 'COMPILER_UNSUPPORTED_STEP',
  RUN_NOT_CANCELLABLE: 'RUN_NOT_CANCELLABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class ApiError extends Error {
  code: ErrorCode;
  status: number;
  details?: unknown;
  constructor(code: ErrorCode, message: string, status = 400, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function toErrorBody(err: unknown): { statusCode: number; body: Record<string, unknown> } {
  if (err instanceof ApiError) {
    return { statusCode: err.status, body: { code: err.code, message: err.message, details: err.details ?? null } };
  }
  const e = err as Error & { code?: string; statusCode?: number };
  // Malformed/empty JSON bodies (e.g. `content-type: application/json` with no
  // payload) are client errors, never 500s.
  if (typeof e?.code === 'string' && e.code.startsWith('FST_ERR_CTP_')) {
    return { statusCode: 400, body: { code: 'VALIDATION_ERROR', message: e.message, details: null } };
  }
  const codeMap: Record<string, { code: ErrorCode; status: number }> = {
    CONFLICT_RECORDER_ACTIVE: { code: 'CONFLICT_RECORDER_ACTIVE', status: 409 },
    RECORDER_NOT_ACTIVE: { code: 'RECORDER_NOT_ACTIVE', status: 409 },
    INVALID_STATE: { code: 'INVALID_STATE', status: 409 },
    NOT_FOUND: { code: 'NOT_FOUND', status: 404 },
  };
  if (e?.code && codeMap[e.code]) {
    const m = codeMap[e.code]!;
    return { statusCode: e.statusCode ?? m.status, body: { code: m.code, message: e.message, details: null } };
  }
  return { statusCode: 500, body: { code: 'INTERNAL_ERROR', message: 'Internal server error', details: null } };
}
