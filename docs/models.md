# Models, inputs and native execution

Codex Wire performs one model generation per invocation. n8n owns the Agent loop, tool execution, parsing, memory and workflow retries. Requests use the pinned Codex client contract directly over HTTP; the adapter does not launch a CLI agent.

## Catalog and settings

The authenticated account catalog determines available model IDs and known capabilities. The picker caches results for up to five minutes; **Codex Account → Get Models** forces a refresh. New IDs appear automatically when the catalog supplies a supported route discriminator. Unknown protocols or modalities require a code update. Existing workflows retain their selected model.

**Provider Default (No Override)** omits a field. An **Advertised Default** is catalog metadata, not proof of the server's hidden effective choice. Reasoning, verbosity, speed and other optional controls are validated against the selected model. No automatic model, effort, verbosity or image-quality downgrade is performed.

Standard Responses and Responses Lite are selected only by the known authenticated catalog discriminator. The implementation follows Codex client `0.166.0`, commit [`55c099a142eb302188fee00ab9e9062f2db1c359`](https://github.com/openai/codex/tree/55c099a142eb302188fee00ab9e9062f2db1c359). The private backend may change independently. Public Platform/SIWC request fields are not automatically supported here.

## Tools and structured output

Use native n8n tools with the AI Agent. Tool names, schema snapshots, provider IDs and tool results are validated through each turn. Accepted or ambiguous generations are not retried automatically. Incomplete or inconsistent tool history fails before dispatch.

Native output parsers remain n8n-owned. A parser configured to repair output may invoke the model again. For direct library use, `withStructuredOutput` supports automatic `functionCalling` and explicit `jsonSchema` with local Ajv/Zod validation. `includeRaw` returns JavaScript `{raw, parsed}`; a parse failure yields `parsed: null` without an adapter repair generation.

## Photo inputs

Image input requires explicitly advertised image modality. Canonical LangChain image forms and supported native n8n binary attachments are accepted. Supported raster signatures, byte sizes, image count/detail and HTTPS URL boundaries are validated. n8n loads binary attachments; the adapter does not open host image paths or fetch image URLs itself.

Direct PDF/files/audio/video, embeddings, realtime/background threads and hosted web/file-search/computer tools are unsupported. Native tools or preprocessing can independently extract ordinary text for a model request. See [token guidance](token-efficiency.md) for text estimation and explicit memory windows.

## Memory and account choice

For a conversation with memory, select an account **before** the Agent using Get Limits → native Model Selector. Include the selected account alias in the Simple Memory session key. This is preselection; quota may change between the read and inference.

The **Codex Account Router** supports 2–5 ordered accounts with the same explicit model and semantic settings for one fresh Agent invocation. It rejects attached memory, native Agent Fallback, prior AI/tool history, overlapping calls and a second root invocation in the same execution. Declare its exact consumer Agent name. Public APIs cannot certify the absence of another undeclared consumer; use one input item or a distinct sub-workflow execution per invocation.

An initial HTTP 429 may advance to another account only after a new authenticated read confirms applicable included-quota exhaustion. Every HTTP 2xx pins immediately, even if its stream is empty or fails. Network ambiguity, partial output and later tool turns never move to another account. Native Agent Fallback operates per step and is unsupported for safe cross-account recovery.

Manual reset and optional same-account automatic recovery have separate [earned-credit and uncertainty rules](account-recovery.md). Reset policy never authorizes repeating a completed generation or tool.

## Image generation

**Codex Image** uses the fixed Codex account ImagesClient endpoint and source-pinned `gpt-image-2` action. It returns one native binary item per input item. Input validation and binary delivery are tested with synthetic providers; current real-account image generation remains unverified.

Automatic reset and internal account switching are unavailable because an image-specific quota/reset mapping is unverified. A new workflow retry or execution can generate another image. For delivery, use the main flow or Respond to Webhook. Workflow Tool commonly serializes JSON only, so the bundled tool example returns metadata while its Webhook branch returns bytes. Inline Agent chat attachment rendering is not promised. Image editing is outside this release.
