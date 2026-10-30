import { CodexError } from "../core/errors.js";

/** Terminal safety conditions use 422: the pinned SDK retries 409. */
export class WireError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly param: string | null = null,
  ) {
    super(message);
    this.name = "WireError";
  }
}
export function invalid(
  param: string,
  message = `Unsupported or invalid parameter: ${param}.`,
): never {
  throw new WireError(400, "invalid_request", message, param);
}
export function terminal(code: string, message: string): never {
  throw new WireError(422, code, message);
}
export function wireError(error: unknown): WireError {
  if (error instanceof WireError) return error;
  if (error instanceof CodexError) {
    if (error.category === "configuration")
      return new WireError(400, "invalid_request", error.message);
    if (error.category === "reconnect")
      return new WireError(422, "reconnect_required", error.message);
    if (error.category === "authentication")
      return new WireError(422, "reconnect_required", "Reconnect the account before continuing.");
    if (error.status === 429 || error.status === 503)
      return new WireError(error.status, "admission_rejected", error.message);
  }
  return new WireError(
    422,
    "outcome_unknown",
    "The operation did not complete safely. Inspect its status before starting a new operation.",
  );
}
export function errorBody(error: unknown) {
  const e = wireError(error);
  return {
    error: {
      message: e.message,
      type: e.status === 401 ? "authentication_error" : "invalid_request_error",
      code: e.code,
      param: e.param,
    },
  };
}
