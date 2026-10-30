"use strict";
const http = require("node:http"),
  fs = require("node:fs"),
  path = require("node:path");
const fixtureRoot = "/fixtures";
let inferenceCount = 0,
  resetCount = 0,
  deviceCount = 0;
const recent = [];
const event = (type, value) => `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://fixture:8790");
    let bytes = 0;
    const chunks = [];
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) throw Error("Fixture body limit");
      chunks.push(chunk);
    }
    const textBody = Buffer.concat(chunks).toString();
    const raw = bytes
      ? req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")
        ? Object.fromEntries(new URLSearchParams(textBody))
        : JSON.parse(textBody)
      : {};
    const json = (value, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === "/health") return json({ ready: true, synthetic: true });
    if (url.pathname === "/metrics")
      return json({ inferenceCount, resetCount, deviceCount, recent });
    if (url.pathname === "/.well-known/jwks.json")
      return json(JSON.parse(fs.readFileSync(path.join(fixtureRoot, "jwks.json"))));
    if (url.pathname === "/oauth/token")
      return json(JSON.parse(fs.readFileSync(path.join(fixtureRoot, "token.json"))));
    if (url.pathname.endsWith("/deviceauth/usercode")) {
      deviceCount++;
      return json({ device_auth_id: "synthetic-device", user_code: "SYNTHETIC-DEMO", interval: 1 });
    }
    if (url.pathname.endsWith("/deviceauth/token"))
      return json({ authorization_code: "synthetic-code", code_verifier: "synthetic-verifier" });
    if (url.pathname.endsWith("/rate-limit-reset-credits/consume")) {
      resetCount++;
      return json({ code: "reset", windows_reset: 1 });
    }
    if (url.pathname.endsWith("/rate-limit-reset-credits"))
      return json({
        available_count: 1,
        credits: [
          {
            id: "synthetic-earned-reset",
            reset_type: "codex_rate_limits",
            status: "available",
            granted_at: new Date(Date.now() - 3600000).toISOString(),
            expires_at: new Date(Date.now() + 86400000).toISOString(),
            title: "Synthetic reset",
          },
        ],
      });
    if (url.pathname === "/redirect") {
      res.writeHead(307, { location: "http://fixture:8790/redirect-target" });
      return res.end();
    }
    if (url.pathname === "/redirect-target")
      return json({
        receivedInternalHeaders: Object.keys(req.headers).filter((name) =>
          name.startsWith("x-codex-"),
        ),
      });
    if (url.pathname.endsWith("/models"))
      return json({
        models: [
          {
            slug: "synthetic-model",
            display_name: "Synthetic model",
            description: "Isolated fixture only",
            visibility: "list",
            use_responses_lite: false,
            default_reasoning_level: "medium",
            supported_reasoning_levels: [{ effort: "medium", description: "Fixture" }],
            supports_reasoning_summary_parameter: true,
            support_verbosity: true,
            default_verbosity: "medium",
            input_modalities: ["text", "image"],
            context_window: 200000,
          },
        ],
      });
    if (url.pathname.endsWith("/usage"))
      return json({
        account_id: req.headers["chatgpt-account-id"],
        plan_type: "pro",
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: {
            used_percent: 10,
            limit_window_seconds: 18000,
            reset_at: Math.floor(Date.now() / 1000) + 3600,
          },
        },
        credits: { has_credits: false, unlimited: false, balance: null },
        rate_limit_reset_credits: { available_count: 1 },
      });
    if (url.pathname.endsWith("/images/generations"))
      return json({
        created: Math.floor(Date.now() / 1000),
        data: [
          { b64_json: fs.readFileSync(path.join(fixtureRoot, "pixel.png")).toString("base64") },
        ],
        background: "opaque",
        quality: "auto",
        size: "auto",
      });
    if (url.pathname.endsWith("/responses")) {
      inferenceCount++;
      const prompt = JSON.stringify(raw.input || []),
        fixtureCase = /CASE:([a-z_-]+)/.exec(prompt)?.[1] || "text";
      recent.push({
        attempt: inferenceCount,
        account: req.headers["chatgpt-account-id"],
        fixtureCase,
        model: raw.model,
        internalHeaders: Object.keys(req.headers).filter(
          (name) => name.startsWith("x-codex-") || name.startsWith("x-n8n-model-"),
        ),
        at: Date.now(),
      });
      if (recent.length > 100) recent.shift();
      if (fixtureCase === "rejected")
        return json(
          { error: { code: "rate_limit_exceeded", message: "Synthetic rejection" } },
          429,
        );
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      const text =
          fixtureCase === "large" ? "S".repeat(1024 * 1024) : "Synthetic qualification response",
        item = {
          type: "message",
          id: "msg_fixture_" + inferenceCount,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        };
      const hasResult = (raw.input || []).some((item) => item.type === "function_call_output");
      const selectedTool = (raw.tools || []).find((tool) => tool.type === "function");
      if (fixtureCase === "tool" && selectedTool && !hasResult) {
        const tool = {
          type: "function_call",
          id: "fc_fixture_" + inferenceCount,
          call_id: "call_fixture_" + inferenceCount,
          name: selectedTool.name,
          arguments: JSON.stringify({ value: "fixture" }),
          status: "completed",
        };
        res.write(
          event("response.output_item.added", {
            output_index: 0,
            item: { ...tool, status: "in_progress", arguments: "" },
          }),
        );
        res.write(
          event("response.function_call_arguments.delta", {
            output_index: 0,
            item_id: tool.id,
            delta: tool.arguments,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        res.end(
          event("response.completed", {
            response: {
              id: "resp_fixture_" + inferenceCount,
              status: "completed",
              output: [tool],
              usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
            },
          }),
        );
        return;
      }
      res.write(
        event("response.output_item.added", {
          output_index: 0,
          item: { ...item, status: "in_progress", content: [] },
        }),
      );
      res.write(
        event("response.output_text.delta", {
          output_index: 0,
          content_index: 0,
          item_id: item.id,
          delta: text,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, fixtureCase === "slow" ? 1000 : 50));
      if (fixtureCase === "late_failure") {
        res.end(
          event("response.failed", {
            response: { status: "failed", error: { message: "Synthetic terminal failure" } },
          }),
        );
        return;
      }
      res.write(event("response.output_item.done", { output_index: 0, item }));
      res.end(
        event("response.completed", {
          response: {
            id: "resp_fixture_" + inferenceCount,
            status: "completed",
            model: raw.model,
            output: [item],
            usage: {
              input_tokens: 10,
              output_tokens: 4,
              total_tokens: 14,
              input_tokens_details: { cached_tokens: 2 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          },
        }),
      );
      return;
    }
    return json(
      {
        error: {
          message:
            "This synthetic fixture route is not implemented. No real provider is reachable.",
        },
      },
      400,
    );
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Invalid synthetic fixture request" } }));
  }
});
server.listen(8790, "0.0.0.0");
