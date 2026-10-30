import { isDeepStrictEqual } from "node:util";
import { CodexError, assert, record, string } from "./errors.js";
import type { CompletedResponse, JsonObject, ResponseItem } from "./types.js";

const MAX_EVENT = 4 * 1024 * 1024;
const MAX_STREAM = 64 * 1024 * 1024;

/** Incremental UTF-8 and CR/LF parsing; comments and multi-line data follow the SSE specification. */
export async function* sseEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  idleTimeoutMs: number,
): AsyncGenerator<JsonObject> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let line = "";
  let skipLf = false;
  let data: string[] = [];
  let eventName = "";
  let eventSize = 0;
  let total = 0;
  const parse = (line: string): JsonObject | undefined => {
    if (line === "") {
      const payload = data.join("\n");
      const name = eventName;
      data = [];
      eventName = "";
      eventSize = 0;
      if (!payload || payload === "[DONE]") return undefined;
      try {
        const event = record(JSON.parse(payload));
        return { ...event, type: event.type ?? name };
      } catch {
        throw new CodexError(
          "protocol",
          "The provider returned an invalid streaming event.",
        );
      }
    }
    if (line.startsWith(":")) return undefined;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      eventSize += value.length + 1;
      data.push(value);
    }
    if (field === "event") eventName = value;
    if (eventSize > MAX_EVENT || data.length > 65536)
      throw new CodexError(
        "protocol",
        "A provider streaming event exceeded the size limit.",
      );
    return undefined;
  };
  try {
    while (true) {
      const next = await readWithDeadline(reader, signal, idleTimeoutMs);
      if (next.done) {
        decoder.decode(); // Reject an incomplete final UTF-8 code point.
        break;
      }
      total += next.value.byteLength;
      if (total > MAX_STREAM)
        throw new CodexError(
          "protocol",
          "The provider stream exceeded the response size limit.",
        );
      const text = decoder.decode(next.value, { stream: true });
      let offset = 0;
      if (skipLf && text.length) {
        if (text[0] === "\n") offset = 1;
        skipLf = false;
      }
      // Scan each decoded chunk once. An unfinished large line is never rescanned on every read.
      const delimiters = /[\r\n]/g;
      delimiters.lastIndex = offset;
      let match: RegExpExecArray | null;
      while ((match = delimiters.exec(text)) !== null) {
        line += text.slice(offset, match.index);
        if (line.length > MAX_EVENT)
          throw new CodexError(
            "protocol",
            "A provider streaming line exceeded the size limit.",
          );
        const event = parse(line);
        line = "";
        offset = match.index + 1;
        if (match[0] === "\r") {
          if (text[offset] === "\n") offset++;
          else if (offset === text.length) skipLf = true;
        }
        delimiters.lastIndex = offset;
        if (event) yield event;
      }
      line += text.slice(offset);
      if (line.length > MAX_EVENT)
        throw new CodexError(
          "protocol",
          "A provider streaming line exceeded the size limit.",
        );
    }
    // An unterminated final SSE frame is deliberately ignored; it is not a completed response.
  } catch (error) {
    if (error instanceof CodexError) throw error;
    if (signal.aborted)
      throw new CodexError("cancelled", "The request was cancelled.");
    throw new CodexError(
      "protocol",
      "The provider stream was interrupted or contained invalid UTF-8.",
    );
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function readWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  idleMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted)
    return Promise.reject(
      new CodexError("cancelled", "The request was cancelled."),
    );
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
    };
    const cancel = () => {
      finish();
      reject(new CodexError("cancelled", "The request was cancelled."));
    };
    const timer = setTimeout(() => {
      finish();
      reject(
        new CodexError(
          "timeout",
          "The provider stream exceeded its idle timeout.",
        ),
      );
    }, idleMs);
    signal.addEventListener("abort", cancel, { once: true });
    reader.read().then(
      (value) => {
        finish();
        resolve(value);
      },
      () => {
        finish();
        reject(
          new CodexError("protocol", "The provider stream was interrupted."),
        );
      },
    );
  });
}

interface AccumulatedItem {
  item: ResponseItem;
  index?: number;
  order: number;
  done: boolean;
  arguments: string;
  hasDeltas: boolean;
  argumentsDone?: string;
}

/** Codex may put output only in output_item.done and send a sparse completion envelope. */
export class ResponseAccumulator {
  private readonly items: AccumulatedItem[] = [];
  private readonly aliases = new Map<string, AccumulatedItem>();

  private state(event: JsonObject, item?: ResponseItem): AccumulatedItem {
    const index = event.output_index;
    assert(
      index === undefined ||
        (Number.isInteger(index) && Number(index) >= 0 && Number(index) < 4096),
      "The provider returned an invalid item index.",
    );
    const aliases = [
      index === undefined ? undefined : `index:${index}`,
      typeof (item?.id ?? event.item_id) === "string"
        ? `item:${item?.id ?? event.item_id}`
        : undefined,
      typeof (item?.call_id ?? event.call_id) === "string"
        ? `call:${item?.call_id ?? event.call_id}`
        : undefined,
    ].filter((value): value is string => value !== undefined);
    assert(
      aliases.length > 0 || item,
      "A provider tool delta has no item or call identifier.",
    );
    const known = aliases
      .map((alias) => this.aliases.get(alias))
      .filter((value): value is AccumulatedItem => value !== undefined);
    assert(
      known.every((value) => value === known[0]),
      "Provider item identifiers conflict across parallel calls.",
    );
    let state = known[0];
    if (!state) {
      assert(
        this.items.length < 4096,
        "The provider returned too many response items.",
      );
      state = {
        item: {},
        order: this.items.length,
        done: false,
        arguments: "",
        hasDeltas: false,
      };
      this.items.push(state);
    }
    if (index !== undefined) {
      assert(
        state.index === undefined || state.index === index,
        "The provider changed an output item index.",
      );
      state.index = Number(index);
    }
    const candidate: JsonObject = item ?? {
      id: event.item_id,
      call_id: event.call_id,
    };
    for (const key of ["id", "call_id", "type", "name", "namespace"]) {
      assert(
        state.item[key] === undefined ||
          candidate[key] === undefined ||
          state.item[key] === candidate[key],
        "The provider changed an output item identity.",
      );
    }
    if (!item) {
      if (typeof event.item_id === "string") state.item.id = event.item_id;
      if (typeof event.call_id === "string") state.item.call_id = event.call_id;
    }
    assert(
      this.aliases.size + aliases.length <= 16384,
      "The provider returned too many item identifiers.",
    );
    for (const alias of aliases) this.aliases.set(alias, state);
    return state;
  }

  private finishItem(state: AccumulatedItem, item: ResponseItem): void {
    if (item.type === "function_call") {
      assert(
        !state.hasDeltas || state.arguments === item.arguments,
        "Provider tool arguments conflict with their streaming deltas.",
      );
      assert(
        state.argumentsDone === undefined ||
          state.argumentsDone === item.arguments,
        "Provider tool arguments conflict with their completed arguments.",
      );
    }
    assert(
      !state.done || isDeepStrictEqual(state.item, item),
      "The provider changed an already completed output item.",
    );
    assert(
      item.status === undefined || item.status === "completed",
      "The provider returned an unfinished output item. No tool calls were released.",
    );
    state.item = item;
    state.done = true;
  }

  consume(event: JsonObject): CompletedResponse | undefined {
    if (
      [
        "response.failed",
        "response.incomplete",
        "error",
        "response.error",
      ].includes(String(event.type))
    ) {
      throw new CodexError(
        "provider",
        event.type === "response.incomplete"
          ? "The provider response is incomplete. No tool calls were released."
          : "The provider reported a failed response. No tool calls were released.",
      );
    }
    if (
      event.type === "response.output_item.added" ||
      event.type === "response.output_item.done"
    ) {
      const item = record(event.item) as ResponseItem;
      const state = this.state(event, item);
      if (event.type === "response.output_item.done")
        this.finishItem(state, item);
      else {
        assert(!state.done, "The provider reopened a completed output item.");
        state.item = item;
      }
    } else if (event.type === "response.function_call_arguments.delta") {
      const state = this.state(event);
      assert(
        !state.done && state.argumentsDone === undefined,
        "The provider continued completed tool arguments.",
      );
      assert(
        typeof event.delta === "string",
        "The provider returned an invalid tool argument delta.",
      );
      state.arguments += event.delta;
      state.hasDeltas = true;
      assert(
        state.arguments.length <= MAX_EVENT,
        "Provider tool arguments exceeded the size limit.",
      );
    } else if (event.type === "response.function_call_arguments.done") {
      const state = this.state(event);
      const args = string(event.arguments, "Tool arguments", MAX_EVENT);
      assert(
        !state.hasDeltas || state.arguments === args,
        "Provider tool arguments conflict with their streaming deltas.",
      );
      assert(
        state.argumentsDone === undefined || state.argumentsDone === args,
        "The provider changed completed tool arguments.",
      );
      assert(
        !state.done || state.item.arguments === args,
        "The provider changed completed tool arguments.",
      );
      state.argumentsDone = args;
    }
    if (event.type !== "response.completed") return undefined;
    const response = record(event.response);
    assert(
      response.status === undefined || response.status === "completed",
      "The provider completion event is not successful.",
    );
    const id = string(response.id, "Provider response identifier", 256);
    assert(
      /^[A-Za-z0-9_-]{1,256}$/.test(id),
      "The provider response identifier is invalid.",
    );
    assert(
      response.output === undefined || Array.isArray(response.output),
      "The provider returned invalid completed output.",
    );
    let output: ResponseItem[];
    if (Array.isArray(response.output)) {
      assert(
        response.output.length <= 4096,
        "The provider returned too many response items.",
      );
      const included = new Set<AccumulatedItem>();
      output = response.output.map((value, index) => {
        const item = record(value) as ResponseItem;
        const state = this.state({ output_index: index }, item);
        assert(
          !included.has(state),
          "The provider duplicated a completed output item.",
        );
        included.add(state);
        this.finishItem(state, item);
        return item;
      });
      assert(
        this.items.every((state) => included.has(state)),
        "The completed response omitted a streamed output item. No tool calls were released.",
      );
    } else {
      assert(
        this.items.every((item) => item.done),
        "The provider completed without finishing every output item. No tool calls were released.",
      );
      output = [...this.items]
        .sort((a, b) => (a.index ?? a.order) - (b.index ?? b.order))
        .map((state) => state.item);
    }
    return {
      id,
      status: "completed",
      output,
      ...(response.usage && typeof response.usage === "object"
        ? { usage: response.usage as CompletedResponse["usage"] }
        : {}),
      ...(typeof response.service_tier === "string" &&
      /^[A-Za-z0-9_-]{1,64}$/.test(response.service_tier)
        ? { service_tier: response.service_tier }
        : {}),
    };
  }
}
