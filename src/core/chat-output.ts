import { CodexError } from "./errors.js";

export const CHAT_OUTPUT_LIMITS = Object.freeze({
  text: 256 * 1024,
  quotes: 1024,
  renderWork: 64 * 1024 * 1024,
});

/** Admit every visible prefix before a stock Chat renderer or token callback sees it. */
export class ChatOutputBudget {
  private text = 0;
  private quotes = 0;
  private renderWork = 0;

  admit(fragment: string): void {
    if (!fragment) return;
    let addedQuotes = 0;
    for (let index = 0; index < fragment.length; index++) {
      const code = fragment.charCodeAt(index);
      if (code === 34 || code === 39) addedQuotes++;
    }
    const text = this.text + fragment.length;
    const quotes = this.quotes + addedQuotes;
    const renderWork = this.renderWork + text + quotes * quotes;
    if (
      text > CHAT_OUTPUT_LIMITS.text ||
      quotes > CHAT_OUTPUT_LIMITS.quotes ||
      renderWork > CHAT_OUTPUT_LIMITS.renderWork
    )
      throw new CodexError(
        "protocol",
        "This Chat reply exceeds Codex Wire's rendering budget. Use an ordinary workflow for large output. The unsafe fragment was not delivered and no retry was requested.",
      );
    this.text = text;
    this.quotes = quotes;
    this.renderWork = renderWork;
  }
}
