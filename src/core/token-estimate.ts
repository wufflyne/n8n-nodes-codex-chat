import { CodexError } from "./errors.js";
/** Approximate text-content heuristic; neither actual usage nor a context upper bound. */
export function approximateTextTokens(content: unknown): number {
  let text: string;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content))
    text = content
      .map((block) => {
        if (
          !block ||
          !["text", "input_text", "output_text"].includes(block.type) ||
          typeof block.text !== "string"
        )
          throw new CodexError(
            "configuration",
            "This approximate text estimate cannot budget multimodal memory. Use an explicit memory window.",
          );
        return block.text as string;
      })
      .join("");
  else
    throw new CodexError(
      "configuration",
      "This approximate text estimate accepts text content only.",
    );
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}
