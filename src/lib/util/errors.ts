/** Application error with an HTTP status and a user-facing, actionable message. */
export class AppError extends Error {
  status: number;
  code: string;
  hint?: string;
  constructor(code: string, message: string, status = 400, hint?: string) {
    super(message);
    this.code = code;
    this.status = status;
    this.hint = hint;
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
