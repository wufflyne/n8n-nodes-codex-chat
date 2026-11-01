# Qualification and distribution

Codex Wire 0.1.0 targets Linux amd64, Node 26.12.1, n8n 2.45.6, n8n-workflow 2.45.3 and LangChain Core 1.2.8. Standalone Agents use @n8n/agents 0.30.5, AI SDK 7.0.74 and OpenAI provider 4.0.20. [Compatibility metadata](../compatibility.json) and the exact release receipt identify the artifact bytes and qualification scope. Synthetic installed behavior, bounded live observations and public-registry installation are separate checks; historical release results do not qualify changed code.

## Matched artifacts

The distribution uses one `n8n-nodes-codex-chat-0.1.0.tgz`, matched gateway/n8n images, lifecycle and security manifests, dependency locks and SHA256 checksums. Verify checksums and loaded image IDs before deployment. Keep code backups separate from the latest rotating-token state. Synthetic provider images, qualification credentials and task-only account-preservation tooling are excluded from public artifacts.

The npm package installs four native nodes; it never starts a gateway or patches host dependencies automatically. The complete companion build requires the source checkout and the [separate security layer](legacy-security.md). Native community installation on that image must preserve the actual host LangChain/n8n-workflow object identities, without private peer copies or community-root peer symlinks.

Artifact variants remain distinct. The bounded build's `integration/qualification/Dockerfile.n8n` installs the lifecycle/security overlays and starts with an empty custom-extension path; Agents-only and subsequent community-loader runs qualify it separately. The root `Dockerfile.n8n` used by `release:local` builds the legacy CUSTOM embedded image with security patches and no standalone lifecycle overlay. Its release manifest explicitly labels that variant. Tags, helper locations and namespaces require their matching receipt; a native CUSTOM smoke cannot qualify an Agents companion or community installer.

## Finite acceptance surfaces

| Surface | Required evidence |
| --- | --- |
| Native workflows | Embedded/remote × Standard/Lite; tools, memory, parser/chain/extractor/classifier, Router, account operations, photos and native image bytes |
| Standalone Agents | Both codecs × stored/stateless × streaming/nonstreaming; actual loaded host turns, helpers, checkpoint/retry, observer/reflector, episodic memory and saved/inline foreground/background children |
| Accounts and continuity | Exact-token ownership, raw-success capture and local promotion, same/omitted replacement epochs, legacy migration, 32-profile order, shared two-slot account limit, quota-only fresh fallback and permanent branch pins |
| Safety and privacy | Invalid reset preflight, no executable malformed terminal, protected console/Origin/CSRF, device pending/cancel, explicit store:false canaries and no idle polling |
| Faults and resources | Admission/overload, restart, actual SQLite FULL separately from injected ENOSPC, graceful drain separately from forced-stop fences, current-state transfer and old-binary refusal |
| Distribution | Source/dependency/type differential, complete image including OS/all package copies, installed peers, same-origin cached editor transition, exact tarball/image lineage |

Native opaque metadata v2 binds the account, exact model and known codec. Old v1 memory is preserved and explicitly rejected, with export/new-session guidance. Retained standalone history also keeps connection/account/model/codec/branch proof. No guessed migration or silent history removal is permitted.

Episodic memory uses a separate compatible embedding provider; Codex Wire does not implement embeddings. The pinned standalone runtime has no user fork/regenerate endpoint. Independent branch isolation does not establish such a UI.

The Agents source differential retains six known baseline diagnostics and introduces none. The broader lifecycle/security check uses exact restored published declarations and records original-dependency, updated-dependency and patched-source results separately. It is not a clean full upstream monorepo typecheck.

## Resource and performance interpretation

The synthetic lab uses gateway 1 CPU/512 MiB, n8n 2 CPU/2 GiB and fixture 0.5 CPU/128 MiB, with external runtime egress disabled. Final load gates include 120-second steady runs at 1/8/32 offered concurrency, eight held requests plus a 70-request burst against the 64-entry queue, and 120 seconds idle. Reports retain actual RSS, CPU, event-loop delay, queue outcomes and provider-attempt counts.

Matched comparisons preserve payload, settings, model, tool count and provider delays. A candidate p95 exceeding baseline by both 2× and 50 ms, or idle RSS growth above 64 MiB, requires investigation and an explicit disposition. A host-side journal capacity test does not prove the gateway cgroup can promote a near-64 MiB journal while admitted request memory is held; that boundary remains a separate physical gate.

SQLite FULL must use an actual database page limit. Injected filesystem errors are labeled as injection; the host disk is never filled. A forced stop that retains its owner fence is a safety result, not a successful graceful shutdown. No synthetic timing establishes model quality, live entitlement or subscription/cache savings.

## Deliberate limits

Assistant Chat Completions, Codex embeddings, public image routes, hosted provider tools, direct PDF/audio/video, image editing, unknown codecs, distributed/multiworker ownership and purchases/top-ups are unsupported. Native image generation is an explicit workflow action. External tool side effects receive no general exactly-once guarantee.

Live evidence is reported by exact account entitlement and codec. Provider limitations may constrain those observations; they never excuse credential-safety failures. Production publication and deployment require the final accepted artifact receipt.

By [wufflyne](https://wufflyne.com).
