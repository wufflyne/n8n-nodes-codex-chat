# Upgrade and rollback

v0.0.4 preserves package/internal node/credential/helper IDs, existing serialized parameter paths, profile/envelope v1, binding secrets, master key and normal managed renewal policy. New display metadata is optional; reading an old profile does not rewrite it. `resets/` is additive and ignored by the old package; preserve it through rollback/reupgrade.

1. Stop workflow users and the affected n8n process. Record image/package/source/Compose identifiers.
2. Back up n8n state, complete profile store including reset ledgers/import fences, protected bindings and the separately stored master key. Keep permissions and never dump secrets into diagnostics.
3. Install the reviewed npm version or local image artifact with exactly the pinned peers. Reuse original volumes/key/bindings; do not run keygen for an upgrade. Do not convert existing workflow namespaces automatically.
4. Start, check health/node discovery, local credential status and one harmless test workflow. Confirm ordinary defaults and configured model settings.
5. Retain all rollback archives until tests pass and the user confirms the result.

To roll back application code, stop users, restore the saved image/package/Compose and preserve the current profile/reset store and key. Old code accepts additive display fields. A provider reset cannot be undone by restoring files; never overwrite an unresolved ledger with an older backup to force another consume. Re-upgrade and explicitly reconcile the same persisted intent when needed. Rotating-token unknown outcomes/import fences also remain conservative and require a fresh reconnect when appropriate.

The release script does not update existing n8n instances. It builds versioned images and tests disposable volumes; deploy to an existing instance only after checking its backup and rollback plan.
