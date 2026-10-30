#!/usr/bin/env node
import { lstat, open, realpath, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { parseArgs } from "node:util";
import { CodexError, assert, safeError } from "./core/errors.js";
import { runtimeFromEnvironment, credentialBinding, closeRuntimeOwner } from "./runtime.js";
import { deliverBinding } from "./auth/connection.js";
import { localStatus } from "./auth/status.js";
import { throwIfAborted, waitForSignal } from "./core/http.js";
import { parseManualTokens } from "./auth/sessions.js";
import { ControlClient } from "./service/control-client.js";
import { readPrivateFile } from "./auth/store.js";

async function readInput(filename: string, signal?: AbortSignal): Promise<unknown> {
  let data: string;
  if (filename === "-") {
    assert(
      !process.stdin.isTTY,
      "Do not type tokens into an echoing terminal. Pipe protected JSON to stdin or use --input with an explicit protected file.",
    );
    let length = 0;
    const chunks: Buffer[] = [];
    const iterator = process.stdin[Symbol.asyncIterator]();
    while (true) {
      const next = await waitForSignal(iterator.next(), signal);
      if (next.done) break;
      const chunk = next.value;
      const bytes = Buffer.from(chunk);
      length += bytes.length;
      assert(length <= 256 * 1024, "The token input exceeds 256 KiB.");
      chunks.push(bytes);
    }
    data = Buffer.concat(chunks).toString("utf8");
  } else {
    data = await readPrivateFile(filename, 256 * 1024);
  }
  throwIfAborted(signal);
  try {
    return JSON.parse(data) as unknown;
  } catch {
    throw new CodexError("configuration", "The selected input is not valid JSON.");
  }
}

async function writeNew(filename: string, value: string): Promise<void> {
  let file;
  try {
    const parent = path.dirname(path.resolve(filename));
    const stat = await lstat(parent);
    assert(
      stat.isDirectory() && (stat.mode & 0o077) === 0 && (await realpath(parent)) === parent,
      "Use a private parent directory without symbolic-link components.",
    );
    file = await open(filename, "wx", 0o600);
    await file.writeFile(value);
    await file.sync();
    const directory = await open(parent, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    throw new CodexError(
      "storage",
      "The protected output file could not be created. Use an existing private parent directory and a new filename.",
    );
  } finally {
    await file?.close();
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      label: { type: "string" },
      format: { type: "string" },
      input: { type: "string" },
      "binding-output": { type: "string" },
      reconnect: { type: "string" },
      binding: { type: "string" },
      output: { type: "string" },
      help: { type: "boolean" },
      offline: { type: "boolean" },
      online: { type: "boolean" },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(
      "Codex Account Helper (Experimental)\n\nCommands:\n  keygen --output <protected-env-file>\n  device-login --label <name> --binding-output <new-file>\n  import --format token-set|codex-auth-json --input <protected-file|-> --label <name> --binding-output <new-file>\n  device-login|import ... --reconnect <existing-binding-file>\n  status --binding <protected-binding-file>\n\nUse --online with N8N_CODEX_ADMIN_URL and N8N_CODEX_ADMIN_TOKEN_FILE. Existing standalone commands select offline maintenance through N8N_CODEX_STORE_DIR and N8N_CODEX_STORE_KEY; --offline is optional. Mutations require stopped store users. Status and doctor stay local and read-only. Tokens are never accepted on the command line. Device login is beta and uses the experimental Codex client contract.\nCreated by wufflyne — https://wufflyne.com\n",
    );
    return;
  }
  assert(
    positionals.length === 1,
    "Unexpected positional arguments. Use --help for supported commands.",
  );
  if (command === "keygen") {
    assert(values.output, "Specify --output for the protected encryption-key file.");
    if (process.env.N8N_CODEX_STORE_DIR)
      assert(
        !path
          .resolve(values.output)
          .startsWith(`${path.resolve(process.env.N8N_CODEX_STORE_DIR)}${path.sep}`),
        "Keep the master encryption key outside the profile store.",
      );
    await writeNew(values.output, `N8N_CODEX_STORE_KEY=${randomBytes(32).toString("base64")}\n`);
    process.stdout.write(
      "Encryption key saved to the requested protected file. Keep this file separate from the profile volume.\n",
    );
    return;
  }
  const online = values.online === true || process.env.N8N_CODEX_MODE === "gateway";
  if (online) {
    assert(!values.offline, "Choose exactly one helper mode.");
    assert(
      !process.env.N8N_CODEX_STORE_DIR && !process.env.N8N_CODEX_STORE_KEY,
      "Online helpers must not mount or configure the profile store/key.",
    );
    const origin = process.env.N8N_CODEX_ADMIN_URL,
      keyFile = process.env.N8N_CODEX_ADMIN_TOKEN_FILE;
    assert(
      origin && keyFile,
      "Online helpers require N8N_CODEX_ADMIN_URL and protected N8N_CODEX_ADMIN_TOKEN_FILE.",
    );
    const client = new ControlClient(origin, keyFile);
    if (command === "status" || command === "doctor") {
      process.stdout.write(JSON.stringify(await client.call("accounts"), null, 2) + "\n");
      return;
    }
    assert(command === "import" || command === "device-login", "Unknown helper operation.");
    assert(values.label, "Specify an account label.");
    const reconnect = values.reconnect
      ? credentialBinding(await readInput(values.reconnect))
      : undefined;
    assert(
      reconnect || values["binding-output"],
      "Specify --binding-output before connecting an account.",
    );
    let result: Record<string, any>;
    if (command === "import") {
      assert(
        values.input && (values.format === "token-set" || values.format === "codex-auth-json"),
        "Specify --input and --format.",
      );
      result = await client.call("import", {
        label: values.label,
        format: values.format,
        session: await readInput(values.input),
        ...(reconnect ? { reconnectProfileId: reconnect.profileId } : {}),
      });
    } else {
      result = await client.call("device", {
        label: values.label,
        ...(reconnect ? { reconnectProfileId: reconnect.profileId } : {}),
      });
      const id = result.id;
      let shown = false;
      const cancelled = new AbortController();
      const cancel = () => cancelled.abort();
      process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
      try {
      while (result.state === "waiting") {
        if (cancelled.signal.aborted) throw new Error("Device login cancelled.");
        if (result.url && result.code && !shown) {
          process.stdout.write(
            `Open ${result.url} and enter ${result.code}. Continue only for this requested login.\n`,
          );
          shown = true;
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
        result = await client.call("device/status", { id }, cancelled.signal);
      }
      assert(result.state === "connected", "The owner did not complete the device login.");
      } finally {
        process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
        if (cancelled.signal.aborted) await client.call("device/cancel", { id });
      }
    }
    if (result.deliveryId) {
      const bundle = await client.call("delivery", { id: result.deliveryId });
      await writeNew(values["binding-output"]!, JSON.stringify(bundle.binding, null, 2) + "\n");
      await client.call("delivery/acknowledge", { id: result.deliveryId });
    }
    process.stdout.write(
      "Account connected by the profile owner. Protected binding delivery is complete.\n",
    );
    return;
  }
  const rt = runtimeFromEnvironment({ readOnly: command === "status" || command === "doctor" });
  try {
    await rt.store.ready();
    if (command === "status" || command === "doctor") {
      assert(values.binding, "Specify the protected binding file with --binding.");
      const profile = await rt.store.read(credentialBinding(await readInput(values.binding)));
      process.stdout.write(
        JSON.stringify(
          {
            ...localStatus(profile, rt.sessions.refreshEnabled),
            generation: profile.generation,
            automaticRenewal:
              localStatus(profile, rt.sessions.refreshEnabled).account.renewal === "enabled",
          },
          null,
          2,
        ) + "\n",
      );
      return;
    }
    assert(
      command === "device-login" || command === "import",
      "Unknown command. Use --help for supported commands.",
    );
    assert(values.label, "Specify an account label with --label.");
    if (command === "import")
      assert(
        values.input && (values.format === "token-set" || values.format === "codex-auth-json"),
        "Manual import requires --format token-set|codex-auth-json and --input <protected-file|->.",
      );
    assert(
      values["binding-output"] || values.reconnect,
      "Specify a new protected binding file with --binding-output.",
    );
    const existing = values.reconnect
      ? credentialBinding(await readInput(values.reconnect))
      : undefined;
    const output = values["binding-output"] ?? values.reconnect!;
    const prepared = existing ? undefined : rt.sessions.prepareNewProfile();
    let reserved = false;
    let commitMayHaveStarted = false;
    let durable;
    if (!values.reconnect || path.resolve(output) !== path.resolve(values.reconnect)) {
      // Reserve the output before network login to avoid leaving an inaccessible profile.
      durable = await deliverBinding(output, existing ?? prepared!.binding);
      reserved = true;
    }
    const cancellation = new AbortController();
    const cancel = () => cancellation.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      let tokens;
      if (command === "import") {
        assert(
          values.input && (values.format === "token-set" || values.format === "codex-auth-json"),
          "Manual import requires --format token-set|codex-auth-json and --input <protected-file|->.",
        );
        tokens = parseManualTokens(
          await readInput(values.input, cancellation.signal),
          values.format,
        );
      } else {
        tokens = await rt.auth.deviceLogin((url, code) => {
          process.stdout.write(
            `Open ${url} in your browser and enter the one-time code: ${code}\nContinue only if you started this login. Waiting for authorization (up to 15 minutes)…\n`,
          );
        }, cancellation.signal);
      }
      throwIfAborted(cancellation.signal);
      // The complete binding is durable before activation; retain it after any possible commit.
      commitMayHaveStarted = true;
      const result = prepared
        ? await rt.sessions.activatePreparedProfile(prepared, tokens, values.label, {
            bindingDurable: durable!,
            signal: cancellation.signal,
          })
        : {
            binding: await rt.sessions.importTokens(
              tokens,
              values.label,
              existing,
              cancellation.signal,
            ),
            state: cancellation.signal.aborted ? "committed_after_cancel" : "connected",
          };
      if (result.state === "committed_after_cancel")
        process.stdout.write(
          "committed_after_cancel: Account connection committed after cancellation. The protected binding remains usable.\n",
        );
      process.stdout.write(
        "Account connected. Open the protected binding file locally and copy Profile ID and Binding Secret into a new Codex Account credential in n8n.\n",
      );
    } finally {
      if (cancellation.signal.aborted && values.input === "-") process.stdin.destroy();
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
      if (reserved && !commitMayHaveStarted)
        await rm(output, { force: true }).catch(() => undefined);
    }
  } finally {
    await closeRuntimeOwner(rt);
  }
}

void main().catch((error) => {
  const safe = safeError(error);
  process.stderr.write(
    `${safe.category === "cancelled" ? "cancelled_before_commit: " : safe.category === "reconnect" ? "reconnect_required: " : ""}${safe.message}\n`,
  );
  process.exitCode = 1;
});
