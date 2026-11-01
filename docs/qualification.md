# Qualification and compatibility

The native 0.1.1 release targets the untouched official n8n 2.45.6 image, Node.js 26.12.1, n8n-workflow 2.45.3 and LangChain Core 1.2.8. Its package loads through Community Nodes and uses the host’s actual peer instances. It installs six nodes and two credential types; it applies no host, frontend, lifecycle or security overlay.

## Evidence scope

Synthetic qualification covers native saved credentials and workflows, encrypted setup and binding delivery, owner exclusivity and drain, stale credential saves, cold restarts, connection cancellation/capture/uncertainty, explicit imports, local editor reads and native model execution. Each release receipt identifies the exact package digest and installed-file comparison. Stock n8n normalizes dependency metadata in the installed package.json; this is recorded separately from byte-identical installed files.

A current package test pass does not establish live subscription entitlement, provider availability, model quality, token savings or compatibility with arbitrary n8n versions. No real account is used in the current release’s native qualification. The final code baseline passes 444 automated tests without skips; the 51 focused native tests are included in that total. Documentation-only packaging is checked against the tested compiled bytes. Earlier checkpoint tests are not silently attributed to later changed runtime bytes.

The final installed pass includes 15 saved-workflow functional cases, 13 native Codex-parser cases, 12 installed structured-adapter component cases, actual two-turn private Chat with memory, guarded refusal and recovery, and six unsupported Chat graph checks. Account journeys and explicit reset/renewal/reconciliation cases preserve provider-side counters and unknown outcomes. Component API tests are reported separately from saved native workflow executions.

The controlled final workload offers concurrency 1, 8 and 32 for 30 seconds each with 250 ms provider delay. It completes 74, 382 and 416 invocations, with zero errors or unknowns. End-to-end throughput is 2.45, 12.55 and 13.13 successful invocations per second; driver-observed p95 latency is 418, 815 and 2709 ms. A separate 80-call burst completes all 80. These are measurements of the bounded stand and its durable synthetic provider, not product capacity or provider performance claims. Native execution timing and both containers’ resources are recorded separately. Both admitted cancellations settle with exactly two effects, a fresh503 is followed by a successful fresh request, and120.193 seconds idle produce zero unsolicited effects. Samples show no OOM kills. n8n averages about1.96/1.93 CPU cores in the8/32 cells against its2CPU limit; the provider averages0.20/0.22 cores against0.5. Its growing durable effect ledger and driver polling also contribute to end-to-end measurements. Maximum observed main-process RSS in those cells is646/944 MiB for n8n and114/118 MiB for the provider.

## Native acceptance surfaces

| Surface | Qualification scope |
| --- | --- |
| Setup and accounts | Native installation, original Manager identity, encrypted binding delivery, sign-in/import/reconnect, local Status/Test and restart recovery |
| Models and workflows | Responses and Lite codecs, streaming, actual Code Tool effects, Codex parser, native memory, fresh-invocation Router, exact photo and generated image bytes |
| Account safety | Exact identity and token-family ownership, durable success capture, missing-journal refusal, reset acknowledgement/idempotency and unknown outcomes |
| Resources and failures | Bounded concurrency, cancellation, rejected/uncertain requests, owner drain, restart, idle traffic, CPU and memory observations |
| Distribution | Exact source/package/dependency provenance, genuine host peer identities, current advisory review and public registry installation |

The qualified private Chat Hub workflow agent uses one Agent3, one fixed Codex model and optional memory. The package refuses independent tools, output parsers, Router, custom main outputs and public Chat before provider work. Actual assistant Markdown rendering, an over-budget refusal and a fresh healthy recovery are exercised. Stock Chat may mask detailed errors; open the native execution for the controlled cause.

Chat Hub workflow agents use the normal workflow execution path and a connected Account credential. Their native selector/message evidence is distinct from the separate standalone Agents builder. Full standalone host-attested pooling and automatic native OpenAI-credential delivery are unsupported on stock n8n.

## Historical integrations

[Legacy qualification](legacy-qualification.md) preserves the 0.1.0 companion/gateway procedures and their scope. Those custom images, lifecycle overlays and historical measurements do not qualify the native stock path. Previous offline SDK metadata delays and watchdog failures remain historical evidence; later bounded runs do not turn them into uninterrupted passes.

Stock Simple Memory is process-local. After a cold restart the same saved Chat UI retains earlier messages while the observed provider context contains only the new user message. Final opaque assistant provenance is not reconstructed. Keep account/workflow/session memory separate.

Native operation supports one local execution process with private local persistence. Queue/multi-main execution, shared network filesystems, Codex embeddings, Chat Completions, image editing, unsupported hosted tools and purchases/top-ups are outside the supported scope. External tool side effects have no general exactly-once guarantee.

By [wufflyne](https://wufflyne.com).
