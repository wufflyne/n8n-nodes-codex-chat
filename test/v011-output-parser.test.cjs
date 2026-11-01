const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CodexJsonOutputParser } = require("../dist/n8n/json-output-parser.js");
const { OutputParserException } = require("@langchain/core/output_parsers");
const { DynamicStructuredTool } = require("@langchain/core/tools");
const schema = {
  type: "object",
  properties: { value: { type: "string" }, items: { type: "array", items: { type: "integer" } } },
  required: ["value"],
  additionalProperties: false,
};
test("Native Codex parser preserves strict JSON data and standalone JSON fences", async () => {
  const p = new CodexJsonOutputParser(schema),
    value = { value: "fixture", items: [1, 2] };
  assert.deepEqual(await p.parse(JSON.stringify(value)), value);
  assert.deepEqual(await p.parse("```json\n" + JSON.stringify(value) + "\n```"), value);
});
test("Native Codex parser refuses invalid collection before any host Zod conversion", async () => {
  const p = new CodexJsonOutputParser(schema);
  await assert.rejects(
    p.parse(JSON.stringify({ value: "fixture", items: Array(4096).fill("invalid") })),
    (e) =>
      e instanceof OutputParserException &&
      e.llmOutput === undefined &&
      !e.message.includes('invalid","invalid'),
  );
  await assert.rejects(
    p.parse('{"value":"fixture","extra":true}'),
    (e) => e instanceof OutputParserException && e.llmOutput === undefined,
  );
});
test("Native Codex parser bounds bytes, depth and inspected elements", async () => {
  const p = new CodexJsonOutputParser({ type: "object", additionalProperties: true });
  await assert.rejects(p.parse(" ".repeat(4 * 1024 * 1024 + 1)));
  let v = {};
  for (let i = 0; i < 65; i++) v = { next: v };
  await assert.rejects(p.parse(JSON.stringify(v)));
  await assert.rejects(p.parse(JSON.stringify({ items: Array(65537).fill(1) })));
});
test("Native parser schema is detached and remote or asynchronous schemas are refused", () => {
  const p = new CodexJsonOutputParser(schema),
    copy = p.getSchema();
  copy.properties.value.type = "number";
  assert.equal(p.getSchema().properties.value.type, "string");
  assert.throws(
    () => new CodexJsonOutputParser({ type: "object", $ref: "https://example.invalid/remote" }),
  );
  assert.throws(() => new CodexJsonOutputParser({ type: "object", $async: true }));
});
test("Public DynamicStructuredTool accepts strict JSON Schema without Zod or added tool metadata", async () => {
  const p = new CodexJsonOutputParser(schema);
  let calls = 0;
  const tool = new DynamicStructuredTool({
    name: "format_final_json_response",
    description: "Return the exact JSON data.",
    schema: p.getSchema(),
    func: async (value) => {
      calls++;
      return p.parse(JSON.stringify(value));
    },
  });
  assert.deepEqual(await tool.invoke({ value: "fixture" }), { value: "fixture" });
  assert.equal(calls, 1);
  await assert.rejects(tool.invoke({ value: "fixture", toolCallId: "unexpected" }));
  assert.equal(calls, 1);
});

test("Unterminated whitespace JSON fence refuses without a backtracking scanner or raw output", async () => {
  const p = new CodexJsonOutputParser(schema);
  await assert.rejects(
    p.parse("```json\n" + " \n".repeat(250000) + "x"),
    (e) =>
      e instanceof OutputParserException && e.llmOutput === undefined && !e.message.includes("```"),
  );
});

test("Native schema read failures are local configuration errors without raw expression text", async () => {
  const {
    CodexOutputParser,
  } = require("../dist/nodes/CodexOutputParser/CodexOutputParser.node.js");
  await assert.rejects(
    new CodexOutputParser().supplyData.call(
      {
        getNodeParameter() {
          throw Error("RAW_SCHEMA_CANARY");
        },
        getNode() {
          return { name: "Codex Output Parser" };
        },
      },
      0,
    ),
    (e) =>
      e.message.includes("Check the JSON Schema") &&
      !e.message.includes("RAW_SCHEMA_CANARY") &&
      !e.message.includes("connectivity"),
  );
});
