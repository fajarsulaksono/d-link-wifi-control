/**
 * Process exit codes & error domains.
 *
 * Exit numbers are preserved from wlmac.sh so existing cron/monitoring
 * doesn't need changes during porting.
 */
export const EXIT = {
  OK: 0,
  USAGE: 2,
  AUTH: 3,
  NETWORK: 4,
  API: 5,
  LOCKED: 6,
};

export class AppError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, { cause });
    this.name = 'AppError';
    this.code = code;
  }
}

export const usageError = (msg) => new AppError(EXIT.USAGE, msg);
export const authError = (msg) => new AppError(EXIT.AUTH, msg);
export const networkError = (msg, opts) => new AppError(EXIT.NETWORK, msg, opts);
export const apiError = (msg) => new AppError(EXIT.API, msg);

/** Lock held by another process: task skipped, not a fatal failure. */
export class LockBusyError extends AppError {
  constructor(message) {
    super(EXIT.LOCKED, message);
    this.name = 'LockBusyError';
  }
}

/** Map AppError to HTTP status for Express layer. */
export function httpStatusFor(err) {
  switch (err?.code) {
    case EXIT.USAGE:
      return 400;
    case EXIT.AUTH:
      return 401;
    case EXIT.NETWORK:
      return 502;
    case EXIT.API:
      return 502;
    case EXIT.LOCKED:
      return 423;
    default:
      return 500;
  }
}
