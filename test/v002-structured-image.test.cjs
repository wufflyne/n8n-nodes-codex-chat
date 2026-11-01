const { test } = require("node:test");
const assert = require("node:assert/strict");
const { HumanMessage } = require("@langchain/core/messages");
const { CodexChatModel, ModelCatalog, ResponsesTransport } = require("../dist");
const {
  rawModel,
  session,
  output,
  complete,
  sseResponse,
  mockFetch,
} = require("./helpers.cjs");
const { imageDimensions, normalizeImage } = require("../dist/image/validation");
const { ImageService } = require("../dist/image/service");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0x8AAAAASUVORK5CYII=",
  "base64",
);
const schema = {
  type: "object",
  properties: { value: { type: "number" } },
  required: ["value"],
  additionalProperties: false,
};
for (const method of ['functionCalling', 'jsonSchema']) {
  test(`Structured ${method} refuses inherited async Zod tuple corruption without a repair generation`, async () => {
    const z = require('zod/v4');
    const owned = z.object({ items: z.tuple([
      z.string().refine(async () => true),
      z.string().refine(async () => true),
    ]).meta({ minItems: 2, maxItems: 2 }) });
    let calls = 0;
    const fetchImpl = mockFetch(async request => {
      calls++;
      return sseResponse([complete(output('', { output: method === 'jsonSchema'
        ? output('{"items":["a","b"]}').output
        : [{ type: 'function_call', call_id: `tuple-${calls}`, name: request.tools[0].name, arguments: '{"items":["a","b"]}' }],
      }))]);
    });
    const model = new CodexChatModel({ model: 'synthetic-model', session: async () => session(), catalog: new ModelCatalog(fetchImpl), transport: new ResponsesTransport(fetchImpl) });
    const result = await model.withStructuredOutput(owned, { method, includeRaw: true }).invoke('Synthetic');
    assert.equal(result.parsed, null);
    assert.equal(result.raw.response_metadata.structuredParserStatus, 'invalid_output');
    assert.equal(calls, 1);
    assert(result.raw);
    await assert.rejects(model.withStructuredOutput(owned, { method }).invoke('Synthetic'), error => error.category === 'protocol');
    assert.equal(calls, 2); // One generation per explicit invocation, including the refusal.
  });
  test(`Structured ${method} preserves valid async Zod transformations and class values`, async () => {
    const z = require('zod');
    class Label { constructor(value) { this.value = value; } }
    const owned = z.object({
      value: z.string().transform(async value => new Label(value)),
      when: z.string().transform(value => new Date(value)),
      items: z.array(z.string().refine(async () => true)),
    });
    let calls = 0;
    const value = { value: 'ordinary', when: '2026-11-01T00:00:00.000Z', items: ['a', 'b'] };
    const fetchImpl = mockFetch(async request => {
      calls++;
      return sseResponse([complete(output('', { output: method === 'jsonSchema'
        ? output(JSON.stringify(value)).output
        : [{ type: 'function_call', call_id: 'valid-async', name: request.tools[0].name, arguments: JSON.stringify(value) }],
      }))]);
    });
    const model = new CodexChatModel({ model: 'synthetic-model', session: async () => session(), catalog: new ModelCatalog(fetchImpl), transport: new ResponsesTransport(fetchImpl) });
    const result = await model.withStructuredOutput(owned, { method }).invoke('Synthetic');
    assert(result.value instanceof Label);
    assert.equal(result.value.value, 'ordinary');
    assert(result.when instanceof Date);
    assert.equal(result.when.toISOString(), value.when);
    assert.deepEqual(result.items, ['a', 'b']);
    assert.equal(calls, 1);
  });
}
for (const lite of [false, true])
  for (const method of ["functionCalling", "jsonSchema"])
    test(`Structured ${method} validates locally and performs one generation (${lite ? "Lite" : "standard"})`, async () => {
      let calls = 0,
        last;
      const fetchImpl = mockFetch(
        async (request) => {
          calls++;
          last = request;
          const tool = lite
            ? request.input.find((i) => i.type === "additional_tools")?.tools[0]
                .tools[0]
            : request.tools?.[0];
          return sseResponse([
            complete(
              output(method === "jsonSchema" ? ' {"value":7} ' : "", {
                output:
                  method === "jsonSchema"
                    ? output('{"value":7}').output
                    : [
                        {
                          type: "function_call",
                          call_id: "format",
                          name: tool.name,
                          arguments: '{"value":7}',
                          ...(lite ? { namespace: "functions" } : {}),
                        },
                      ],
              }),
            ),
          ]);
        },
        rawModel({ use_responses_lite: lite }),
      );
      const model = new CodexChatModel({
        model: "synthetic-model",
        session: async () => session(),
        catalog: new ModelCatalog(fetchImpl),
        transport: new ResponsesTransport(fetchImpl),
      });
      assert.deepEqual(
        await model.withStructuredOutput(schema, { method }).invoke("Return"),
        { value: 7 },
      );
      assert.equal(calls, 1);
      if (method === "jsonSchema") {
        assert.equal(last.text.format.type, "json_schema");
        assert.equal(last.text.format.strict, true);
      } else assert.equal(last.tool_choice, "auto");
    });
test("Plain JSON Schema violation returns controlled includeRaw {raw,parsed:null} without repair generation", async () => {
  let calls = 0;
  const fetchImpl = mockFetch(async (request) => {
    calls++;
    return sseResponse([
      complete(
        output("", {
          output: [
            {
              type: "function_call",
              call_id: `c${calls}`,
              name: request.tools[0].name,
              arguments: '{"value":"wrong"}',
            },
          ],
        }),
      ),
    ]);
  });
  const m = new CodexChatModel({
    model: "synthetic-model",
    session: async () => session(),
    catalog: new ModelCatalog(fetchImpl),
    transport: new ResponsesTransport(fetchImpl),
  });
  const result = await m
    .withStructuredOutput(schema, { includeRaw: true })
    .invoke("Test");
  assert.deepEqual(Object.keys(result).sort(), ["parsed", "raw"]);
  assert.equal(result.parsed, null);
  assert.equal(
    result.raw.response_metadata.structuredParserStatus,
    "invalid_output",
  );
  await assert.rejects(
    m.withStructuredOutput(schema).invoke("Test"),
    /structured response/,
  );
  assert.equal(calls, 2);
});
test("Structured API rejects remote refs, jsonMode, excessive depth, wrong calls and preserves Zod refinements", async () => {
  const fetchImpl = mockFetch(async (request) =>
    sseResponse([
      complete(
        output("", {
          output: [
            {
              type: "function_call",
              call_id: "c",
              name: request.tools[0].name,
              arguments: '{"value":1}',
            },
          ],
        }),
      ),
    ]),
  );
  const m = new CodexChatModel({
    model: "synthetic-model",
    session: async () => session(),
    catalog: new ModelCatalog(fetchImpl),
    transport: new ResponsesTransport(fetchImpl),
  });
  assert.throws(
    () => m.withStructuredOutput(schema, { method: "jsonMode" }),
    /jsonMode/,
  );
  assert.throws(
    () => m.withStructuredOutput({ $ref: "https://example.invalid/schema" }),
    /Remote/,
  );
  let deep = { type: "string" };
  for (let i = 0; i < 34; i++)
    deep = { type: "object", properties: { nested: deep } };
  assert.throws(() => m.withStructuredOutput(deep), /depth/);
  const { z } = require("zod");
  const result = await m
    .withStructuredOutput(
      z.object({ value: z.number().refine((v) => v > 5) }),
      { includeRaw: true },
    )
    .invoke("Value");
  assert.equal(result.parsed, null);
});
test("Direct schema plus tools and unsupported modalities fail before inference", async () => {
  let calls = 0;
  const fetchImpl = mockFetch(async () => {
    calls++;
    return sseResponse([complete(output())]);
  });
  const m = new CodexChatModel({
    model: "synthetic-model",
    session: async () => session(),
    catalog: new ModelCatalog(fetchImpl),
    transport: new ResponsesTransport(fetchImpl),
  });
  await assert.rejects(
    m.invoke("Mix", {
      tools: [
        {
          type: "function",
          function: { name: "tool", parameters: { type: "object" } },
        },
      ],
      codexOutputFormat: {
        type: "json_schema",
        name: "x",
        strict: true,
        schema,
      },
    }),
    /combined with tools/,
  );
  await assert.rejects(
    m.invoke([new HumanMessage({ content: [{ type: "audio", data: "NO" }] })]),
    /unsupported/,
  );
  assert.equal(calls, 0);
});
test("Canonical image sources preserve bytes/order and reject ambiguous MIME/detail/private URLs", () => {
  const model = { supportsImages: true, originalImageDetail: true };
  for (const block of [
    {
      type: "image_url",
      image_url: `data:image/png;base64,${png.toString("base64")}`,
    },
    {
      type: "image",
      source_type: "base64",
      mime_type: "image/png",
      data: png.toString("base64"),
    },
    { type: "image", mimeType: "image/png", data: new Uint8Array(png) },
    {
      type: "input_image",
      image_url: `data:image/png;base64,${png.toString("base64")}`,
      detail: "original",
    },
  ]) {
    const budget = { count: 0, bytes: 0 };
    const normalized = normalizeImage(block, model, budget);
    assert(normalized.image_url.endsWith(png.toString("base64")));
    assert.equal(budget.bytes, png.length);
  }
  for (const block of [
    {
      type: "image_url",
      image_url: "data:image/jpeg;base64," + png.toString("base64"),
    },
    { type: "image", url: "https://example.org/a", data: "AA==" },
    {
      type: "image_url",
      image_url: { url: "https://example.org/a", detail: "unknown" },
    },
    ...[
      "http://example.org/a",
      "https://user:password@example.org/a",
      "https://127.0.0.1/a",
      "https://[::1]/a",
      "https://169.254.169.254/a",
    ].map((url) => ({ type: "image_url", image_url: url })),
  ])
    assert.throws(() => normalizeImage(block, model, { count: 0, bytes: 0 }));
  assert.throws(
    () =>
      normalizeImage(
        { type: "image_url", image_url: "https://example.org/a" },
        { supportsImages: false },
        { count: 0, bytes: 0 },
      ),
    /not advertised/,
  );
});
test("Generated raster header dimensions are bounded and invalid/truncated formats fail", () => {
  assert.deepEqual(imageDimensions(png), {
    mimeType: "image/png",
    extension: "png",
    width: 1,
    height: 1,
  });
  const huge = Buffer.from(png);
  huge.writeUInt32BE(20000, 16);
  assert.throws(() => imageDimensions(huge), /dimensions/);
  for (const bytes of [
    png.subarray(0, 20),
    Buffer.from("GIF89a"),
    Buffer.from([255, 216, 255]),
    Buffer.from("RIFFxxxxWEBP"),
  ])
    assert.throws(() => imageDimensions(bytes));
});
test("Codex Image uses only the pinned account route/body and returns binary metadata without base64", async () => {
  let request,
    calls = 0;
  const service = new ImageService(
    { session: async () => session(), currentSession: async () => session() },
    async (url, init) => {
      calls++;
      request = { url, body: JSON.parse(init.body), headers: init.headers };
      return Response.json({
        created: Math.floor(Date.now() / 1000),
        data: [
          {
            b64_json: png.toString("base64"),
            generation_id: "synthetic-generation",
          },
        ],
        background: "transparent",
      });
    },
  );
  const result = await service.generate({}, "A synthetic shape.", true);
  assert.equal(
    request.url,
    "https://chatgpt.com/backend-api/codex/images/generations",
  );
  assert.deepEqual(request.body, {
    prompt: "A synthetic shape.",
    model: "gpt-image-2",
    background: "transparent",
    quality: "auto",
    size: "auto",
  });
  assert.equal(calls, 1);
  assert(result.bytes.equals(png));
  assert.equal(result.metadata.width, 1);
  assert(!JSON.stringify(result.metadata).includes(png.toString("base64")));
});
test("Image admission/ambiguity/parse errors never retry or trigger chat resets", async () => {
  for (const fetchImpl of [
    async () => {
      throw Error("SYNTHETIC_SECRET");
    },
    async () => new Response("bad", { status: 200 }),
    async () => new Response("rejected", { status: 429 }),
    async () => Response.json({ created: 1, data: [] }),
  ]) {
    let calls = 0;
    const service = new ImageService(
      { session: async () => session() },
      async (...args) => {
        calls++;
        return fetchImpl(...args);
      },
    );
    await assert.rejects(
      service.generate({}, "Synthetic", false),
      (e) => !e.message.includes("SYNTHETIC_SECRET"),
    );
    assert.equal(calls, 1);
  }
});

test("Structured includeRaw preserves malformed or wrong-name calls as parser failures without releasing ordinary tools", async () => {
  for (const item of [
    { name: "wrong_function", arguments: "{}" },
    { name: "extract", arguments: "{invalid" },
  ]) {
    let calls = 0;
    const fetchImpl = mockFetch(async () => {
      calls++;
      return sseResponse([
        complete(
          output("", {
            output: [
              { type: "function_call", call_id: "structured-invalid", ...item },
            ],
          }),
        ),
      ]);
    });
    const m = new CodexChatModel({
      model: "synthetic-model",
      session: async () => session(),
      catalog: new ModelCatalog(fetchImpl),
      transport: new ResponsesTransport(fetchImpl),
    });
    const result = await m
      .withStructuredOutput(schema, { includeRaw: true })
      .invoke("Test failure");
    assert.equal(result.parsed, null);
    assert.equal(
      result.raw.response_metadata.structuredParserStatus,
      "invalid_output",
    );
    assert.equal(calls, 1);
    if (item.arguments === "\u007binvalid")
      assert.equal(result.raw.invalid_tool_calls.length, 1);
  }
});

test("Strict base64 handles documented 10/32 MiB limits and rejects malformed/noncanonical tails", () => {
  const { strictBase64 } = require("../dist/image/validation");
  for (const limit of [10 * 1024 * 1024, 32 * 1024 * 1024]) {
    const bytes = Buffer.alloc(limit, 0x71),
      encoded = bytes.toString("base64");
    assert(strictBase64(encoded, limit).equals(bytes));
    assert.throws(() => strictBase64(encoded, limit - 1), /base64|size/);
  }
  for (const invalid of [
    "",
    "AAAA=AAA",
    "A===",
    "====",
    "AA=A",
    "AAA",
    "AA==\n",
    "A A=",
    "雪AAA",
    "AB==",
    "AAB=",
  ])
    assert.throws(() => strictBase64(invalid, 1024), /base64/);
  for (const valid of ["AA==", "AAA=", "AAAA"])
    assert.equal(strictBase64(valid, 3).toString("base64"), valid);
  assert.throws(
    () =>
      normalizeImage(
        {
          type: "image_url",
          image_url: {
            url: "https://example.invalid/image",
            detail: { toString: () => "auto" },
          },
        },
        { supportsImages: true },
        { count: 0, bytes: 0 },
      ),
    /detail/,
  );
  assert.throws(
    () =>
      imageDimensions(
        Buffer.concat([
          Buffer.from([0xff, 0xd8]),
          Buffer.alloc(256 * 1024, 0xff),
        ]),
      ),
    /scan limit/,
  );
});

test("Structured schema traversal preserves reserved property names and literal default/const data", async () => {
  const literal = {
      $async: true,
      $ref: "https://literal.example.invalid/value",
    },
    expected = { $ref: "literal field", $async: true, payload: literal },
    reservedSchema = {
      type: "object",
      properties: {
        $ref: { type: "string" },
        $async: { type: "boolean" },
        payload: {
          type: "object",
          const: literal,
          default: literal,
          examples: [literal],
        },
      },
      required: ["$ref", "$async", "payload"],
      additionalProperties: false,
    };
  for (const lite of [false, true]) {
    let calls = 0;
    const fetchImpl = mockFetch(
      async (request) => {
        calls++;
        assert.deepEqual(request.text.format.schema, reservedSchema);
        return sseResponse([complete(output(JSON.stringify(expected)))]);
      },
      rawModel({ use_responses_lite: lite }),
    );
    const model = new CodexChatModel({
      model: "synthetic-model",
      session: async () => session(),
      catalog: new ModelCatalog(fetchImpl),
      transport: new ResponsesTransport(fetchImpl),
    });
    assert.deepEqual(
      await model
        .withStructuredOutput(reservedSchema, { method: "jsonSchema" })
        .invoke("Return literal fields"),
      expected,
    );
    assert.equal(calls, 1);
    assert.throws(
      () =>
        model.withStructuredOutput({
          type: "object",
          $defs: { forbidden: { $async: true, type: "string" } },
        }),
      /Async/,
    );
    assert.throws(
      () =>
        model.withStructuredOutput({
          allOf: [{ $ref: "https://schema.example.invalid/remote" }],
        }),
      /Remote/,
    );
  }
});
