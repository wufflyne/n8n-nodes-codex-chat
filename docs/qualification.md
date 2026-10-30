# Qualification and distribution

Codex Wire 0.0.5 is qualified with synthetic accounts and provider responses on Linux amd64, Node 26.12.1, n8n 2.45.6, n8n-workflow 2.45.3 and LangChain Core 1.2.8. Standalone Agents use @n8n/agents 0.30.5, AI SDK 7.0.74 and OpenAI provider 4.0.20. This is an independent integration with a private subscription backend; these tests do not establish live entitlement, provider stability, model quality or cache savings.

## Install matched artifacts

The local distribution contains one `n8n-nodes-codex-chat-0.0.5.tgz`, a matched gateway/n8n image archive, context manifest, dependency lock and SHA256 checksums. The image archive excludes synthetic provider images and private runtime data. Verify the supplied checksums before loading images, then compare loaded image IDs with the distribution receipt. The receipt identifies exact source, package, context/overlay and image bytes. Keep the prior images and latest compatible state for rollback.

[Installation](install.md) describes embedded/community loading. [Gateway setup](gateway.md) describes companion assembly, separate inference/admin listeners, protected configuration and the required lifecycle integration. Installing the npm package does not launch the gateway. Stock n8n without the matched lifecycle overlay supports a fixed connection, not the full authenticated pool.

The community rehearsal installs the actual local tarball using pinned stock installer semantics and runtime dependencies. All four existing node identifiers, credential fields and host class identities are checked; no private LangChain copies or community-root peer symlink are used. The default matched n8n image can run standalone Agents without loading community nodes; community installation remains explicit.

## Tested contracts

| Surface | Synthetic coverage |
| --- | --- |
| Native workflows | Standard/Lite tools, Code/HTTP/Workflow tools, Router sticky continuation, model selector, simple memory, structured parser/chain/extractor/classifier, image binary, account visibility and execution usage |
| Standalone Agents | Actual server/API/database turns, reasoning continuity, approval/checkpoint restart, saved/inline/background children, helper/title/observation/reflector work and supplied-history truncation |
| Pool | 32 profiles, last eligible selection, 31 fresh quota denials, independent branches, account pinning and shared two-request account bound across native/Responses aliases |
| Continuity | Connection/account/model/known codec/branch ownership, item and call mappings, completed-operation replay, process restart, explicit legacy failure and immutable retry issuance |
| Safety | Malformed/late/disconnected output, no executable tools before validation/commit, actual SQLite FULL, capacity/retention, cancellation, shared renewal, failed startup and shutdown fences |
| Privacy and console | Explicit store:false DB/WAL/decrypted-content canaries, separate role keys, protected bootstrap/session/CSRF, interrupted one-time delivery recovery, delayed real-HTTP UI races and bounded device work |
| Packaging | Locked clean build, peer-free gateway imports, matched overlay, exact tarball inventory, clean image contents and actual archive save/load identity |

Retained Standard and Lite history never crosses codecs merely because model ID/account/branch stay the same. Missing or unknown pre-release codec proof returns `history_scope_unproven` before generation or completed response replay. No history is silently converted, dropped or restored. Published 0.0.4 had no gateway retained history, so its workflows, profiles and bindings remain compatible. See [recovery](gateway.md#retention-and-bounded-behavior).

Episodic memory requires its own compatible embedding backend. Synthetic qualification uses a separate embedding credential/provider; Codex Wire does not implement embeddings. The exact pinned standalone runtime exposes no user fork/regenerate endpoint; independent branch isolation is tested without claiming such a UI.

The lifecycle patch is narrow and version matched. Its NodeNext type differential has six baseline diagnostics, six patched diagnostics and zero introduced diagnostics. This is not a clean full upstream monorepo typecheck.

## Resource and performance interpretation

Tests use real private HTTP sockets and fixed cgroup limits: gateway 1 CPU/512 MiB, n8n 2 CPU/2 GiB and synthetic provider 0.5 CPU/128 MiB. Runtime external egress is disabled. Browser tests use a process-local route into those private addresses with Host/Origin/cookies preserved; they do not establish normal localhost reachability or streaming latency. Direct sockets measure streaming/backpressure.

Comparisons use identical canonical model inputs and provider chunk delays across published embedded, extracted embedded, native RPC and Responses paths at concurrency 1/2/8. Cold groups restart adapter processes and gateway/catalog/state workers while retaining durable DB and OS caches. Reports separate account queue wait from adapter latency and retain attempts, exact usage, CPU/RSS, event-loop delay and persisted-byte changes. Ten warm samples at concurrency one are descriptive, not an SLA. No synthetic timing measures live model quality or subscription savings.

Eight supported requests, each containing two 2.75 MiB images, produced three successes and five pre-admission capacity refusals under the gateway limit, with no gateway OOM. Larger input beyond the expanded-history bound is rejected before inference; that is not positive large-image support. SQLite FULL is induced with an actual database page limit; host OS ENOSPC is not simulated. A deliberately stalled shutdown preserves its owner fence and may require SIGKILL after the grace period; it is not a successful graceful exit.

## Deliberate limits

Assistant Chat Completions, embeddings, public image routes, hosted provider tools, direct PDF/audio/video, image editing, unknown codecs, distributed/multiworker ownership and purchases/top-ups are unsupported. Native image generation remains an explicit workflow action. Arbitrary external tool side effects do not gain a general exactly-once guarantee from gateway operation deduplication.

All real-account 0.0.5 device consent, rotating renewal, multiple-account entitlement, reset spending, image generation, model quality and cache economics remain unqualified. Historical 0.0.4 live observations in [compatibility metadata](../compatibility.json) describe only that baseline. Publication and deployment are separate operator decisions.

By [wufflyne](https://wufflyne.com).
