const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CodexChatModel, ModelCatalog, ResponsesTransport } = require("../dist");
const { CodexAccountRouterModel } = require("../dist/routing/model");
const { strictBase64, imageMime } = require("../dist/image/validation");
const { rawModel, session, mockFetch, complete, output, sseResponse } = require("./helpers.cjs");

test("Caller-frozen tool arrays remain live at call time; each bound model owns an isolated snapshot", async () => {
  for (const lite of [false, true]) {
    const requests = [];
    const fetchImpl = mockFetch(async (request) => {
      requests.push(request);
      return sseResponse([complete(output())]);
    }, rawModel({ use_responses_lite: lite }));
    const makeModel = () => new CodexChatModel({
      model: "synthetic-model", session: async () => session(),
      catalog: new ModelCatalog(fetchImpl), transport: new ResponsesTransport(fetchImpl),
    });
    const tools = Object.freeze([{
      type: "function", function: {
        name: "Tool 雪", description: "Original description", strict: false,
        parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
      },
    }]);
    const a = makeModel(), b = makeModel();
    const boundA = a.bindTools(tools);
    await a.invoke("Direct original", { tools });
    tools[0].function.parameters.properties.value.type = "number";
    tools[0].function.description = "Updated description";
    const boundB = b.bindTools(tools);
    await a.invoke("Direct changed", { tools });
    await boundA.invoke("Bound original");
    await boundB.invoke("Bound changed");
    tools[0].function.parameters.properties.value.type = "boolean";
    await boundA.invoke("Still original");
    await boundB.invoke("Still number");
    const definitions = requests.map((r) => lite ? r.input[0].tools[0].tools : r.tools);
    assert.deepEqual(definitions.map((d) => d[0].parameters.properties.value.type), ["string", "number", "string", "number", "string", "number"]);
    assert.deepEqual(definitions.map((d) => d[0].description), ["Original description", "Updated description", "Original description", "Updated description", "Original description", "Updated description"]);
    assert(definitions.every((d) => d[0].strict === false));
    assert.equal(new Set(definitions.map((d) => d[0].name)).size, 1);
    assert.equal(requests.length, 6);
    // The router shares the same binding boundary without resolving accounts or making requests.
    const routed = CodexAccountRouterModel.prototype.bindTools.call({ withConfig: (v) => v }, tools);
    tools[0].function.parameters.required.push("changed");
    assert.deepEqual(routed.tools[0].function.parameters.required, ["value"]);
    assert(Object.isFrozen(routed.tools[0].function.parameters.properties.value));
  }
});

test("Canonical base64 matches the roundtrip oracle for every one/two-byte payload and every unused tail bit", () => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (const length of [1, 2]) {
    const bytes = Buffer.alloc(length);
    for (let value = 0; value < (length === 1 ? 256 : 65536); value++) {
      if (length === 1) bytes[0] = value;
      else bytes.writeUInt16BE(value);
      const canonical = bytes.toString("base64");
      assert(strictBase64(canonical, length).equals(bytes));
      const index = length === 1 ? 1 : 2;
      const symbol = alphabet.indexOf(canonical[index]);
      for (let padBits = 1; padBits < (length === 1 ? 16 : 4); padBits++) {
        const changed = canonical.slice(0, index) + alphabet[symbol | padBits] + canonical.slice(index + 1);
        assert.equal(Buffer.from(changed, "base64").toString("base64"), canonical);
        assert.throws(() => strictBase64(changed, length), /base64/);
      }
    }
  }
});

test("Raster signature inspection respects offset/length and never mutates the supplied view", () => {
  const signatures = [
    [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), "image/png"],
    [Buffer.from([255, 216, 255]), "image/jpeg"],
    [Buffer.from("RIFFxxxxWEBP"), "image/webp"],
    [Buffer.from("GIF89a"), "image/gif"],
  ];
  for (const [signature, expected] of signatures) {
    const backing = Buffer.alloc(signature.length + 23, 0x61);
    signature.copy(backing, 7);
    const before = Buffer.from(backing);
    const view = new Uint8Array(backing.buffer, backing.byteOffset + 7, signature.length);
    assert.equal(imageMime(view), expected);
    assert.deepEqual(backing, before);
    assert.throws(() => imageMime(view.subarray(0, signature.length - 1)), /signature/);
  }
});

test("Selected catalog snapshots preserve coalescing, generation isolation, refresh removal and cancelled waiters", async () => {
  let resolve, reads = 0, removed = false;
  const catalog = new ModelCatalog(async () => {
    reads++;
    await new Promise((r) => { resolve = r; });
    return Response.json({ models: [rawModel({ slug: removed ? "replacement" : "selected" }), rawModel({ slug: "other" })] });
  });
  const c = new AbortController(), s = session();
  const cancelled = catalog.model(s, "selected", c.signal);
  const retained = catalog.model(s, "selected");
  c.abort();
  await assert.rejects(cancelled, /cancelled/);
  resolve();
  const first = await retained;
  first.reasoningEfforts.length = 0;
  assert.deepEqual((await catalog.model(s, "selected")).reasoningEfforts, ["low", "high"]);
  assert.equal(reads, 1);
  const generation = catalog.model({ ...s, generation: 2 }, "selected");
  resolve(); await generation;
  assert.equal(reads, 2);
  removed = true;
  const fresh = catalog.list(s, undefined, true);
  resolve(); await fresh;
  await assert.rejects(catalog.model(s, "selected"), /not in this account catalog/);
  assert.equal(reads, 3);
});
