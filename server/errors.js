// Blip: HTTP error type, the SPEC §5 error body shape, and coercions request validation can't trip over.

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

// A JSON body can hold values String() and Number() throw on: an object whose toString or valueOf is not a
// function ({"toString":1}), or an array nested too deep to join. These coerce like String() and Number()
// do, and give such a value up as no value, so validation answers 400 instead of 500.

/** String(value), or null when it can't be turned into a string. */
export function asText(value) {
  try {
    return String(value);
  } catch {
    return null;
  }
}

/** Number(value), or NaN when it can't be turned into a number. */
export function asNumber(value) {
  try {
    return Number(value);
  } catch {
    return Number.NaN;
  }
}
