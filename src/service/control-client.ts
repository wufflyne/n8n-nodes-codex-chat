import { readPrivateFile } from "../auth/store.js";
import { assert } from "../core/errors.js";
import { readJson } from "../core/http.js";
export class ControlClient {
  constructor(
    private readonly origin: string,
    private readonly keyFile: string,
  ) {
    const url = new URL(origin);
    assert(
      url.origin === origin &&
        !url.username &&
        !url.password &&
        (url.protocol === "https:" ||
          (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))),
      "Online administration requires an exact HTTPS or loopback origin.",
    );
  }
  async call(operation: string, value?: unknown, signal?: AbortSignal) {
    assert(/^[a-z/]+$/.test(operation), "Invalid control operation.");
    const key = (await readPrivateFile(this.keyFile, 1024)).trim();
    const deadline = AbortSignal.timeout(120000),
      activeSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const response = await fetch(`${this.origin}/control/v1/${operation}`, {
      method: value === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: value === undefined ? undefined : JSON.stringify(value),
      signal: activeSignal,
      redirect: "error",
    });
    const result = (await readJson(response, 2 * 1024 * 1024, activeSignal)) as Record<string, any>;
    if (!response.ok)
      throw new Error(
        typeof result.error?.message === "string"
          ? result.error.message
          : "The owner rejected the administration operation.",
      );
    return result;
  }
}
