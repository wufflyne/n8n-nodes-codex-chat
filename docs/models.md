# Models, inputs and native execution

Codex Wire performs one model generation per invocation. n8n owns the Agent loop, tool execution, parsing, memory and workflow retries. Requests use the pinned Codex client contract directly over HTTP; the adapter does not launch a CLI agent.

## Catalog and settings

The authenticated account catalog determines available model IDs and known capabilities. The picker caches results for up to five minutes; **Codex Account → Refresh Models** forces a refresh. New IDs appear automatically when the catalog supplies a supported route discriminator. Unknown protocols or modalities require a code update. Existing workflows retain their selected model.

**Provider Default (No Override)** omits a field. An **Advertised Default** is catalog metadata, not proof of the server's hidden effective choice. Reasoning, verbosity, speed and other optional controls are validated against the selected model. No automatic model, effort, verbosity or image-quality downgrade is performed.

Standard Responses and Responses Lite are selected only by the known authenticated catalog discriminator. The implementation follows Codex client `0.166.0`, commit [`55c099a142eb302188fee00ab9e9062f2db1c359`](https://github.com/openai/codex/tree/55c099a142eb302188fee00ab9e9062f2db1c359). The private backend may change independently. Public Platform/SIWC request fields are not automatically supported here.

## Tools and structured output

Use native n8n tools with the AI Agent. Tool names, schema snapshots, provider IDs and tool results are validated through each turn. Accepted or ambiguous generations are not retried automatically. Incomplete or inconsistent tool history fails before dispatch.

For structured results in an ordinary workflow, attach **Codex Output Parser** to a native AI Agent or Basic LLM Chain. Enter an object JSON Schema in its normal field. The parser preserves your strict schema, returns validated data, and stops on invalid output. It makes no repair call and does not convert the schema through the host's Zod parser. Nested arrays and objects are supported within finite byte, depth and property-count bounds. Expressions are evaluated by the parser in its own native context; standard sub-node first-item behavior applies.

The stock Structured Output Parser and Information Extractor remain host-dependent integrations. The pinned Zod version can exhaust memory while accumulating errors for a large invalid collection; those host parsers are not qualified for untrusted model output here. Use Codex Output Parser instead. Information Extractor also owns an output-repair call; an explicit native auto-fixing wrapper may independently request another generation. Installing this package does not patch those host classes.

For direct library use, `withStructuredOutput` supports `functionCalling` and explicit `jsonSchema` with an exact local output contract. `includeRaw` returns JavaScript `{raw, parsed}`; a parse failure yields `parsed: null` without an adapter repair generation.

Sparse-array results from a caller's Zod parser are rejected. Older Zod v4 async-tuple parsing can produce such results; use plain JSON Schema or a compatible parser for that case. Result inspection is bounded to depth 64 and 65,536 properties/array slots and preserves ordinary Zod transformations.

In the pinned n8n Agent V3, Code Tool can receive host-added call metadata such as `toolCallId`. A manual schema with `additionalProperties: false` can therefore reject that tool input even when the enclosing Agent finishes. Declare the metadata your tool accepts, or allow additional properties when that matches the tool's contract, and check the actual tool result. Codex Wire does not alter a user schema to bypass this validation.

## Chat in n8n

The private Chat Hub workflow route supports Chat Trigger connected directly to one native AI Agent, one fixed Codex Chat Model and optional native memory. Tools, attached output parsers, Router/Fallback and additional main output nodes are refused before provider effects. Ordinary workflows retain their tools, structured output, memory and Router support.

New Codex assistant text is checked before every streamed fragment, callback and final tail reaches the host renderer. Limits are 262,144 UTF-16 text units, 1,024 ASCII quote characters and a cumulative rendering-work budget. A response over a limit stops with a controlled error; its unsafe fragment is never delivered, truncated or rewritten. A safe prefix may already be visible. If Chat shows a generic workflow error, open the workflow’s execution to inspect the controlled cause. Large non-Chat replies retain their existing bounds. These controls cover this supported Codex Chat route, not other providers, old stored messages or arbitrary host tool output.

## Photo inputs

Image input requires explicitly advertised image modality. Canonical LangChain image forms and supported native n8n binary attachments are accepted. Supported raster signatures, byte sizes, image count/detail and HTTPS URL boundaries are validated. n8n loads binary attachments; the adapter does not open host image paths or fetch image URLs itself.

Direct PDF/files/audio/video, embeddings, realtime/background threads and hosted web/file-search/computer tools are unsupported. Native tools or preprocessing can independently extract ordinary text for a model request. See [token guidance](token-efficiency.md) for text estimation and explicit memory windows.

## Memory and account choice

For a conversation with memory, select an account **before** the Agent using Refresh Limits → native Model Selector. Include the selected account alias in the Simple Memory session key. This is preselection; quota may change between the read and inference.

Memory nodes determine which message metadata survives. Stock Agent V3 reconstructs split tool-call messages with blank visible text; Codex Wire restores their original provider group once, including its text, phase and retained opaque reasoning. Matching nonempty split text also remains valid after serialization; conflicting text is rejected. Stock Simple Memory constructs the final assistant message from its visible string and does not retain that final message's provider metadata. Codex Wire preserves eligible metadata that actually survives; it does not invent missing final reasoning or restore history outside the supplied memory window.

The **Codex Account Router** supports 2–5 ordered accounts with the same explicit model and semantic settings for one fresh Agent invocation. It rejects attached memory, native Agent Fallback, prior AI/tool history, overlapping calls and a second root invocation in the same execution. Declare its exact consumer Agent name. Public APIs cannot certify the absence of another undeclared consumer; use one input item or a distinct sub-workflow execution per invocation.

An initial HTTP 429 may advance to another account only after a new authenticated read confirms applicable included-quota exhaustion. Every HTTP 2xx pins immediately, even if its stream is empty or fails. Network ambiguity, partial output and later tool turns never move to another account. Native Agent Fallback operates per step and is unsupported for safe cross-account recovery.

Manual reset and optional same-account automatic recovery have separate [earned-credit and uncertainty rules](account-recovery.md). Reset policy never authorizes repeating a completed generation or tool.

## Image generation

**Codex Image** uses the fixed Codex account ImagesClient endpoint and source-pinned `gpt-image-2` action. It returns one native binary item per input item. Input validation and binary delivery are tested with synthetic providers; current real-account image generation remains unverified.

Automatic reset and internal account switching are unavailable because an image-specific quota/reset mapping is unverified. A new workflow retry or execution can generate another image. For delivery, use the main flow or Respond to Webhook. Workflow Tool commonly serializes JSON only, so the bundled tool example returns metadata while its Webhook branch returns bytes. Inline Agent chat attachment rendering is not promised. Image editing is outside this release.

By [wufflyne](https://wufflyne.com).
