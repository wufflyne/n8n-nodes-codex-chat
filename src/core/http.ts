import { CodexError } from "./errors.js";

export type Fetch = typeof fetch;

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new CodexError("cancelled", "The request was cancelled.");
}

export function requestScope(
  signals: Array<AbortSignal | undefined>,
  timeoutMs: number,
) {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  for (const signal of signals) {
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", cancel, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    abort: cancel,
    error: () =>
      new CodexError(
        timedOut ? "timeout" : "cancelled",
        timedOut
          ? "The request exceeded its overall timeout."
          : "The request was cancelled.",
      ),
    close: () => {
      clearTimeout(timer);
      for (const s of signals) s?.removeEventListener("abort", cancel);
    },
  };
}

export async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      reject(new CodexError("cancelled", "The request was cancelled."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

/** Detach one caller without cancelling work shared with other executions. */
export function waitForSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    // The operation may already have started; observe a late rejection even when this caller detaches.
    void promise.catch(() => undefined);
    return Promise.reject(
      new CodexError("cancelled", "The request was cancelled."),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const finish = () => signal.removeEventListener("abort", cancel);
    const cancel = () => {
      finish();
      reject(new CodexError("cancelled", "The request was cancelled."));
    };
    signal.addEventListener("abort", cancel, { once: true });
    promise.then(
      (value) => {
        finish();
        resolve(value);
      },
      (error) => {
        finish();
        reject(error);
      },
    );
  });
}

export async function readJson(
  response: Response,
  maxBytes = 2 * 1024 * 1024,
  signal?: AbortSignal,
): Promise<unknown> {
  const bytes = await readBytes(response, maxBytes, signal);
  try { return JSON.parse(bytes.toString("utf8")) as unknown; }
  catch { throw new CodexError("protocol", "The provider returned an invalid JSON response."); }
}

/** Bounded bytes for protocols that must durably capture success before parsing. */
export async function readBytes(response: Response, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  if (!response.body)
    throw new CodexError(
      "protocol",
      "The provider returned an empty response.",
    );
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await waitForSignal(reader.read(), signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes)
        throw new CodexError(
          "protocol",
          "The provider response exceeded the size limit.",
        );
      chunks.push(next.value);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof CodexError) throw error;
    throw new CodexError(
      "protocol",
      "The provider returned an invalid JSON response.",
    );
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function requestId(response: Response): string | undefined {
  const value =
    response.headers.get("x-request-id") ?? response.headers.get("request-id");
  return value && /^[\w-]{1,128}$/.test(value) ? value : undefined;
}

export async function admissionError(response: Response): Promise<CodexError> {
  void response.body?.cancel().catch(() => undefined);
  const status = response.status;
  const id = requestId(response);
  if (status === 401)
    return new CodexError(
      "authentication",
      "The account session was rejected. Reconnect this profile.",
      status,
      id,
    );
  if (status === 403)
    return new CodexError(
      "authentication",
      "This account is not permitted to use the selected model or route.",
      status,
      id,
    );
  if (status === 429)
    return new CodexError(
      "rate_limit",
      "The account has reached a usage or rate limit. Retry later; no account was switched.",
      status,
      id,
    );
  return new CodexError(
    "provider",
    `The provider rejected the request (HTTP ${status}).`,
    status,
    id,
  );
}
