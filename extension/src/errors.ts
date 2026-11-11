import type { ErrorBody } from './protocol.js';

export class ToolError extends Error {
  code: string;
  extra: Record<string, unknown>;

  constructor(code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

export function toErrorBody(error: unknown): ErrorBody {
  if (error instanceof ToolError) {
    return { code: error.code, message: error.message, ...error.extra };
  }

  return { code: 'ERROR', message: error instanceof Error ? error.message : String(error) };
}
