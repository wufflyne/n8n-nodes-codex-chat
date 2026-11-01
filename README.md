<h1 align="center">Codex Wire for n8n</h1>

<p align="center">Codex subscription accounts inside native n8n workflows.</p>
<p align="center"><strong>v0.1.1</strong> · Stock self-hosted n8n · Six nodes · MIT</p>

Codex Wire connects your independently authorized Codex account to native n8n AI Agent workflows, tools, memory and parsers. Install one community package into an existing n8n instance. Setup and account management use native credentials, nodes and one active service workflow. By [wufflyne](https://wufflyne.com).

This is an independent, experimental integration with the private Codex backend. Account entitlement, available models and allowance belong to the provider. Synthetic qualification does not establish live entitlement, model quality or token savings.

## Set up in n8n

1. Open **Settings → Community Nodes → Install**, enter `n8n-nodes-codex-chat@0.1.1`, acknowledge the community-code notice and install.
2. Add **Codex Wire Service** to a saved workflow, or import [Codex Wire Setup](examples/codex-wire-setup.json). Create a **Codex Wire Manager** credential and choose a long, unique passphrase (at least 12 characters). Save it and activate the workflow. Credential **Test** confirms actual local service readiness; publishing can finish before the service starts.
3. In another workflow, add **Codex Account**, select **Start Sign-in**, create a named **Codex Account** credential, and select the Manager. Run once. Open the returned provider verification URL and enter the public code, then run **Complete Sign-in**.
4. Attach **Codex Chat Model** to a native **AI Agent**, select the same Account credential and run **Codex Account → Refresh Models** to populate the local model picker. Select an advertised model or use its exact ID.

Use **one Manager for the instance and multiple Account credentials under it**. Keep the service workflow active and retain the original Manager credential/passphrase. Sharing the Manager deliberately delegates administration; sharing an Account grants account use, without sign-in/import/reassignment authority. Normal setup requires no shell, environment key, opaque binding copy, custom host or external management panel.

Device-code login is beta and may need enabling in personal ChatGPT security settings or workspace permissions. See [official authentication guidance](https://learn.chatgpt.com/docs/auth). The provider's own verification page is the only external step.

[Complete native setup, import and recovery](docs/install.md) · [Security boundaries](docs/security.md) · [Upgrade and compatibility](docs/upgrade.md)

## Chat in n8n

Import [Codex Wire Chat](examples/chat-hub.json), assign your connected Account credential and model, then publish the workflow. In **Chat**, select **Codex Wire** and send a message. If Chat is hidden, an n8n owner can enable it under **Settings → Chat**. The workflow keeps one account for the conversation and uses native Simple Memory. This Chat route supports one Agent with one fixed Codex model and optional memory. Use ordinary workflows for tools, output parsers, routing and custom output nodes; those Chat combinations are refused before provider work. Replies have finite rendering budgets. Keep account-management workflows private. [Chat setup and memory scope](docs/install.md#chat-in-n8n).

## Nodes and account actions

| Node | Purpose |
| --- | --- |
| **Codex Wire Service** | Owns the private store through normal activation/close lifecycle. Keep one active service for the Manager. |
| **Codex Chat Model** | Native AI workflows, streaming, tools, structured output and supported photo input. |
| **Codex Output Parser** | JSON Schema output for native Agent and Basic LLM Chain, with local validation and no repair call. |
| **Codex Account** | Sign-in, complete/cancel, reconnect, encrypted manual import, local Status, explicit model/limit refresh, reset allocations and execution usage. |
| **Codex Account Router** | Ordered 2–5 accounts for a fresh invocation. The admitted account stays fixed through tool turns. |
| **Codex Image** | Generate images with native binary output. |

Status, credential Test and editor pickers are local observations. They never start sign-in, renew a session, consume a reset or generate. Model/capability snapshots expire after five minutes; reset-credit lists require a recent explicit refresh. Execution and explicit Refresh Models/Limits may renew an eligible managed session. Missing metadata, limits, balance and units stay unavailable rather than invented.

Automatic reset is off by default. Manual reset needs an eligible earned allocation and explicit acknowledgement. Unknown outcomes stay fenced; no purchase or top-up behavior exists. Router fallback is only for a fresh, unadmitted request after an initial quota rejection and fresh authenticated evidence. Attached memory and native Agent Fallback are unsupported on the Router path.

For structured results, connect **Codex Output Parser** to the Agent or Basic LLM Chain and enter an object JSON Schema. The pinned host’s Zod-based parsers are outside qualification for untrusted model output; see [models and parsers](docs/models.md#tools-and-structured-output).

## Examples

[Chat in n8n](examples/chat-hub.json) · [Basic Chat](examples/basic-chat.json) · [Tools and Structured Output](examples/tools-and-structured-output.json) · [Account Selection with Simple Memory](examples/account-selection-with-simple-memory.json) · [Fresh Account Router](examples/fresh-agent-account-router.json) · [Native Binary Image](examples/generate-image-native-binary.json)

Examples use the npm community namespace. Assign credentials before running. Keep separate account/conversation memory. Stock Simple Memory is process-local and does not retain final assistant opaque provider metadata. Saved Chat history does not guarantee restored provider context after a restart; discarded provenance is never reconstructed. In-flight tool continuation after a process restart requires a fresh execution.

## Support boundaries

The pinned stock stack is n8n `2.45.6`, n8n-workflow `2.45.3`, LangChain Core `1.2.8`, Node.js `26.12.1`. Native operation supports one local execution process and local persisted private storage. Queue/multi-main/shared-network-filesystem coordination is unsupported.

The original four node IDs, saved operation IDs and `codexAccount` / `profileId` / `bindingSecret` ABI remain. Existing configured embedded/remote installations retain their guarded legacy use path and advanced credential binding form. In-place GUI adoption is refused when exclusive legacy handover cannot be proven; no key, binding or journal is silently replaced.

**The separate Agents builder and full standalone account pool are not supported on unmodified stock n8n.** That legacy pool requires trusted host branch/checkpoint attestation, and stock provider selection offers no supported plugin API to create its native OpenAI credential automatically. Use Codex Chat Model in a workflow AI Agent. Chat Hub can expose that workflow in n8n Chat; it does not add a Codex provider to the separate Agents builder.

[Legacy 0.1.0 overview](docs/legacy-v010-overview.md), [legacy installation](docs/legacy-install.md) and [guarded gateway](docs/gateway.md) preserve those capabilities and provenance. Their custom companion/security layers are not applied by native community installation and are not properties of the stock host. The native package is distributed through npm and GitHub.

[Models and codecs](docs/models.md) · [Account recovery](docs/account-recovery.md) · [Prompt affinity and usage](docs/token-efficiency.md) · [Qualification scope](docs/qualification.md) · [Compatibility metadata](compatibility.json)
