import type { ProfileBinding as Binding } from "../service/access.js";
import { randomUUID } from "node:crypto";
import type { AccountSessionManager } from "../auth/sessions.js";
import { accountHeaders } from "../core/catalog.js";
import { assert, CodexError, record } from "../core/errors.js";
import {
  admissionError,
  readJson,
  requestId,
  requestScope,
  throwIfAborted,
  type Fetch,
} from "../core/http.js";
import { recordInvocation } from "../core/execution-usage.js";
import type { ExecutionContext } from "../core/affinity.js";
import { CODEX_BASE } from "../core/types.js";
import { text, unixDate, identifier } from "../account/usage.js";
import type { SessionAccess } from "../account/types.js";
import { imageDimensions, strictBase64 } from "./validation.js";
export class ImageService {
  constructor(
    private readonly sessions: AccountSessionManager,
    private readonly fetchImpl: Fetch = fetch,
    private readonly baseUrl = CODEX_BASE,
  ) {}
  async generate(
    binding: Binding,
    prompt: string,
    transparent: boolean,
    options: {
      timeoutMs?: number;
      signal?: AbortSignal;
      context?: ExecutionContext;
      access?: SessionAccess;
    } = {},
  ) {
    assert(
      typeof prompt === "string" && prompt.length >= 1 && prompt.length <= 32000,
      "Image Prompt must contain 1–32,000 characters.",
    );
    assert(typeof transparent === "boolean", "Transparent Background must be boolean.");
    const timeout = options.timeoutMs ?? 180000;
    assert(
      Number.isFinite(timeout) && timeout >= 30000 && timeout <= 600000,
      "Image Overall Timeout must be between 30 and 600 seconds.",
    );
    throwIfAborted(options.signal);
    const scope = requestScope([options.signal], timeout);
    let recorder: ReturnType<typeof recordInvocation> | undefined,
      waiting = false,
      admitted = false;
    try {
      const session = await (options.access === "current-only"
        ? this.sessions.currentSession(binding, scope.signal)
        : this.sessions.session(binding, scope.signal));
      throwIfAborted(scope.signal);
      recorder = recordInvocation(options.context, session.affinity, "gpt-image-2", "images");
      const turn = randomUUID();
      recorder.attempt();
      waiting = true;
      const response = await this.fetchImpl(`${this.baseUrl}/images/generations`, {
        method: "POST",
        redirect: "error",
        signal: scope.signal,
        headers: {
          ...accountHeaders(session),
          "Content-Type": "application/json",
          "x-codex-image-turn-id": turn,
        },
        body: JSON.stringify({
          prompt,
          model: "gpt-image-2",
          background: transparent ? "transparent" : "opaque",
          quality: "auto",
          size: "auto",
        }),
      });
      waiting = false;
      if (!response.ok) {
        recorder.rejected();
        throw await admissionError(response);
      }
      admitted = true;
      recorder.admitted();
      const body = record(await readJson(response, 48 * 1024 * 1024, scope.signal));
      const createdAt = unixDate(body.created);
      assert(createdAt, "The generated image creation time is invalid.");
      assert(
        Array.isArray(body.data) && body.data.length === 1,
        "The one-image request must return exactly one image.",
      );
      const item = record(body.data[0]),
        bytes = strictBase64(item.b64_json, 32 * 1024 * 1024),
        dimensions = imageDimensions(bytes);
      recorder.complete();
      return {
        bytes,
        filename: `codex-image.${dimensions.extension}`,
        metadata: {
          schemaVersion: 1,
          operation: "generateImage",
          model: "gpt-image-2",
          createdAt,
          mimeType: dimensions.mimeType,
          byteLength: bytes.length,
          width: dimensions.width,
          height: dimensions.height,
          background: text(body.background, 40),
          quality: text(body.quality, 40),
          size: text(body.size, 80),
          generationId: identifier(item.generation_id ?? body.generation_id, 256),
          requestId: requestId(response) ?? turn,
        },
      };
    } catch (error) {
      if (waiting) recorder?.ambiguous();
      if (admitted) recorder?.failed();
      if (scope.signal.aborted) throw scope.error();
      if (error instanceof CodexError) {
        if (admitted && error.category === "configuration")
          throw new CodexError(
            "protocol",
            "The provider returned an invalid or unsupported image artifact.",
          );
        throw error;
      }
      throw new CodexError(
        "provider",
        "Image generation failed with an unknown outcome. It was not retried.",
      );
    } finally {
      recorder?.close();
      scope.abort();
      scope.close();
    }
  }
}
