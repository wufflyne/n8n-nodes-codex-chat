import { runtime } from "../runtime.js";
import { CodexError } from "../core/errors.js";
import type { CodexService } from "./contracts.js";
import { EmbeddedService } from "./embedded.js";
import { RemoteService } from "./remote.js";

let remote: RemoteService | undefined;
export function nativeService(): CodexService {
  const mode = process.env.N8N_CODEX_MODE ?? "embedded";
  if (mode !== "embedded" && mode !== "gateway")
    throw new CodexError("configuration", "N8N_CODEX_MODE must be embedded or gateway.");
  if (mode === "gateway") {
    if (
      process.env.N8N_CODEX_STORE_DIR ||
      process.env.N8N_CODEX_STORE_KEY ||
      process.env.N8N_CODEX_REFRESH_ENABLED
    )
      throw new CodexError(
        "configuration",
        "Gateway mode forbids profile-store and renewal variables in n8n. Remove access to the old store/key before transferring ownership.",
      );
    if (!process.env.N8N_CODEX_GATEWAY_URL || !process.env.N8N_CODEX_GATEWAY_TOKEN_FILE)
      throw new CodexError(
        "configuration",
        "Gateway mode requires a service origin and protected installation key file.",
      );
    return (remote ??= new RemoteService(
      process.env.N8N_CODEX_GATEWAY_URL,
      process.env.N8N_CODEX_GATEWAY_TOKEN_FILE,
    ));
  }
  if (process.env.N8N_CODEX_GATEWAY_URL || process.env.N8N_CODEX_GATEWAY_TOKEN_FILE)
    throw new CodexError(
      "configuration",
      "Embedded mode cannot include gateway connection variables.",
    );
  return new EmbeddedService(runtime());
}
