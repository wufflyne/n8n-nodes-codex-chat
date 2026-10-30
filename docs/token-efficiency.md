# Token efficiency

Defaults keep the same selected model, effort, full instructions/tools/history, image bytes/detail and answer requirements. There is no hidden optimizer, summary generation, truncation, compaction, response cache, inference coalescing or automatic model downgrade. Stable affinity can improve provider prefix reuse; it does not establish a subscription quota discount. Cached input remains context.

## Keep full quality

Keep instructions and tool schemas stable. Put deterministic calculations/projections into native nodes and return the complete task-specific result. Use Conversation affinity only with an explicit nonsecret account-scoped conversation key. Avoid unnecessary native parser repair. Codex Account → Get Execution Usage reads actual provider counts and call/field coverage for the selected profile in this execution; it performs no network/renewal. Missing/failed-call metrics stay unknown, zero stays actual zero. Cache ratio uses only calls with both reported input/cache counts and never claims an overall task hit rate from partial coverage. Images have operation counts and unavailable tokens.

## Concise answers — opt in

Choose existing Output → Verbosity → Low only if advertised. Keep model, reasoning effort, tools, memory and image detail unchanged. State required answer fields/content in the task. Concision can omit useful explanation; assess completeness before adopting it. A shorter reasoning summary does not prove less reasoning. Lower price/tier does not imply fewer tokens. Synthetic fixtures establish fields and calls, not real language-model quality equivalence or a savings percentage.

## Bound known context — opt in

Use an explicit Simple Memory window and task-specific native HTTP/Edit Fields/Code output projection or text extraction/retrieval. A window can forget older facts. Keep required IDs/units/source timestamps/error/pagination/completeness fields; return a retrieval path when more records exist. Arbitrary tool outputs are not rewritten by the adapter.

`getNumTokens` is a local **approximate text-content** heuristic: UTF-8 bytes divided by four, rounded up. It performs no tokenizer download and is not actual usage or a guaranteed upper bound. Explicit text arrays concatenate in original order; multimodal/unknown blocks fail clearly. Native `maxTokensFromMemory` counts only message content, omitting tools/schemas/replay/role/image tokens, and may trim partial human messages. It is unsuitable as a guaranteed Codex context cap and is absent from shipped tool/memory examples. Incomplete tool/replay turns fail before dispatch; the adapter does not repair history silently.
