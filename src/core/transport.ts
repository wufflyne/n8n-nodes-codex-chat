import { randomUUID } from "node:crypto";
import { accountHeaders } from "./catalog.js";
import { CodexError } from "./errors.js";
import {
  admissionError,
  delay,
  requestId,
  requestScope,
  type Fetch,
} from "./http.js";
import { ResponseAccumulator, sseEvents } from "./sse.js";
import type { CallRecorder } from "./execution-usage.js";
import {
  CODEX_BASE,
  type CompletedResponse,
  type ModelSettings,
  type ResponseRequest,
  type Session,
} from "./types.js";
export type TransportEvent =
  | { kind: "text"; text: string }
  | {
      kind: "completed";
      response: CompletedResponse;
      requestId?: string;
      elapsedMs: number;
      firstTextMs?: number;
    };
export class AdmissionRejection extends CodexError {
  readonly accepted = false;
  constructor(
    status: number,
    id?: string,
    readonly retryAt?: number,
  ) {
    super(
      "rate_limit",
      "The provider rejected admission because this account has exhausted its applicable included allowance.",
      status,
      id,
    );
  }
}
export interface TransportContext {
  deadline?: number;
  affinity?: string;
  recorder?: CallRecorder;
  onAdmission?: () => void;
  onRejection?: (
    rejection: { status: number; requestId?: string; retryAt?: number },
    signal: AbortSignal,
  ) => Promise<"quota" | "retry">;
}
export function retryAt(
  value: string | null,
  now = Date.now(),
): number | undefined {
  if (value === null || !value.trim()) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const ms = Number(value) * 1000;
    return Number.isFinite(ms) ? now + ms : undefined;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(now, date) : undefined;
}
export function retryWait(
  value: string | null,
  attempt: number,
  deadline: number,
  now = Date.now(),
): number {
  const at = retryAt(value, now);
  const wait =
    at === undefined
      ? Math.min(1000 * 2 ** attempt, 10000) * (0.75 + Math.random() * 0.5)
      : Math.max(0, at - now);
  if (wait >= deadline - now)
    throw new CodexError(
      "timeout",
      "The provider asked to retry after this request's timeout. Try again later or increase Overall Timeout.",
    );
  return wait;
}
export class ResponsesTransport {
  constructor(
    private readonly fetchImpl: Fetch = fetch,
    private readonly baseUrl = CODEX_BASE,
  ) {}
  async *stream(
    request: ResponseRequest,
    session: Session,
    settings: ModelSettings,
    signals: Array<AbortSignal | undefined>,
    lite: boolean,
    context: TransportContext = {},
  ): AsyncGenerator<TransportEvent> {
    const deadline = Math.min(
        context.deadline ?? Infinity,
        Date.now() + settings.timeoutMs,
      ),
      scope = requestScope(signals, Math.max(0, deadline - Date.now())),
      started = performance.now();
    let firstTextMs: number | undefined,
      awaitingResponse = false,
      admitted = false,
      completed = false;
    try {
      let response: Response | undefined;
      for (let attempt = 0; attempt <= settings.maxRetries; attempt++) {
        if (scope.signal.aborted || Date.now() >= deadline) throw scope.error();
        const headers = {
          ...accountHeaders(session),
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "x-client-request-id": randomUUID(),
          ...(lite ? { "x-openai-internal-codex-responses-lite": "true" } : {}),
          ...(context.affinity ? { "session-id": context.affinity } : {}),
        };
        context.recorder?.attempt();
        awaitingResponse = true;
        response = await this.fetchImpl(`${this.baseUrl}/responses`, {
          method: "POST",
          headers,
          body: JSON.stringify(request),
          signal: scope.signal,
          redirect: "error",
        });
        awaitingResponse = false;
        if (response.ok) {
          admitted = true;
          context.recorder?.admitted();
          context.onAdmission?.();
          break;
        }
        context.recorder?.rejected();
        const rejection = {
          status: response.status,
          requestId: requestId(response),
          retryAt: retryAt(response.headers.get("retry-after")),
        };
        void response.body?.cancel().catch(() => undefined);
        if (
          response.status === 429 &&
          context.onRejection &&
          (await context.onRejection(rejection, scope.signal)) === "quota"
        )
          throw new AdmissionRejection(
            429,
            rejection.requestId,
            rejection.retryAt,
          );
        if (
          ![429, 503].includes(response.status) ||
          attempt === settings.maxRetries
        )
          throw await admissionError(response);
        await delay(
          retryWait(response.headers.get("retry-after"), attempt, deadline),
          scope.signal,
        );
      }
      if (!response?.ok || !response.body)
        throw new CodexError(
          "protocol",
          "The provider returned an empty streaming response.",
        );
      const accumulator = new ResponseAccumulator();
      for await (const event of sseEvents(
        response.body,
        scope.signal,
        settings.idleTimeoutMs,
      )) {
        if (event.type === "response.output_text.delta") {
          if (typeof event.delta !== "string")
            throw new CodexError(
              "protocol",
              "The provider returned an invalid text delta.",
            );
          firstTextMs ??= performance.now() - started;
          yield { kind: "text", text: event.delta };
        }
        const final = accumulator.consume(event);
        if (final) {
          completed = true;
          yield {
            kind: "completed",
            response: final,
            requestId: requestId(response),
            elapsedMs: performance.now() - started,
            firstTextMs,
          };
          break;
        }
      }
      if (!completed)
        throw new CodexError(
          "protocol",
          "The provider stream ended before response.completed. No tool calls were released.",
        );
    } catch (error) {
      if (awaitingResponse) context.recorder?.ambiguous();
      if (admitted) context.recorder?.failed();
      if (scope.signal.aborted) throw scope.error();
      if (error instanceof CodexError) throw error;
      throw new CodexError(
        "provider",
        "The inference connection failed. The request was not retried because its outcome may be unknown.",
      );
    } finally {
      if (admitted && !completed) context.recorder?.failed();
      scope.abort();
      scope.close();
    }
  }
}
