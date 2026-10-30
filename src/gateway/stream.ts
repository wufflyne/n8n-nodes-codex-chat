import { randomUUID } from "node:crypto";
import type { CompletedResponse } from "../core/types.js";
import type { TransportEvent } from "../core/transport.js";
import { ItemResolver, responseEvents } from "./responses.js";
import { terminal, wireError } from "./errors.js";

export type PublicEvent = Record<string, unknown>;
/** One bounded channel couples provider reads to the downstream consumer. */
export class EventChannel implements AsyncIterable<PublicEvent> {
  private queue: Array<{ event: PublicEvent; bytes: number }> = [];
  private bytes = 0;
  private ended = false;
  private wakes = new Set<() => void>();
  constructor(
    private readonly cancel: () => void,
    readonly limit = 256 * 1024,
    readonly count = 16,
    readonly waitMs = 15000,
  ) {}
  private wake() {
    for (const fn of this.wakes) fn();
    this.wakes.clear();
  }
  private wait(producer: boolean) {
    return new Promise<void>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.wakes.delete(done);
        resolve();
      };
      const timer = producer
        ? setTimeout(() => {
            this.wakes.delete(done);
            this.cancel();
            this.close();
            reject(new Error("The stream consumer stopped reading."));
          }, this.waitMs)
        : undefined;
      this.wakes.add(done);
    });
  }
  async write(event: PublicEvent) {
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes > 4 * 1024 * 1024)
      terminal("output_limit", "A public stream event exceeds the output limit.");
    while (
      !this.ended &&
      (this.queue.length >= this.count ||
        (this.queue.length > 0 && this.bytes + bytes > this.limit))
    )
      await this.wait(true);
    if (this.ended) throw new Error("The stream consumer closed.");
    this.queue.push({ event, bytes });
    this.bytes += bytes;
    this.wake();
  }
  close() {
    this.ended = true;
    this.wake();
  }
  get queuedBytes() {
    return this.bytes;
  }
  async *[Symbol.asyncIterator]() {
    try {
      while (true) {
        const next = this.queue.shift();
        if (next) {
          this.bytes -= next.bytes;
          this.wake();
          yield next.event;
        } else if (this.ended) return;
        else await this.wait(false);
      }
    } finally {
      this.cancel();
      this.queue = [];
      this.bytes = 0;
      this.close();
    }
  }
}

/** Only non-executable text is provisional; all item terminals and tools require commit. */
export class PublicResponseStream {
  readonly identity = {
    responseId: `resp_cw_${randomUUID().replaceAll("-", "")}`,
    items: new Map<string, string>(),
  };
  private sequence = 0;
  private started = false;
  private headers = new Map<number, { id: string; type: string }>();
  private parts = new Map<string, string>();
  constructor(
    private readonly model: string,
    private readonly stored: boolean,
    private readonly ready: () => void,
    private readonly write: (event: PublicEvent) => Promise<void>,
  ) {}
  private emit(type: string, data: PublicEvent = {}) {
    return this.write({ ...data, type, sequence_number: this.sequence++ });
  }
  async start() {
    if (this.started) return;
    this.started = true;
    this.ready();
    const response = {
      id: this.identity.responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "in_progress",
      model: this.model,
      output: [],
      usage: null,
      error: null,
      incomplete_details: null,
      store: this.stored,
    };
    await this.emit("response.created", { response });
    await this.emit("response.in_progress", { response });
  }
  async item(item: Record<string, unknown>, index: number) {
    if (
      typeof item.id !== "string" ||
      item.id.length > 256 ||
      index < 0 ||
      index >= 256 ||
      !["message", "agent_message", "reasoning"].includes(String(item.type))
    )
      terminal("invalid_stream_item", "The provider returned an invalid streaming item.");
    const type = item.type === "agent_message" ? "message" : String(item.type),
      prior = this.headers.get(index);
    if (prior) {
      if (prior.id !== item.id || prior.type !== type)
        terminal("stream_conflict", "The provider changed a streaming item identity.");
      return;
    }
    if ([...this.headers.values()].some((v) => v.id === item.id))
      terminal("stream_conflict", "The provider reused a streaming item identity.");
    this.headers.set(index, { id: item.id, type });
    const id = this.stored ? `item_cw_${randomUUID().replaceAll("-", "")}` : item.id;
    this.identity.items.set(item.id, id);
    await this.emit("response.output_item.added", {
      output_index: index,
      item: {
        type,
        id,
        status: "in_progress",
        ...(type === "message"
          ? { role: "assistant", content: [] }
          : { summary: [], encrypted_content: null }),
      },
    });
  }
  async text(event: Extract<TransportEvent, { kind: "text" }>) {
    const index = event.outputIndex,
      part = event.contentIndex,
      header = index === undefined ? undefined : this.headers.get(index);
    // Without qualified item metadata retain text until the validated final response.
    if (!header || header.type !== "message" || event.itemId !== header.id || part === undefined)
      return;
    if (part < 0 || part > 255)
      terminal("invalid_stream_item", "The provider returned an invalid content index.");
    const key = `${index}:${part}`,
      id = this.identity.items.get(header.id),
      previous = this.parts.get(key);
    if (previous === undefined)
      await this.emit("response.content_part.added", {
        item_id: id,
        output_index: index,
        content_index: part,
        part: { type: "output_text", text: "", annotations: [] },
      });
    this.parts.set(key, (previous ?? "") + event.text);
    for (let start = 0; start < event.text.length; start += 8192)
      await this.emit("response.output_text.delta", {
        item_id: id,
        output_index: index,
        content_index: part,
        delta: event.text.slice(start, start + 8192),
      });
  }
  validate(response: CompletedResponse) {
    for (const [index, header] of this.headers) {
      const item = response.output[index];
      if (
        !item ||
        item.id !== header.id ||
        (item.type === "agent_message" ? "message" : item.type) !== header.type
      )
        terminal("stream_conflict", "The terminal response changed an emitted item.");
    }
    for (const [key, text] of this.parts) {
      const [index, part] = key.split(":").map(Number),
        item = response.output[index!];
      const content = Array.isArray(item?.content)
        ? (item.content[part!] as Record<string, unknown>)
        : undefined;
      if (content?.type !== "output_text" || content.text !== text)
        terminal("stream_conflict", "The terminal response changed emitted text.");
    }
  }
  async finish(body: ReturnType<ItemResolver["prepare"]>["body"]) {
    if (!this.started) this.identity.responseId = body.id;
    await this.start();
    for (const event of responseEvents(body)) {
      if (event.type === "response.created" || event.type === "response.in_progress") continue;
      if (
        event.type === "response.output_item.added" &&
        this.headers.has(Number(event.output_index))
      )
        continue;
      const key = `${event.output_index}:${event.content_index}`;
      if (
        this.parts.has(key) &&
        (event.type === "response.content_part.added" ||
          event.type === "response.output_text.delta")
      )
        continue;
      await this.emit(String(event.type), event);
    }
  }
  async fail(error: unknown) {
    const e = wireError(error);
    await this.emit("error", {
      error: { type: e.code, code: "422", message: e.message, param: e.param ?? null },
    });
  }
}
