import { createHash } from "node:crypto";
import type { ICredentialDataDecryptedObject } from "n8n-workflow";
import type { CredentialContext } from "./credential-persistence.js";
import { nativeAccount } from "./native-connections.js";
import { EmbeddedService } from "./embedded.js";
import { managerById } from "./native-manager.js";
import { credentialBinding, runtimeFromEnvironment } from "../runtime.js";
import { assert } from "../core/errors.js";
import { nativeService } from "./native.js";
import type { ICredentialsDecrypted, INodeCredentialTestResult } from "n8n-workflow";
import { safeError } from "../core/errors.js";
import { RemoteService } from "./remote.js";

export async function testManagerCredential(
  credential: ICredentialsDecrypted<ICredentialDataDecryptedObject>,
): Promise<INodeCredentialTestResult> {
  try {
    assert(credential.id, "Save this credential, then activate its Codex Wire Service workflow.");
    const manager = managerById(credential.id);
    manager.ensureOpen();
    manager.authorize(credential.data?.managerPassphrase, credential.data?.ownerKey);
    return {
      status: "OK",
      message:
        "Codex Wire Service is ready locally for this Manager. Account sign-in is a separate explicit action.",
    };
  } catch (error) {
    return { status: "Error", message: safeError(error).message };
  }
}

export async function editorModels(ctx: CredentialContext) {
  const { binding, service, localResources, editorCatalog } = await nativeAccount(ctx, true);
  if (!localResources) return service instanceof RemoteService ? service.cachedModels(binding) : [];
  // Read a profile only, never session()/catalog.list().
  const p = await localResources.store.read(binding);
  const affinity = createHash("sha256").update(`${p.id}:${p.subject}:${p.accountId}`).digest("hex");
  return (editorCatalog ?? localResources.catalog).cached(affinity, p.generation);
}
export async function editorResetCredits(ctx: CredentialContext) {
  const { binding, service, localResources, editorAccount } = await nativeAccount(ctx, true);
  const snapshot = localResources
    ? (editorAccount ?? localResources.account).cachedProfile(
        await localResources.store.read(binding),
      )
    : service instanceof RemoteService
      ? service.cachedLimits(binding)
      : undefined;
  return snapshot?.resetCredits.freshness.validUntil &&
    Date.parse(snapshot.resetCredits.freshness.validUntil) > Date.now()
    ? snapshot.resetCredits.entries.filter(
        (e) => !e.expiresAt || Date.parse(e.expiresAt) > Date.now(),
      )
    : [];
}
export async function credentialLocalStatus(
  id: string | undefined,
  data: ICredentialDataDecryptedObject,
) {
  assert(
    data && (data.profileId || data.ownerManagerId),
    "This Account is not connected. Use Codex Account → Start Sign-in or Import Session with its Manager.",
  );
  const binding = credentialBinding(data);
  if (data.ownerManagerId) {
    const manager = managerById(String(data.ownerManagerId));
    const state = await manager.records.read();
    const account = id && Object.hasOwn(state.accounts, id) ? state.accounts[id] : undefined;
    assert(
      account?.acknowledged &&
        account.deliveryId === data.deliveryId &&
        account.binding.profileId === binding.profileId &&
        account.binding.bindingSecret === binding.bindingSecret,
      "This credential is not the acknowledged account target. Complete sign-in with its original Manager.",
    );
    assert(
      await manager.resources.store.exists(binding.profileId),
      "This account has not completed connection. Use Codex Account → Complete Sign-in or Import Session with its original Manager.",
    );
    return manager.service.status(binding);
  }
  assert(!data.deliveryId, "The account credential has incomplete managed metadata.");
  if (process.env.N8N_CODEX_MODE === "gateway") return nativeService().status(binding);
  return new EmbeddedService(runtimeFromEnvironment({ readOnly: true })).status(binding);
}
