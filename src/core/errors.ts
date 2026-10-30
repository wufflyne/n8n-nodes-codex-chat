export type ErrorCategory =
  | "configuration"
  | "authentication"
  | "reconnect"
  | "rate_limit"
  | "provider"
  | "protocol"
  | "timeout"
  | "cancelled"
  | "storage";

/** Errors contain controlled text only. Never attach raw fetch errors or response bodies. */
export class CodexError extends Error {
  constructor(
    public readonly category: ErrorCategory,
    message: string,
    public readonly status?: number,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "CodexError";
  }
}

export function safeError(error: unknown): CodexError {
  return error instanceof CodexError
    ? error
    : new CodexError(
        "provider",
        "The request could not be completed. Check connectivity and retry.",
      );
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CodexError("configuration", message);
}

export function record(value: unknown): Record<string, unknown> {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Expected a JSON object.",
  );
  return value as Record<string, unknown>;
}

export function string(value: unknown, name: string, max = 65536): string {
  assert(
    typeof value === "string" && value.length > 0 && value.length <= max,
    `${name} is missing or invalid.`,
  );
  return value;
}

export function checkKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  assert(
    Object.keys(value).every((key) => allowed.includes(key)),
    "The input contains unsupported fields. Check the selected import format.",
  );
}

export class AccountsExhaustedError extends CodexError {
  readonly code = "accounts_exhausted";
  constructor(
    readonly routing: Array<{
      alias: string;
      decision: "allowed" | "quota_exhausted" | "unknown";
      earliestResetAt: string | null;
    }>,
  ) {
    super(
      "rate_limit",
      "No configured account is currently available. Check the account limits and reset times.",
    );
  }
}
