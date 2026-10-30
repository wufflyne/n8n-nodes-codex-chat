import { AccountReader } from "./account/usage.js";
import { ResetStore } from "./account/reset-store.js";
import { ResetController } from "./account/reset.js";
import { ImageService } from "./image/service.js";
import { AccountSessionManager } from "./auth/sessions.js";
import { CodexAuthProvider } from "./auth/provider.js";
import { ProfileStore } from "./auth/store.js";
import { ModelCatalog } from "./core/catalog.js";
import { assert, record, string } from "./core/errors.js";
import { ResponsesTransport } from "./core/transport.js";
import type { Binding } from "./core/types.js";

export function runtimeFromEnvironment() {
  assert(
    process.env.EXECUTIONS_MODE !== "queue",
    "This release supports one n8n execution process. Queue mode requires a shared coordinator and is disabled.",
  );
  const directory = string(
    process.env.N8N_CODEX_STORE_DIR,
    "N8N_CODEX_STORE_DIR",
  );
  const encodedKey = string(
    process.env.N8N_CODEX_STORE_KEY,
    "N8N_CODEX_STORE_KEY",
  );
  assert(
    /^[A-Za-z0-9+/]{43}=$/.test(encodedKey),
    "N8N_CODEX_STORE_KEY must be a base64-encoded 32-byte key.",
  );
  const store = new ProfileStore(directory, Buffer.from(encodedKey, "base64"));
  const auth = new CodexAuthProvider();
  const sessions = new AccountSessionManager(
      store,
      auth,
      process.env.N8N_CODEX_REFRESH_ENABLED !== "false",
    ),
    account = new AccountReader(sessions),
    resets = new ResetController(
      account,
      new ResetStore(directory, Buffer.from(encodedKey, "base64")),
    );
  return {
    store,
    auth,
    sessions,
    account,
    resets,
    images: new ImageService(sessions),
    catalog: new ModelCatalog(),
    transport: new ResponsesTransport(),
  };
}

let singleton: ReturnType<typeof runtimeFromEnvironment> | undefined;
export function runtime() {
  return (singleton ??= runtimeFromEnvironment());
}

export function credentialBinding(value: unknown): Binding {
  const data = record(value);
  return {
    profileId: string(data.profileId, "Account profile identifier", 64),
    bindingSecret: string(data.bindingSecret, "Account binding secret", 256),
  };
}
