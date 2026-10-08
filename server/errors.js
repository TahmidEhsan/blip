// Blip: HTTP error type and the SPEC §5 error body shape.

export class HttpError extends Error {
  /**
   * @param {number} status HTTP status
   * @param {string} code machine-readable code (e.g. 'validation', 'slug_taken')
   * @param {string} message human-friendly message
   * @param {string} [field] offending input field, when relevant
   */
  constructor(status, code, message, field) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.field = field ?? null;
  }
}

export const badRequest = (code, message, field) => new HttpError(400, code, message, field);
export const validationError = (field, message) => new HttpError(400, 'validation', message, field);

/** `{ error: { code, message, field? } }` */
export function errorBody(code, message, field) {
  const error = { code, message };
  if (field) error.field = field;
  return { error };
}

export function sendError(res, status, code, message, field) {
  res.status(status).json(errorBody(code, message, field));
}
