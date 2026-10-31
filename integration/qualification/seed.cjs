"use strict";
// Creates a fresh isolated fixture. This never reads operator accounts or credentials.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { ProfileStore } = require("../../dist/auth/store");
const { StateRepository } = require("../../dist/gateway/state/repository");
const { GatewayAuthorization } = require("../../dist/gateway/auth");
const { PROVIDER, ISSUER, CODEX_CLIENT_ID } = require("../../dist/core/types");

async function main() {
  const adminOrigin = new URL(process.env.QUALIFICATION_ADMIN_ORIGIN || "http://127.0.0.1:15911");
  if (adminOrigin.protocol !== "http:" || adminOrigin.hostname !== "127.0.0.1" || !adminOrigin.port || adminOrigin.href !== adminOrigin.origin + "/")
    throw Error("Use an explicit loopback HTTP qualification admin origin without credentials, path, query or fragment.");
  const root = path.resolve(process.env.QUALIFICATION_ROOT || "");
  if (!process.env.QUALIFICATION_ROOT || !path.isAbsolute(process.env.QUALIFICATION_ROOT))
    throw Error("Select a fresh absolute qualification directory.");
  const data = path.join(root, "gateway-data");
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  if ((await fs.realpath(root)) !== root)
    throw Error("Qualification root cannot contain symlinks.");
  await fs.mkdir(data, { mode: 0o700 }); // Existing fixture state must never be overwritten.
  for (const dir of ["gateway-config", "n8n-data", "fixture-data", "driver-data"])
    await fs.mkdir(path.join(root, dir), { mode: 0o700 });
  const write = (file, value) =>
    fs.writeFile(file, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
  const key = crypto.randomBytes(32);
  await write(path.join(root, "gateway-config/master.key"), key.toString("base64") + "\n");
  const store = new ProfileStore(path.join(data, "profiles"), key);
  const bindings = [];
  for (let i = 0; i < 32; i++) {
    const binding = {
      profileId: crypto.randomUUID(),
      bindingSecret: crypto.randomBytes(32).toString("base64url"),
    };
    bindings.push(binding);
    await store.write({
      version: 1,
      provider: PROVIDER,
      issuer: ISSUER,
      clientId: CODEX_CLIENT_ID,
      id: binding.profileId,
      label: `Synthetic account ${i + 1}`,
      subject: `synthetic-user-${i}`,
      accountId: `synthetic-account-${i}`,
      bindingHash: crypto.createHash("sha256").update(binding.bindingSecret).digest("hex"),
      generation: 1,
      state: "ready",
      verifiedAt: Date.now(),
      tokens: {
        accessToken: `SYNTHETIC_QUALIFICATION_ACCESS_${i}`,
        expiresAt: Date.now() + 7 * 86400000,
        scopes: [],
      },
      display: {
        email: {
          value: `fixture-${i}@example.invalid`,
          source: "verified_access_claim",
          verifiedAt: Date.now(),
        },
        plan: { value: "pro", source: "verified_access_claim", verifiedAt: Date.now() },
      },
    });
  }
  await store.rotation.initialize();
  const state = new StateRepository(path.join(data, "state/gateway.db"), key);
  await state.open();
  let fixed, pool, installation, administrator;
  try {
    const auth = new GatewayAuthorization(state);
    for (const [id, mode, profiles] of [
      ["synthetic-fixed", "fixed", [bindings[0].profileId]],
      ["synthetic-pool", "pool", bindings.map((b) => b.profileId)],
    ]) {
      await auth.savePolicy({
        id,
        name: id,
        mode,
        profiles,
        allowedModels: [],
        installationId: "synthetic-installation",
        localContinuityConsent: true,
        enabled: mode === "fixed",
        awaitingContext: mode === "pool",
        contextQualified: true,
      });
      const delivery = await auth.prepareKey({
        role: "inference",
        scopes: ["models", "responses"],
        connectionId: id,
      });
      await auth.acknowledge(delivery.deliveryId);
      if (mode === "fixed") fixed = delivery.key;
      else pool = delivery.key;
    }
    const delivery = await auth.prepareKey({
      role: "installation",
      scopes: ["native:*", "native:reset", "context:attest"],
      installationId: "synthetic-installation",
      profiles: bindings.map((b) => b.profileId),
      connections: ["synthetic-fixed", "synthetic-pool"],
    });
    installation = delivery.key;
    await auth.acknowledge(delivery.deliveryId);
    const admin = await auth.prepareKey({ role: "administrator", scopes: ["control:*"] });
    administrator = admin.key;
    await auth.acknowledge(admin.deliveryId);
  } finally {
    await state.close();
  }
  const config = {
    version: 1,
    inference: { host: "0.0.0.0", port: 8787, privateHttp: true, origin: "http://gateway:8787" },
    admin: {
      host: "0.0.0.0",
      port: 8788,
      origin: adminOrigin.origin,
      allowLoopbackHttp: true,
      bootstrapFile: "/var/lib/codex-wire/control/bootstrap.key",
    },
    storeDirectory: "/var/lib/codex-wire/profiles",
    masterKeyFile: "/etc/codex-wire/master.key",
    stateFile: "/var/lib/codex-wire/state/gateway.db",
    contextIntegrationQualified: true,
    refreshEnabled: false,
  };
  await write(path.join(root, "gateway-config/gateway.json"), config);
  await fs.copyFile(
    path.join(__dirname, "synthetic-fetch.cjs"),
    path.join(root, "gateway-config/synthetic-fetch.cjs"),
  );
  const wire = path.join(root, "n8n-data/codex-wire");
  await fs.mkdir(wire, { mode: 0o700 });
  await write(path.join(wire, "installation.key"), installation + "\n");
  await write(path.join(wire, "context.json"), {
    version: 1,
    installationId: "synthetic-installation",
    installationKeyFile: "/home/node/.n8n/codex-wire/installation.key",
    journalDirectory: "/home/node/.n8n/codex-wire/context-journal",
    gatewayOrigins: ["http://gateway:8787"],
  });
  await write(path.join(root, "driver-data/synthetic-client.json"), {
    synthetic: true,
    fixed,
    pool,
    administrator,
    bindings,
  });
  await write(path.join(wire, "native-bindings.json"), { synthetic: true, bindings });
  for (const variant of ["agents-only", "community", "legacy-custom"])
    await fs.mkdir(path.join(root, "n8n-data", variant), { mode: 0o700 });
  const jose = await import("jose"),
    { publicKey, privateKey } = await jose.generateKeyPair("RS256");
  const jwk = await jose.exportJWK(publicKey);
  jwk.kid = "synthetic-fixture";
  jwk.alg = "RS256";
  const access = await new jose.SignJWT({
    client_id: CODEX_CLIENT_ID,
    scope: "openid",
    email: "onboarding@example.invalid",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "synthetic-onboarding",
      chatgpt_plan_type: "pro",
    },
  })
    .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
    .setIssuer(ISSUER)
    .setAudience("https://api.openai.com/v1")
    .setSubject("synthetic-onboarding")
    .setExpirationTime("7d")
    .sign(privateKey);
  await write(path.join(root, "fixture-data/jwks.json"), { keys: [jwk] });
  await write(path.join(root, "fixture-data/token.json"), {
    access_token: access,
    refresh_token: "SYNTHETIC_REFRESH_ONLY",
    token_type: "Bearer",
    expires_in: 604800,
  });
  await write(path.join(root, "driver-data/onboarding.json"), {
    provider: PROVIDER,
    client_id: CODEX_CLIENT_ID,
    access_token: access,
    expires_at: Math.floor(Date.now() / 1000) + 604800,
  });
  await fs.writeFile(
    path.join(root, "fixture-data/pixel.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=",
      "base64",
    ),
    { mode: 0o600, flag: "wx" },
  );
  await write(path.join(root, "seed-manifest.json"), {
    synthetic: true,
    profileCount: bindings.length,
    created: new Date().toISOString(),
    n8nUserFolderMeaning: "variant parent; InstanceSettings.n8nFolder appends .n8n",
    providerContacted: false,
  });
  console.log(
    "Created 32 synthetic profiles, independent role keys, signed synthetic onboarding fixture and protected configs. No secrets printed.",
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
