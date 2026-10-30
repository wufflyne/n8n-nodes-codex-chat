# Codex Wire gateway and standalone Agents

Version 0.0.5 adds an explicit account owner service. The same Codex subscription profiles can serve native n8n workflows and standalone n8n Agents. Platform API credentials are never used as a fallback. The gateway does not execute tools; n8n remains responsible for tool execution and approvals.

The [qualification guide](qualification.md) describes the tested installation and its limits. The included isolated fixture uses synthetic accounts and provider responses. Real entitlement, renewal, model quality and reset effects require separate live verification.

## Choose a mode

| Mode                             | Account owner             | n8n configuration                                             |
| -------------------------------- | ------------------------- | ------------------------------------------------------------- |
| Embedded, default                | One n8n execution process | Existing store directory/key and unchanged account bindings   |
| Gateway with native workflows    | Gateway only              | Installation URL/key file; existing account bindings          |
| Standalone Agents, fixed account | Gateway only              | OpenAI credential with gateway `/v1` URL and inference key    |
| Standalone Agents, account pool  | Gateway only              | Same credential plus the matched server lifecycle integration |

Starting n8n or importing a node never starts an HTTP listener. Run `codex-wire-gateway serve --config /protected/gateway.json` explicitly. `doctor` validates configuration locally without acquiring an owner or contacting a provider. Local helper status and doctor remain read-only. Local helper mutations retain their original syntax and acquire exclusive ownership; they refuse while another owner is active. Use the console or online helper when the gateway owns the store.

## Deploy the companion

Use Node 26.12.1 and the reviewed 0.0.5 package. Keep the existing 32-byte master key in a protected file outside the profile directory. Gateway profile/envelope v1 stays compatible with existing binding IDs. The gateway database is a separate encrypted SQLite schema and must not be restored over current rotating tokens.

```json
{
  "version": 1,
  "inference": {
    "host": "0.0.0.0",
    "port": 8787,
    "privateHttp": true,
    "origin": "https://wire.example.com"
  },
  "admin": {
    "host": "0.0.0.0",
    "port": 8788,
    "origin": "https://wire-admin.example.com",
    "bootstrapFile": "/var/lib/codex-wire/control/bootstrap.key"
  },
  "storeDirectory": "/var/lib/codex-wire/profiles",
  "masterKeyFile": "/etc/codex-wire/master.key",
  "stateFile": "/var/lib/codex-wire/state/gateway.db",
  "contextIntegrationQualified": true,
  "refreshEnabled": true
}
```

Configuration and key files must be private regular files; profile/state directories must be private real directories. Terminate TLS at a protected operator-controlled ingress. The administration listener must not be exposed alongside public inference. An explicitly enabled `admin.allowLoopbackHttp` permits a loopback public origin for local testing, including a container internal bind: publish that port only on `127.0.0.1`, never a LAN/public address. Host/Origin, session and CSRF checks still apply. Do not publish private inference without authentication and transport protection.

`Dockerfile.gateway` assembles previously compiled runtime output. The reproducible matched n8n build requires the source checkout with `integration/scripts`, `integration/consumer` and `integration/n8n-2.45.6`. Build/test orchestration and synthetic fixtures are not shipped as npm operator commands. The npm artifact carries the reviewed patch and exact-source overlay compiler; building requires the pinned TypeScript 5.9.3 development dependency. Its dependency build uses explicit CPU/memory limits; final image assembly uses no network. The lifecycle runtime is neutral and loads without installing community nodes. A community installation remains separate and must use host LangChain/n8n-workflow identities; do not install private copies or symlink peers into the community root.

### Reproducible companion assembly

From the reviewed source checkout, with Node 26.12.1, prepare the consumer fixture before the source checks. Set npm cache and temporary directories to your chosen project-local paths when required by your environment. These commands build the same tarball and then install only its locked gateway runtime dependencies:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm ci --prefix integration/consumer --ignore-scripts --no-audit --no-fund
CODEX_WIRE_SDK_ROOT="$PWD/integration/consumer/node_modules" npm run check
mkdir -p artifacts
npm pack --ignore-scripts --pack-destination artifacts
BUILD_CONTEXT="$PWD/gateway-build-0.0.5"
mkdir "$BUILD_CONTEXT"
mkdir "$BUILD_CONTEXT/runtime"
tar -xzf artifacts/n8n-nodes-codex-chat-0.0.5.tgz \
  -C "$BUILD_CONTEXT/runtime" --strip-components=1
cp package-lock.json "$BUILD_CONTEXT/runtime/"
npm ci --prefix "$BUILD_CONTEXT/runtime" --omit=dev --omit=peer \
  --ignore-scripts --no-audit --no-fund
docker build --network=none -f Dockerfile.gateway \
  -t codex-wire-gateway:0.0.5 "$BUILD_CONTEXT"
```

Use a fresh build directory and retain earlier artifacts for rollback. Source/dependency preparation is the expensive step; `integration/scripts/bounded-build.sh` provides an explicitly CPU/memory-bounded container alternative for the full source qualification build. Final image assembly installs no packages.

Set `N8N_PRIVATE_NETWORK` to an existing private Docker network already attached to n8n, then adapt `compose.gateway.example.yaml` and private configuration. The template does not publish inference on the host. n8n reaches `http://codex-wire-gateway:8787` through that shared network; explicitly enable private HTTP for this deployment. Administration alone is published to host loopback in the example. A supervised local CLI deployment is separate: bind inference to loopback and run the client on that same host, or supply protected remote transport. Container loopback is not host loopback.

## Operator retention and resource settings

The protected configuration accepts optional `retention`, `admission` and `stateLimits` objects. Omitted values keep these defaults:

```json
{
  "retention": { "idleDays": 30, "absoluteDays": 90 },
  "admission": { "active": 8, "account": 2, "queued": 64, "waitMs": 10000 },
  "stateLimits": { "globalBytes": 1073741824, "connectionBytes": 268435456 }
}
```

All values are integers. Supported ranges are 2–30 idle days, 2–90 absolute days, 1–8 active requests, 1–2 per verified account, 0–64 queued requests, 100–10000 ms queue wait, and 32 MiB up to the displayed default for each state budget. Idle retention cannot exceed absolute retention; account concurrency cannot exceed total concurrency; the connection budget cannot exceed the global budget. Unknown fields and unsafe values fail startup. Apply changes by restarting the sole owner after a successful drain. Shorter retention clamps existing item and tool-call history at startup; it cannot restore expired content.

The connection budget aggregates encrypted history, stored operation responses and active reservations across their internal namespaces, including after restart. Other security namespaces retain their own bounded allocation within the global budget. Capacity refusal preserves existing records and unknown-outcome fences. Reservations cover the queue wait, full provider timeout and a 60-second commit allowance. These are encrypted payload budgets; SQLite indexes, WAL and filesystem overhead require additional disk space.

The 24-hour operation retry window, 48-hour outcome tombstones, single-branch admission, 32 MiB wire limit, 8 MiB expansion limit and shared 320 MiB memory admission budget are fixed safety contracts. The two-day history minimum preserves completed-operation result replay through its separate 48-hour lifetime. These settings do not change model semantics or truncate content. The console displays effective retention in connection consent and resource settings under **Advanced limits**.

## Connect accounts and n8n

Open the protected console, read the one-time bootstrap token from its operator file, and create an administrator passphrase. Add a dedicated renewable session through device login or a protected manual import. Device login shows the provider's verification URL/code; it expires after 15 minutes and can be cancelled. At most eight attempts may be starting, active or finalizing. Settled statuses remain for up to 15 minutes and may be evicted earlier when a new attempt needs a slot; their encrypted pending setup bundles remain separately recoverable. Never share one rotating refresh-token family with another owner. Reconnect verifies the same account identity and preserves existing binding IDs.

The four views show an overview, searchable accounts, connections, and activity/settings. Limits are refreshed only by an explicit action. Email/plan metadata retains its verified source, unknown values stay unknown, and credits do not imply an invented currency. New credentials are masked and require explicit copy/download and acknowledgement before activation. Open **Resume Interrupted Setup** to recover the same pending bundle after a lost response or browser reload. The protected list contains labels and expiry metadata; secrets appear only after an explicit open. Bundles expire after one hour. Acknowledged or revoked keys cannot be reconstructed.

For standalone Agents create an Agents connection. In n8n choose **OpenAI**, name the credential **Codex Wire**, set **Base URL** to the displayed URL ending in `/v1`, and use its inference key. Leave organization and custom headers empty. `/v1/models` returns only catalog-backed compatible text models. Unsupported direct files/audio/video, hosted tools and provider options fail before generation. Use ordinary n8n preprocessing/tools for unsupported modalities. Native Codex Image remains the separate image generation action.

For native workflows, open **About n8n** and copy its **Instance ID** exactly. Use this value as the installation ID when creating the installation bundle, then configure n8n:

```text
N8N_CODEX_MODE=gateway
N8N_CODEX_GATEWAY_URL=https://wire.example.com
N8N_CODEX_GATEWAY_TOKEN_FILE=/protected/installation.key
```

Explicit private container HTTP additionally requires `N8N_CODEX_GATEWAY_PRIVATE_HTTP=true`. Remove all profile-store/key/refresh variables and mounts from n8n; mixed ownership is rejected. The four node IDs, `codexAccount` credential, `profileId` and `bindingSecret` fields stay unchanged. Installation credentials and inference keys are distinct. Reset actions require an explicit installation scope plus the existing action-level opt-in; inference connections cannot spend reset credits.

## Enable the full account pool

Install the exact n8n 2.45.6 / @n8n/agents 0.30.5 source patch and matched neutral runtime. Configure its protected `N8N_CODEX_CONTEXT_CONFIG_FILE`:

```json
{
  "version": 1,
  "installationId": "instance-id-copied-from-about-n8n",
  "installationKeyFile": "/protected/installation.key",
  "journalDirectory": "/private/codex-context",
  "gatewayOrigins": ["https://wire.example.com"]
}
```

For the recommended combined native and Agents setup, use that same actual n8n Instance ID in the installation bundle, pool connection policy and context configuration above. The shared installation key needs the selected native profile scopes and the permitted inference connection IDs. An advanced context-only deployment may use a separate chosen installation ID/key, but its context file and connection policy must match it; that key does not authorize native workflow RPC. A mismatch fails visibly before inference.

The server derives project/agent revision/conversation/branch/run/turn identity from accepted execution state, persists an operation before send, and reuses it across SDK retries and checkpoint resume. Attempt timestamps are separate. An authenticated artifact handshake activates a pending pool connection; setting a configuration boolean alone is insufficient. No static custom header or inference key can impersonate this integration. Context secrets are attached only to exact allowlisted Responses endpoints; redirects fail closed and internal headers are stripped before provider transport.

A new branch considers its ordered profiles; synthetic qualification covers 32 accounts. Known exact-model or capability mismatches are skipped before inference; authentication or catalog failures stop the request. Duplicate profiles for one verified account share admission limits and are not retried as separate quota candidates. Only a fresh applicable quota denial before HTTP admission permits another account. Any successful admission pins the account through text, tools, helpers and later turns. Removing an account from new candidates does not repin existing branches. Disable a connection to stop its existing branches. Deleted/expired/cross-account history cannot silently restart a branch elsewhere. Physical profile deletion is not provided; deliberate store maintenance must stop and fence owners and preserve unresolved pins/journals.

## Retention and bounded behavior

By default, stored Responses retain encrypted canonical items locally for 30 days idle and at most 90 days absolute; the operator may shorten these periods within the bounds above. Only supplied history is replayed. Opaque references are scoped to connection/account/model/route-codec/branch; no prompt fingerprints restore hidden context. `store:false` retains no prompt/response body and cannot resolve retained item or call handles, even when they appear inside inline messages/calls. Switching modes requires complete inline provider history without reserved `item_cw_`/`call_cw_` handles, or a deliberate new conversation; the gateway never strips handles or reconstructs omitted content. Tool and direct-output schemas use an isolated request-local validator cache for `store:false`; schema text and validation errors do not enter the shared cache. Operational identity/unknown-outcome fences and bounded token metadata remain separately. Disable and drain a connection before deleting retained history; deletion preserves account pins and unresolved operation fences.

Retained items, tool-call mappings and completed-operation replay carry the same server-selected codec revision (`responses-v1` or `responses-lite-v1`). A catalog change between Standard and Lite under the same model ID cannot reuse those records. Pre-release gateway records lacking codec proof fail closed with `history_scope_unproven`; retain them for deliberate recovery and begin a new conversation when continuity cannot be proved. No automatic history conversion, migration or deletion occurs. Published 0.0.4 profiles, bindings and workflows are unaffected because that version had no gateway history. The SQLite envelope/schema remains v1; the codec marker versions local replay semantics, not a promise of future provider protocols.

Text streams incrementally. Tool headers and arguments are withheld until the entire terminal output is validated and committed durably. A late failure leaves provisional text and an SDK-supported nonretryable error; tools are not released. Before headers a continuity/unknown-outcome error uses HTTP 422. After a stream has started HTTP remains 200 and the error event carries code `422`. Refusal behavior is limited by the pinned SDK and is not a successful empty answer.

An ordered pool waits for the first eligible account's available slot; the global active limit does not distribute new branches across idle later accounts. Use deliberately scoped independent connections when you need independent account scheduling. Local queue pressure never becomes evidence of quota exhaustion.

A proven rejection keeps a terminal `operation_rejected` fence for that operation ID. Inspect the original error; for quota, explicitly refresh limits and wait until the reported reset time, or use a separately authorized earned-reset action. A later turn stays on its conversation account; choosing another account requires a deliberate new conversation. A lost transport or uncommitted admitted result remains `outcome_unknown` and must be reconciled. Neither outcome automatically redispatches the same operation.

Default limits include eight active generations, two per account, one per verified branch, 64 queued waiters and a ten-second admission wait; 32 MiB wire bodies, 256 references, 4 MiB individual retained records and 8 MiB expanded history. Aggregate memory reservations include request expansion and image artifacts; oversized requests return 413, occupied capacity 429 before dispatch. Slow body/readers, disconnects and cancellation abort work. Tool/output/SSE bounds may reject exceptionally large valid provider results; no automatic truncation or quality downgrade occurs.

Logical operation issuance is immutable with a 24-hour retry window. Tombstones last 48 hours; even after cleanup an expired operation cannot become new work. Native RPC unknown/completed duplicate operations fail closed when their result was not retained. Gateway restart preserves completed stored Responses and fences; it does not promise resumable native workflow execution.

## Upgrade and recovery

Stop and operationally fence every old writer first, including binaries that do not understand the new lock. Drain active requests and wait for shared token refresh completion. Keep immutable code backups separately from the latest credential state.

```sh
codex-wire-gateway transfer-store --config /protected/current.json \
  --target-directory /private/new-owner-profiles --owners-stopped-and-fenced
```

The target must be new. Transfer verifies independent encrypted copies, current tokens, binding hashes, import/reset uncertainty journals and lock directories. It neither refreshes nor restores stale secrets. Remove old owner's store/key access before starting the new owner. Shutdown stops new admissions and joins device activation, asynchronous request handlers and persistence cleanup before releasing ownership. The Compose templates allow 120 seconds before Docker sends SIGKILL. The application gives active handlers and device work 60 seconds to settle; a shared OAuth refresh has a 30-second transport deadline and its durable commit must also finish. The extra grace covers healthy commit latency, not indefinitely stalled storage. A bounded drain failure preserves the owner fence. A hard-killed process leaves an owner fence; investigate and stop every possible writer before deliberate offline recovery. Never remove a fence merely because it is old.

For rollback keep the latest token generation and journals. Returning to embedded mode ends gateway-only continuity: disable/drain/stop the gateway, transfer the current v1 store, restore the old code, then grant that process exclusive access. Retain the gateway database for audit and future compatible restart. Unknown refresh requires identity-preserving reconnect; unknown reset requires the existing reconciliation path. Never restore a stale token backup to undo a refresh or reset.

Optional Assistant/AI-assisted building is unqualified and has no Chat endpoint in this release. Token savings, quality equivalence, future model protocols and live account entitlement are not inferred from synthetic tests.

### Matched lifecycle coverage

Accepted standalone turns and saved workflow-Agent executions supply durable host admission time. Delegated/background children capture parent provenance before dispatch and restore it from checkpoints. Inline workflow-Agent entrypoints read the original persisted n8n execution start time using the trusted execution ID. Missing execution records or admission timestamps fail closed for attested gateway calls; ordinary other-provider flows remain unaffected. Synthetic exact-image tests exercise this path against the real execution database. Stock n8n 2.45.6 has no user fork/regenerate endpoint in this Agents implementation. Independent branches are isolated; copying another branch's opaque history handles is rejected. This release does not add a fork UI or promise cross-branch history cloning.

The protected control registry is bounded to 256 issued key records. Revoked records remain auditable and cannot be reactivated by acknowledging an earlier delivery. Reaching the bound requires deliberate operator migration rather than silent deletion of old security records.

By [wufflyne](https://wufflyne.com).
