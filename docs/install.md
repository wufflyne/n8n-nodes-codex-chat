# Native installation and account management

Use an existing trusted self-hosted n8n instance. The pinned tested runtime is n8n 2.45.6, n8n-workflow 2.45.3, LangChain Core 1.2.8 and Node.js 26.12.1. Community and unverified packages must be allowed by the operator. Normal setup uses the native GUI; [legacy installation](legacy-install.md) applies only to already configured older deployments.

## Install and keep one service active

1. Open **Settings → Community Nodes → Install** and install `n8n-nodes-codex-chat@0.1.1`, accepting n8n's community-code notice. See [n8n's GUI installation guide](https://docs.n8n.io/integrations/community-nodes/installation/gui-install/).
2. Create a workflow named **Codex Wire Setup** and add **Codex Wire Service**, or import the supplied [setup workflow](../examples/codex-wire-setup.json).
3. In its native selector create **Codex Wire Manager**. Choose a long, unique Manager Passphrase: at least 12 characters and at most 1024 UTF-8 bytes. Save the credential, save the workflow, then activate/publish it.
4. Use the Manager credential's **Test** to check local readiness. Activation/deactivation acknowledgements describe publication; actual startup and drain may finish later. A stopping/inactive service is unavailable for new account work.

Use one Manager for this n8n instance and multiple Accounts under it. Keep the service workflow active. Sharing this Manager is deliberate account-administration delegation; an Account credential alone does not authorize connection management. Keep the original credential and passphrase unchanged. Creating another credential with the same name/passphrase cannot replace the permanent owner ID.

The existing persisted n8n data directory contains the plugin's private `codex-wire` subdirectory. n8n encrypts the Manager passphrase and runtime bindings. The passphrase authenticates a private random-key wrap; a hidden root-key cache is recoverable after a stale credential-modal save. No plugin key, profile directory, environment variable or manual secret transfer is required. Preserve n8n's existing persistence and credential-encryption configuration; the plugin never reads its encryption key or a global Codex login.

## Connect and use an account

In a separate ordinary workflow add **Codex Account**. Select **Start Sign-in**, create/save a named **Codex Account** credential, leave Advanced Binding Mode managed, and select the original Manager credential. Execute once. Only the provider verification URL, public user code, expiry and next action are returned. Open that URL, authorize your account, then execute **Complete Sign-in**. Waiting does not hold a workflow open or poll in the background; each explicit completion respects the provider interval and expiry.

Device-code login is beta. Enable it in personal ChatGPT security settings or obtain workspace-administrator permission where required. [Official provider guidance](https://learn.chatgpt.com/docs/auth) is authoritative for availability. Synthetic testing does not prove live consent or subscription entitlement.

Attach **Codex Chat Model** to a native AI Agent/chain and select the connected Account. Run **Refresh Models** in Codex Account to populate the local catalog, then select an advertised model or its exact ID. Capability/reasoning/tier/verbosity pickers only read a local snapshot; an empty/expired list needs an explicit refresh. Execution validates current catalog membership, exact model and known codec. It does not guess a fallback model or setting.

Use **Status** and credential **Test** for local observations. They do not sign in, renew, reset or infer. **Refresh Models**, **Refresh Limits**, **List Reset Credits** and execution are explicit operations and may renew an eligible managed session. Read-only legacy remote pickers use bounded local snapshots obtained by explicit refresh; they do not silently contact the owner/provider while browsing.

## Chat in n8n

Import [Codex Wire Chat](../examples/chat-hub.json) through the workflow menu. Open Codex Chat Model, select one connected Account credential, and choose a model from its refreshed catalog. The workflow contains no Manager credential or account-management action.

In Chat Trigger, keep **Make Chat Publicly Available** off and **Make Available in n8n Chat Hub** on. Keep **Enable Streaming** on in AI Agent, then save and publish the workflow. Open **Chat**, start a new chat and select **Codex Wire** under Workflow agents. If Chat is hidden, an instance owner can enable it under **Settings → Chat**. These are standard n8n controls; no provider API key is needed for this workflow agent.

The template attaches Simple Memory with a ten-turn window. n8n scopes that memory by workflow and the chat session ID; the template adds a fixed account namespace. Keep one Account credential on this workflow. For another account, duplicate the workflow and start a new chat. If you intentionally replace the account in the same workflow, change the memory namespace and begin a new chat first. Never route an existing conversation across accounts. Simple Memory is process-local and does not preserve final assistant opaque provider metadata; it does not provide restart-safe tool continuation.

Only share this runtime workflow with the intended users through n8n's normal workflow/project controls. Keep the Service and account-management workflows private. Sharing and dedicated Chat user roles depend on your n8n edition. See [n8n's Chat Hub guide](https://docs.n8n.io/build/ways-of-building-workflows/chat-hub.md).

Chat Hub workflow agents are separate from the standalone **Agents** builder and personal provider agents. This template does not supply a native OpenAI credential, embeddings or standalone account pooling.

## Reconnect, cancel and import

**Cancel Sign-in** stops a waiting attempt. It does not disconnect an established account or erase an uncertain token exchange. **Reconnect** begins an independent sign-in while preserving the original binding and verified identity; choosing another account is refused. Create a separate Account credential and memory scope for another identity.

Stopping a workflow is separate from Cancel Sign-in. Cancellation is checked before queued admission and provider dispatch, and through activation's precommit checks. A dispatched rotating exchange/renewal is captured and settled; cancellation never replays it or rolls a committed generation backward. Check local Status/Complete Sign-in afterward for the actual durable outcome.

For advanced manual import, paste session JSON only into the Manager credential's **Advanced Session Import** password field, save it, choose **Import Session** and the correct format in Codex Account, then execute. Supported formats are the existing Codex auth JSON (`auth_mode: chatgpt`, `tokens`) and explicit Codex token set with matching provider/client ID. API keys, refresh-only input and unsupported fields are rejected. Use an independent authorized session that another client will not keep renewing. Identity is verified before expired-session renewal or reconnection.

Never put tokens or import JSON in workflow input, parameters or static data. An input rejected before admission can be corrected in the same credential field. Once an import is admitted, its receipt and any uncertain renewal stay fenced; do not replace that input to bypass recovery. Repeating the same completed import is idempotent. Clear the optional import source in the native Manager modal afterward, retaining the original passphrase. The application does not promise an automatic clearing write that could overwrite a concurrent credential edit.

Completed/cancelled/expired reconnect history keeps only bounded recent metadata. Unresolved captures and unknown exchanges remain retained and cannot be retried or silently discarded. A genuine unresolved-history/storage limit leads to a separate Account credential and separate conversation memory, rather than an invented maintenance command or erased uncertainty.

## Restart and recovery

The service holds OS-backed SQLite leases until admitted operations, rotating renewals, journal writes and detached reads have settled. New admission stops during close. Process death releases the OS lock; the same saved service workflow reopens the same wrapped root and current journals. Both older owner paths stay permanently fenced. No PID/age-based lock stealing occurs. Only one local execution process and supported local filesystem are qualified; queue/multi-main and shared-network-filesystem ownership are unsupported.

A captured successful exchange can finish locally with **Complete Sign-in** after restart, without another token POST. An exchange/renewal with an unknown outcome is not replayed: use independent **Reconnect**. Missing established journals/claims/wraps and wrong passphrases fail closed. Keep latest state, the original Manager credential and current n8n persistence together. Do not restore old token snapshots, delete fences, regenerate a root, or replace a lost Manager with a same-name credential.

Legacy credentials keep their original fields and saved node/operation IDs. Advanced Binding Mode exposes an established legacy binding form. Configured legacy embedded/remote use remains separate; native setup refuses in-place adoption if it cannot prove exclusive legacy handover. The retained helper/console and patched companion are historical compatibility surfaces, not prerequisites for a new native setup.

The separate Agents builder, full standalone pooling and automatic native OpenAI-credential creation are unsupported on stock n8n. Use a native workflow AI Agent, optionally exposed through Chat Hub. See [support boundaries](../README.md#support-boundaries).

By [wufflyne](https://wufflyne.com).

For structured results in an ordinary workflow, attach **Codex Output Parser** and enter an object JSON Schema. The private Chat route uses one fixed model with optional memory; keep tools, parsers, routing and additional output nodes in ordinary workflows. See [model and parser scope](models.md#tools-and-structured-output).
