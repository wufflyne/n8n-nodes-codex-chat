import { AccountReader } from "../account/usage.js";
import { ResetStore } from "../account/reset-store.js";
import { ResetController } from "../account/reset.js";
import { ImageService } from "../image/service.js";
import { AccountSessionManager } from "../auth/sessions.js";
import { CodexAuthProvider } from "../auth/provider.js";
import { ProfileStore } from "../auth/store.js";
import { ModelCatalog } from "../core/catalog.js";
import { ResponsesTransport } from "../core/transport.js";
import type { OwnerLock } from "./native-locks.js";

export function createResources(directory: string, key: Buffer, refreshEnabled = true, ownerLock?: OwnerLock) {
  const store = new ProfileStore(directory, key, undefined, false, ownerLock),
    auth = new CodexAuthProvider(),
    sessions = new AccountSessionManager(store, auth, refreshEnabled),
    account = new AccountReader(sessions);
  return {
    store,
    auth,
    sessions,
    account,
    resets: new ResetController(account, new ResetStore(directory, key, ownerLock)),
    images: new ImageService(sessions),
    catalog: new ModelCatalog(),
    transport: new ResponsesTransport(),
  };
}
