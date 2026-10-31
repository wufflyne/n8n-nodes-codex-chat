#!/usr/bin/env node
import { transferCurrentStore } from "./service/migration.js";
import { parseArgs } from "node:util";
import { readPrivateFile } from "./auth/store.js";
import { loadConfig, gatewayTuning } from "./gateway/config.js";
import { StateRepository } from "./gateway/state/repository.js";
import { createResources } from "./service/resources.js";
import { ProfileOwner } from "./service/owner.js";
import { GatewayEngine } from "./gateway/engine.js";
import { GatewayApplication, listen } from "./gateway/server.js";

export async function main(args = process.argv.slice(2)) {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      help: { type: "boolean" },
      "target-directory": { type: "string" },
      "owners-stopped-and-fenced": { type: "boolean" },
    },
  });
  if (values.help || !positionals.length) {
    process.stdout.write(
      "Codex Wire gateway 0.1.0\n\n  codex-wire-gateway doctor --config <protected-config.json>\n  codex-wire-gateway serve --config <protected-config.json>\n  codex-wire-gateway transfer-store --config <protected-config.json> --target-directory <new-path> --owners-stopped-and-fenced\n\nThe gateway starts only through the explicit serve command. Stop and remove store access from all old owners first. By wufflyne · https://wufflyne.com\n",
    );
    return;
  }
  if (
    !values.config ||
    positionals.length !== 1 ||
    !["doctor", "serve", "transfer-store"].includes(positionals[0]!)
  )
    throw new Error(
      "Choose serve, doctor or transfer-store and an explicit protected configuration file.",
    );
  const config = await loadConfig(values.config),
    encoded = (await readPrivateFile(config.masterKeyFile, 4096))
      .trim()
      .replace(/^N8N_CODEX_STORE_KEY=/, "");
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded))
    throw new Error(
      "The master-key file must contain an existing base64 32-byte key.",
    );
  if (
    process.env.N8N_CODEX_MODE === "gateway" ||
    process.env.N8N_CODEX_GATEWAY_TOKEN_FILE
  )
    throw new Error(
      "The gateway owner cannot also be configured as an n8n remote client.",
    );
  if (positionals[0] === "doctor") {
    process.stdout.write(
      JSON.stringify(
        {
          release: "0.1.0",
          protocolVersion: 1,
          schemaVersion: 1,
          node: process.version,
          configuration: "valid",
          providerContacted: false,
          ownerStarted: false,
          contextRequested: config.contextIntegrationQualified === true,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }
  if (positionals[0] === "transfer-store") {
    if (!values["target-directory"])
      throw new Error("Specify a new empty target directory.");
    const result = await transferCurrentStore(
      config.storeDirectory,
      values["target-directory"],
      Buffer.from(encoded, "base64"),
      values["owners-stopped-and-fenced"] === true,
    );
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  const owner = new ProfileOwner(config.storeDirectory);
  await owner.acquire();
  const key = Buffer.from(encoded, "base64"),
    tuning = gatewayTuning(config),
    state = new StateRepository(
      config.stateFile,
      key,
      tuning.state,
      tuning.retention,
    );
  let application: GatewayApplication | undefined;
  let resources: ReturnType<typeof createResources> | undefined;
  try {
    await state.open();
    resources = createResources(
      config.storeDirectory,
      key,
      config.refreshEnabled !== false,
    );
    const engine = new GatewayEngine(
      resources,
      state,
      config.contextIntegrationQualified === true,
      tuning,
    );
    application = new GatewayApplication(config, engine);
    await application.initialize();
    const server = await listen(application);
    process.stdout.write(
      "Codex Wire gateway is ready. Bootstrap credentials remain in the protected operator file.\n",
    );
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      try {
        await server.close();
        await resources!.sessions.settleRenewals();
        await state.close();
        await owner.close();
      } catch {
        owner.preserveFence();
        process.stderr.write(
          "Gateway shutdown requires recovery. The owner fence was preserved.\n",
        );
        process.exitCode = 1;
      }
    };
    process.once("SIGINT", () => {
      void close();
    });
    process.once("SIGTERM", () => {
      void close();
    });
  } catch (error) {
    application?.stopMaintenance();
    try {
      await application?.control.close();
      await application?.settle();
      await resources?.sessions.settleRenewals();
      await state.close();
      await owner.close();
    } catch {
      owner.preserveFence();
    }
    throw error;
  }
}
if (require.main === module)
  void main().catch(() => {
    process.stderr.write(
      "Codex Wire gateway could not start safely. Check the protected configuration, ownership, key and state schema.\n",
    );
    process.exitCode = 1;
  });
