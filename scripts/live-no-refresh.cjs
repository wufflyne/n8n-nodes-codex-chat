#!/usr/bin/env node
// Explicitly opt-in smoke test. Reads only stdin; never creates a profile or invokes refresh.
const { createHash } = require("node:crypto");
const {
  CodexAuthProvider,
  parseManualTokens,
  ModelCatalog,
  ResponsesTransport,
  CodexChatModel,
} = require("../dist");
const {
  HumanMessage,
  ToolMessage,
  SystemMessage,
} = require("@langchain/core/messages");

let phase = 1;
async function main() {
  if (process.stdin.isTTY)
    throw new Error(
      "Pipe an explicitly authorized Codex auth JSON to stdin. No automatic auth discovery is supported.",
    );
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error("Input size limit exceeded.");
    chunks.push(chunk);
  }
  const source = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const imported = parseManualTokens(source, "codex-auth-json");
  // Discard renewable material before any provider operation.
  let refreshCalls = 0;
  const speedFields = new Map();
  const noRefreshFetch = async (url, init = {}) => {
    if (
      String(url).includes("/oauth/token") ||
      String(url).includes("/deviceauth/")
    ) {
      refreshCalls++;
      throw new Error("Renewal is forbidden in this harness.");
    }
    const response = await fetch(url, init);
    if (String(url).includes("/codex/models?") && response.ok) {
      const data = await response.clone().json();
      for (const model of data.models ?? [])
        speedFields.set(model.slug, {
          legacyFast:
            Array.isArray(model.additional_speed_tiers) &&
            model.additional_speed_tiers.includes("fast"),
          legacyUltrafast:
            Array.isArray(model.additional_speed_tiers) &&
            model.additional_speed_tiers.includes("ultrafast"),
        });
    }
    return response;
  };
  const verified = await new CodexAuthProvider(noRefreshFetch).verify({
    ...imported,
    refreshToken: undefined,
    idToken: undefined,
  });
  if (verified.tokens.expiresAt <= Date.now() + 10000)
    throw new Error(
      "The current access token is expired or too close to expiry. No refresh was attempted.",
    );
  const session = Object.freeze({
    accessToken: verified.tokens.accessToken,
    accountId: verified.identity.accountId,
    generation: 0,
    affinity: `live-${createHash("sha256").update(verified.identity.accountId).digest("hex")}`,
  });
  const catalog = new ModelCatalog(noRefreshFetch);
  phase = 2;
  const models = await catalog.list(session);
  if (process.argv.includes("--list")) {
    process.stdout.write(
      JSON.stringify({
        fixture: "authorized-live-no-refresh",
        status: "catalog",
        refreshCalls,
        models: models.map((m) => ({
          slug: m.slug,
          lite: m.useResponsesLite,
          efforts: m.reasoningEfforts,
          tiers: m.serviceTiers
            .map((t) => t.id)
            .filter((id) =>
              [
                "standard",
                "priority",
                "flex",
                "auto",
                "default",
                "fast",
                "ultrafast",
              ].includes(id),
            ),
          ...speedFields.get(m.slug),
        })),
      }) + "\n",
    );
    return;
  }
  const index = process.argv.indexOf("--model");
  const modelName = index >= 0 ? process.argv[index + 1] : models[0].slug;
  if (!modelName) throw new Error("Specify --model <catalog-model-id>.");
  const model = new CodexChatModel({
    model: modelName,
    session: async () => session,
    catalog,
    transport: new ResponsesTransport(noRefreshFetch),
    settings: { maxRetries: 0, timeoutMs: 60000, idleTimeoutMs: 30000 },
  });
  phase = 3;
  const result = await model.invoke([
    new SystemMessage(
      "You are a helpful assistant. Follow the requested test format.",
    ),
    new HumanMessage("Reply exactly: N8N_CODEX_OK"),
  ]);
  if (result.content !== "N8N_CODEX_OK")
    throw new Error(
      "The completed response did not match the smoke-test marker.",
    );
  let toolPassed;
  if (process.argv.includes("--tool")) {
    phase = 4;
    const bound = model.bindTools([
      {
        type: "function",
        function: {
          name: "safe_echo",
          description: "Echo a test marker without side effects.",
          parameters: {
            type: "object",
            properties: { value: { type: "string", enum: ["N8N_TOOL_OK"] } },
            required: ["value"],
            additionalProperties: false,
          },
        },
      },
    ]);
    const input = [
      new SystemMessage("Use the connected native tools when requested."),
      new HumanMessage(
        "Call safe_echo with value N8N_TOOL_OK, then reply exactly its result.",
      ),
    ];
    const call = await bound.invoke(input);
    if (
      call.tool_calls?.length !== 1 ||
      call.tool_calls[0].name !== "safe_echo" ||
      call.tool_calls[0].args.value !== "N8N_TOOL_OK"
    )
      throw new Error("Safe echo contract failed.");
    const final = await bound.invoke([
      ...input,
      call,
      new ToolMessage({
        tool_call_id: call.tool_calls[0].id,
        content: "N8N_TOOL_OK",
      }),
    ]);
    toolPassed = final.content === "N8N_TOOL_OK";
    if (!toolPassed) throw new Error("Safe echo terminal marker failed.");
  }
  process.stdout.write(
    JSON.stringify({
      fixture: "authorized-live-no-refresh",
      status: "completed",
      model: modelName,
      textPassed: true,
      ...(toolPassed === undefined ? {} : { toolPassed }),
      refreshCalls,
      usage: result.usage_metadata,
    }) + "\n",
  );
}
main().catch((error) => {
  const categories = [
    "configuration",
    "protocol",
    "provider",
    "authentication",
    "timeout",
    "reconnect",
    "cancelled",
    "rate_limit",
  ];
  const protocolMessages = [
    "The provider returned an invalid streaming event.",
    "The provider stream ended before response.completed. No tool calls were released.",
    "The provider did not return an SSE response.",
    "The provider stream was interrupted or contained invalid UTF-8.",
    "The provider returned invalid tool arguments. No tool calls were released.",
    "The provider stream was interrupted.",
    "The provider returned an empty streaming response.",
  ];
  const protocolIndex = protocolMessages.indexOf(error?.message);
  process.exitCode =
    (protocolIndex >= 0 ? 110 + protocolIndex : 0) ||
    phase * 10 +
      (error?.name === "CodexError"
        ? categories.indexOf(error.category) + 1
        : 9);
});
