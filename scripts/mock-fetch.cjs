// Synthetic provider for an isolated native n8n process. Never load this in production.
if (process.env.N8N_CODEX_SYNTHETIC_PROVIDER !== "1")
  throw new Error("Synthetic provider preload requires explicit test opt-in.");
const originalFetch = global.fetch;
const lite = process.env.N8N_CODEX_SYNTHETIC_LITE === "1";
const catalog = {
  models: [
    {
      slug: "synthetic-model",
      display_name: "Synthetic Contract Model",
      visibility: "list",
      supported_reasoning_levels: [{ effort: "low" }],
      supports_reasoning_summary_parameter: true,
      support_verbosity: true,
      service_tiers: [{ id: "priority", name: "Synthetic Fast" }],
      input_modalities: ["text"],
      context_window: 128000,
      use_responses_lite: lite,
    },
  ],
};
let sequence = 0;
global.fetch = async (url, init = {}) => {
  const address = String(url);
  if (address.startsWith("https://auth.openai.com/"))
    throw new Error(
      "Synthetic native tests never contact an identity service or refresh credentials.",
    );
  if (address.startsWith("https://chatgpt.com/backend-api/codex/models?"))
    return Response.json(catalog);
  if (address !== "https://chatgpt.com/backend-api/codex/responses")
    return originalFetch(url, init);
  const request = JSON.parse(init.body);
  const number = ++sequence;
  const results = request.input.filter(
    (item) => item.type === "function_call_output",
  );
  const tools =
    request.tools ??
    request.input.find((item) => item.type === "additional_tools")?.tools[0]
      ?.tools ??
    [];
  const resultValue = (item) => JSON.parse(item.output)[0].response;
  if (
    results.length >= 2 &&
    (resultValue(results[0]) !== "3" || resultValue(results[1]) !== "6")
  )
    throw new Error(
      "Synthetic native tool results do not match actual execution.",
    );
  console.error(
    JSON.stringify({
      fixture: "synthetic-native-request",
      resultCount: results.length,
      reasoningCount: request.input.filter((item) => item.type === "reasoning")
        .length,
      callCount: request.input.filter((item) => item.type === "function_call")
        .length,
    }),
  );
  if (
    results.length >= 2 &&
    request.input.filter((item) => item.type === "reasoning").length !== 1
  )
    throw new Error(
      "Synthetic opaque reasoning was lost or duplicated across native tool rounds.",
    );
  let output;
  if (
    results.length === 0 &&
    tools.some((tool) => tool.name === "native_add_one") &&
    tools.some((tool) => tool.name === "native_double")
  ) {
    output = [
      {
        type: "reasoning",
        id: `rs_${number}`,
        summary: [],
        encrypted_content: "SYNTHETIC_OPAQUE_REASONING",
      },
      {
        type: "function_call",
        id: `fc_${number}_a`,
        call_id: `call_${number}_a`,
        name: "native_add_one",
        arguments: '{"value":2}',
        status: "completed",
      },
      {
        type: "function_call",
        id: `fc_${number}_b`,
        call_id: `call_${number}_b`,
        name: "native_double",
        arguments: '{"value":3}',
        status: "completed",
      },
    ];
  } else if (results.length === 2) {
    output = [
      {
        type: "function_call",
        id: `fc_${number}_next`,
        call_id: `call_${number}_next`,
        name: "native_add_one",
        arguments: '{"value":6}',
        status: "completed",
      },
    ];
  } else if (
    results.length === 3 &&
    tools.some((tool) => tool.name === "format_final_json_response")
  ) {
    if (resultValue(results[2]) !== "7")
      throw new Error("Synthetic sequential native tool result is incorrect.");
    output = [
      {
        type: "function_call",
        id: `fc_${number}_format`,
        call_id: `call_${number}_format`,
        name: "format_final_json_response",
        arguments: '{"output":{"answer":"3, 6, 7"}}',
        status: "completed",
      },
    ];
  } else {
    output = [
      {
        type: "message",
        id: `msg_${number}`,
        role: "assistant",
        status: "completed",
        phase: "final_answer",
        content: [
          {
            type: "output_text",
            text: results.length >= 2 ? "3 and 6" : "Synthetic native response",
          },
        ],
      },
    ];
  }
  if (lite)
    for (const item of output)
      if (item.type === "function_call") item.namespace = "functions";
  const events = output.map((item, index) => ({
    type: "response.output_item.done",
    output_index: index,
    item,
  }));
  for (const item of output)
    if (item.type === "message")
      events.unshift({
        type: "response.output_text.delta",
        delta: item.content[0].text,
      });
  events.push({
    type: "response.completed",
    response: {
      id: `resp_synthetic_${number}`,
      usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
    },
  });
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events)
          controller.enqueue(Buffer.from(`data: ${JSON.stringify(event)}\n\n`));
        controller.close();
      },
    }),
    {
      headers: {
        "content-type": "text/event-stream",
        "x-request-id": `req_synthetic_${number}`,
      },
    },
  );
};
