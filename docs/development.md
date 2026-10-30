# Development and extension

One package; dependency direction is validation/types → auth/account/protocol → model/routing → native adapters/CLI. `runtime.ts` owns environment composition. Codec/catalog never read profiles or environment. Auth owns credentials. The reset controller alone can POST consume; account readers cannot acquire that writer. A current-only source never renews. Tests inject fetch/time/UUID and synthetic identities.

| Layer              | Files and responsibility                                                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth               | `auth/provider`, `store`, `sessions`, `connection`, `status`: verified identity, encrypted v1 profile, complete durable binding, rotation/commit fences, pure display |
| Protocol           | `core/catalog`, `codec`, `sse`, `transport`, `replay`: known codecs, exact automatic tools/history, bounded framing, admission-only retry                             |
| Validation/metrics | `core/usage`, `affinity`, `snapshot`, `structured`, `token-estimate`, `execution-usage`: pure numeric/schema/scope rules and passive bounded aggregates               |
| Account            | `account/usage`, `reset-policy`, `reset-store`, `reset`: fixed GETs, pure policy, encrypted idempotent actions/execution cap                                          |
| Router             | `routing/candidate`, `coordinator`, `model`: nonenumerable package-owned candidate, public execution scope, sticky first admission                                    |
| Images             | `image/validation`, `service`: raster sources/headers, pinned ImagesClient JSON action/native bytes                                                                   |
| Native             | `n8n/*`, `nodes/*`, `credentials/*`, `cli`: controls/public hooks, parameter extraction and service delegation                                                        |

## Add an optional capability

Extend catalog parsing with bounded unknown-safe metadata, then validation, UI/default omission and a novel known-codec fixture. Preserve existing parameter paths. Do not wire by model-name prefix. A missing optional decoration never hides an otherwise valid new model; a malformed route discriminator fails that entry. New operational semantics require an explicit protocol version and tests.

## Add an account operation

Define an additive versioned output schema, implement a fixed bounded service operation, wire a thin native operation and test privilege boundaries. Read-only operations must remain unable to consume resets. Local checks/reporting cannot renew. Preserve source/time/unknown data, account identity checks and user-visible output versus portable support allowlists.

## Add a codec

Introduce a deliberate authentic route discriminator and source pin; define request/response/replay contracts and public capability guards. Exercise exact instruction/tool/output/streaming/parser/image/memory/native matrix, malformed terminals and admission ambiguity. No arbitrary provider JSON passthrough. Old opaque history cannot cross account/route identity.

## Repeatable local release

Run `npm run release:local` in the project. It invokes scoped Docker builds using the exact lockfile, compiles/types/tests, performs a native synthetic router smoke, packs the allowlisted artifact, builds a clean runtime, exports/loads the archive and starts empty disposable volumes. It does not publish, push, touch the existing editor or use real credentials. The built-in smoke is a narrow check; broader native integration and load testing are separate release gates. Review source hashes after a change and rerun the affected checks.

Package version comes only from package.json; Codex client compatibility is independently 0.166.0 + pinned commit. Profile/envelope/reset/output schemas are independently versioned. Ajv 8.20.0 and ajv-formats 3.0.1 are exact owned dependencies, installed with scripts ignored. JSON Schema draft-07/2020-12 use local validation without remote refs, coercion/default insertion/property removal/async loading. Schemas are trusted workflow configuration; size/depth limits do not make arbitrary regexes cost-free.

Public execution APIs are required for router/reset/reporting. Unsaved workflows use `unsaved` only with a real unique execution ID. Native tracer indexes come from addInputData; no private n8n imports appear in production. Synthetic helpers/preloads remain development-only and never enter the runtime/package. The optional live smoke helper reads an explicitly supplied session on stdin and never refreshes it. It is not run by the test or release commands. Never pass credential JSON as executable Node input or print raw child streams.

Release names default to `codex-wire-v<package-version>` and label `codex-wire.release=<version>`. Set `CODEX_RELEASE_PREFIX` and `CODEX_RELEASE_TASK` to identify local build resources when needed. `CODEX_RELEASE_DOCKER=direct` uses Docker as the current user; otherwise the command uses `sudo -n docker`. To attach an external test result by hash, use `npm run release:local -- --physical-evidence <result.json>`. The delivered Compose and installation instructions use the stable versioned image tag. Even with a custom prefix, the archive contains both the custom tag and the stable tag, naming the same image. A stable tag pointing at another image stops release before alias creation/export; choose a new version, or verify ownership and preserve the previous release before explicitly removing only its old alias. Never blindly retag an unrelated image. The manifest records the exact exported tags; authored source must remain unchanged during the pipeline. The manifest records package inventory and source identity; SHA256SUMS includes the manifest itself. Dockerfile.n8n requires an explicit `--build-arg BUILD_IMAGE=<fresh-builder-tag>` (the release entrypoint supplies it) and copies its single newly packed tarball. A later package version needs no release-script task/version edit.

The source distribution contains portable Compose only. Keep instance-specific Compose overrides, keys, profiles and generated artifacts outside version control. Builder, runtime and loaded-image staging tags use a unique invocation ID. Public release aliases are checked before promotion; a conflict leaves the existing alias untouched. Retain the reported builder/staging references until you no longer need that build checkpoint.
