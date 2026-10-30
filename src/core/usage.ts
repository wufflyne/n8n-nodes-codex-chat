export interface NormalizedUsage {
  state: "complete" | "partial" | "unavailable";
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  totalSource: "provider" | "derived" | null;
  cachedInputTokens: number | null;
  reasoningOutputTokens: number | null;
  invalidFields: Array<
    "input" | "output" | "total" | "cachedInput" | "reasoningOutput"
  >;
}
export function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
export function normalizeUsage(value: unknown): NormalizedUsage {
  const u = object(value),
    invalidFields: NormalizedUsage["invalidFields"] = [];
  const read = (
    value: unknown,
    field: NormalizedUsage["invalidFields"][number],
  ) => {
    const n = count(value);
    if (value !== undefined && value !== null && n === null)
      invalidFields.push(field);
    return n;
  };
  const inputTokens = read(u.input_tokens, "input"),
    outputTokens = read(u.output_tokens, "output");
  let totalTokens = read(u.total_tokens, "total"),
    totalSource: NormalizedUsage["totalSource"] =
      totalTokens === null ? null : "provider";
  let cachedInputTokens = read(
    object(u.input_tokens_details).cached_tokens,
    "cachedInput",
  );
  let reasoningOutputTokens = read(
    object(u.output_tokens_details).reasoning_tokens,
    "reasoningOutput",
  );
  if (
    cachedInputTokens !== null &&
    inputTokens !== null &&
    cachedInputTokens > inputTokens
  ) {
    cachedInputTokens = null;
    invalidFields.push("cachedInput");
  }
  if (
    reasoningOutputTokens !== null &&
    outputTokens !== null &&
    reasoningOutputTokens > outputTokens
  ) {
    reasoningOutputTokens = null;
    invalidFields.push("reasoningOutput");
  }
  if (inputTokens !== null && outputTokens !== null) {
    const sum = count(inputTokens + outputTokens);
    if (totalTokens !== null && totalTokens !== sum) {
      totalTokens = null;
      totalSource = null;
      invalidFields.push("total");
    } else if (u.total_tokens == null && sum !== null) {
      totalTokens = sum;
      totalSource = "derived";
    }
  }
  const complete =
    inputTokens !== null && outputTokens !== null && totalTokens !== null;
  const any = [
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
    reasoningOutputTokens,
  ].some((v) => v !== null);
  return {
    state: complete ? "complete" : any ? "partial" : "unavailable",
    inputTokens,
    outputTokens,
    totalTokens,
    totalSource,
    cachedInputTokens,
    reasoningOutputTokens,
    invalidFields: [...new Set(invalidFields)],
  };
}
export function langChainUsage(u: NormalizedUsage) {
  if (u.state !== "complete") return undefined;
  return {
    input_tokens: u.inputTokens!,
    output_tokens: u.outputTokens!,
    total_tokens: u.totalTokens!,
    ...(u.cachedInputTokens === null
      ? {}
      : { input_token_details: { cache_read: u.cachedInputTokens } }),
    ...(u.reasoningOutputTokens === null
      ? {}
      : { output_token_details: { reasoning: u.reasoningOutputTokens } }),
  };
}
