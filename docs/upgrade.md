# Upgrade and rollback

For native 0.1.1 keep the original Manager credential/passphrase, current private codex-wire state, latest token/reset journals and active Service workflow. No automatic store adoption or old snapshot restoration occurs. Configured older bindings retain the explicit legacy path; adoption is refused when exclusive handover cannot be proven. The procedures below describe the retained older deployment variants.

## Legacy 0.1.0 deployment upgrades

Version 0.1.0 preserves package, node, credential and helper identifiers, existing workflow parameters, profile/envelope v1, protected bindings and the master key. It adds a store-wide encrypted token-ownership and renewal journal. This is a one-way safety-format upgrade: v0.0.5 and older binaries cannot safely own the migrated store.

1. Pause new executions, drain active work and stop every old owner. Record the exact image, package and configuration identities. Fence other processes and devices that could renew the same token family.
2. Preserve the complete current store, reset ledgers, import fences, protected bindings and separately stored key. Keep the backup private. It is evidence and disaster-recovery material, not permission to replay old rotating tokens.
3. Install the matched 0.1.0 package/image and peers. Reuse the same volumes, key and bindings; never generate a replacement key during upgrade.
4. The first owning access performs a resumable local migration before provider dispatch. Duplicate legacy refresh-token families are all blocked; the migration never elects one, merges them or renews a token. Resolve duplicates with independent logins.
5. Check local status, node discovery and a harmless workflow before resuming admissions. Retain prior code and audit artifacts until the operator accepts the result.

The permanent `.codex-wire-owner/format.json` guard occupies the verified v0.0.5 owner's lock path, including after clean shutdown. The active v0.1.0 owner uses `.codex-wire-owner-v2`. An existing unknown old lock is never automatically converted or unlocked by age. An abandoned active lock requires deliberate offline investigation after every possible writer is stopped.

Preserve `.rotation-v2.json.enc`, `.rotation-v2.initialized`, captured responses, reset journals and `.import-*.used` fences together. Renewal records are never evicted to make old credentials reusable. Store transfer copies these guards and journals and excludes only the active new owner lock. Use the [gateway current-store transfer](gateway.md#upgrade-and-recovery) when changing owners; remove the old owner's access before starting the replacement.

Rollback is limited to compatible application code that understands the current token journal and guard. Keep the newest credential generation and all safety state. The verified v0.0.5 owner refuses this store even after a clean stop. All older/custom owners are unsupported and unsafe; v0.0.4 or low-level clients that ignore owner locks require operational revocation of their key/store access. The filesystem guard cannot control such programs. Never remove the permanent guard or restore an older token snapshot to bypass this refusal. Provider token rotation and reset spending cannot be undone by restoring files.

Native opaque memory now uses metadata v2 bound to the exact account, model and known codec. Old v1 or unproven opaque memory is rejected with a controlled error. Preserve or export it, then start a deliberate new memory session; do not edit its model marker, strip metadata or silently reuse it with another model. Ordinary visible messages without opaque metadata retain their supported behavior.

An awaited encrypted success capture may permit identity-verified local recovery after a parsing, verification or commit failure. Recovery never renews again. Lost responses or failed capture writes cannot be reconstructed; preserve the evidence and reconnect with an independent login. The [maintenance helper procedure](legacy-install.md#recover-a-captured-successful-renewal) explains the stopped-owner requirements.

By [wufflyne](https://wufflyne.com).
