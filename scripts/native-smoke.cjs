// Synthetic-only physical n8n smoke. Run in the pinned runtime image with this project mounted read-only.
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const packageRoot = "/opt/n8n-codex/node_modules/n8n-nodes-codex-chat";
async function main() {
  const { ProfileStore, ISSUER, CODEX_CLIENT_ID, PROVIDER } = require(
      packageRoot,
    ),
    directory = "/tmp/codex-wire-native";
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const profileDir = path.join(directory, "profiles"),
    master = Buffer.alloc(32, 0x6e),
    store = new ProfileStore(profileDir, master),
    credentials = [];
  for (const alias of ["a", "b"]) {
    const binding = {
      profileId: randomUUID(),
      bindingSecret: `SYNTHETIC_NATIVE_BINDING_${alias}`,
    };
    await store.write({
      version: 1,
      provider: PROVIDER,
      id: binding.profileId,
      issuer: ISSUER,
      clientId: CODEX_CLIENT_ID,
      accountId: `synthetic-${alias}`,
      subject: `subject-${alias}`,
      label: `Account ${alias.toUpperCase()}`,
      bindingHash: require("node:crypto")
        .createHash("sha256")
        .update(binding.bindingSecret)
        .digest("hex"),
      generation: 1,
      state: "ready",
      tokens: {
        accessToken: `SYNTHETIC_ACCESS_${alias}`,
        expiresAt: Date.now() + 3600000,
        scopes: [],
      },
      verifiedAt: Date.now(),
    });
    credentials.push({
      id: `syntheticCodex${alias}`,
      name: `Synthetic ${alias.toUpperCase()}`,
      type: "codexAccount",
      data: binding,
    });
  }
  const creds = path.join(directory, "credentials.json");
  await fs.writeFile(creds, JSON.stringify(credentials), { mode: 0o600 });
  const preload = path.join(directory, "provider.cjs"),
    counter = path.join(directory, "counters.json");
  await fs.writeFile(
    preload,
    `const fs=require('node:fs');const file=${JSON.stringify(counter)};const state=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{calls:[],usage:[],rejected:false};const save=()=>fs.writeFileSync(file,JSON.stringify(state));global.fetch=async(url,init={})=>{const u=String(url);if(u.includes('/oauth/')||u.includes('auth.openai.com'))throw Error('No real auth in synthetic smoke');const account=new Headers(init.headers).get('ChatGPT-Account-Id');if(u.includes('/models?'))return Response.json({models:[{slug:'synthetic-model',display_name:'Synthetic',visibility:'list',use_responses_lite:false,input_modalities:['text'],supported_reasoning_levels:[]}]});if(u.endsWith('/wham/usage')){state.usage.push(account);save();return Response.json({account_id:account,plan_type:'plus',rate_limit:{allowed:account!=='synthetic-a'||!state.rejected,limit_reached:account==='synthetic-a'&&state.rejected},rate_limit_reached_type:account==='synthetic-a'&&state.rejected?{type:'rate_limit_reached'}:null});}if(!u.endsWith('/codex/responses'))throw Error('Unexpected synthetic URL');state.calls.push(account);if(account==='synthetic-a'){state.rejected=true;save();return new Response('',{status:429});}save();const r=JSON.parse(init.body),result=r.input.some(i=>i.type==='function_call_output'),out=result?[{type:'message',id:'msg_native',role:'assistant',content:[{type:'output_text',text:'NATIVE_ROUTER_OK'}]}]:[{type:'function_call',id:'fc_native',call_id:'call_native',name:'safe_tool',arguments:'{}'}];return new Response('data: '+JSON.stringify({type:'response.completed',response:{id:'resp_'+state.calls.length,status:'completed',output:out,usage:{input_tokens:10,output_tokens:2,total_tokens:12}}})+'\\n\\n');};`,
    { mode: 0o600 },
  );
  const model = (alias, x) => ({
    id: `model-${alias}`,
    name: `Account ${alias.toUpperCase()}`,
    type: "CUSTOM.codexChatModel",
    typeVersion: 1,
    position: [x, 300],
    parameters: {
      model: { mode: "id", value: "synthetic-model" },
      reliability: { maxRetries: 0 },
    },
    credentials: {
      codexAccount: {
        id: `syntheticCodex${alias}`,
        name: `Synthetic ${alias.toUpperCase()}`,
      },
    },
  });
  const workflow = {
    id: "codexWireNativeRouter",
    name: "Codex Wire Native Router Smoke",
    active: false,
    nodes: [
      {
        id: "trigger",
        name: "Manual Trigger",
        type: "n8n-nodes-base.manualTrigger",
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
      {
        id: "agent",
        name: "AI Agent",
        type: "@n8n/n8n-nodes-langchain.agent",
        typeVersion: 3,
        position: [400, 0],
        parameters: {
          promptType: "define",
          text: "Use safe_tool once, then answer.",
          options: { maxIterations: 3 },
        },
      },
      {
        id: "router",
        name: "Account Router",
        type: "CUSTOM.codexAccountRouter",
        typeVersion: 1,
        position: [400, 200],
        parameters: {
          numberAccounts: 2,
          consumerAgent: "AI Agent",
          unknownLimits: "try",
        },
      },
      model("a", 200),
      model("b", 500),
      {
        id: "tool",
        name: "safe_tool",
        type: "@n8n/n8n-nodes-langchain.toolCode",
        typeVersion: 1.3,
        position: [700, 200],
        parameters: {
          description: "Return one harmless marker.",
          specifyInputSchema: true,
          schemaType: "manual",
          inputSchema: '{"type":"object","properties":{}}',
          jsCode: "return 'SAFE_TOOL_OK';",
        },
      },
    ],
    connections: {
      "Manual Trigger": {
        main: [[{ node: "AI Agent", type: "main", index: 0 }]],
      },
      "Account Router": {
        ai_languageModel: [
          [{ node: "AI Agent", type: "ai_languageModel", index: 0 }],
        ],
      },
      "Account A": {
        ai_languageModel: [
          [{ node: "Account Router", type: "ai_languageModel", index: 0 }],
        ],
      },
      "Account B": {
        ai_languageModel: [
          [{ node: "Account Router", type: "ai_languageModel", index: 1 }],
        ],
      },
      safe_tool: {
        ai_tool: [[{ node: "AI Agent", type: "ai_tool", index: 0 }]],
      },
    },
    settings: { executionOrder: "v1" },
  };
  const file = path.join(directory, "workflow.json");
  await fs.writeFile(file, JSON.stringify(workflow));
  const env = {
    ...process.env,
    N8N_USER_FOLDER: path.join(directory, "state"),
    N8N_CODEX_STORE_DIR: profileDir,
    N8N_CODEX_STORE_KEY: master.toString("base64"),
    N8N_CODEX_REFRESH_ENABLED: "false",
    N8N_DIAGNOSTICS_ENABLED: "false",
    N8N_VERSION_NOTIFICATIONS_ENABLED: "false",
    N8N_RUNNERS_ENABLED: "false",
    NODE_OPTIONS: `--require=${preload}`,
  };
  let step = "credentials";
  const run = (args) => {
    const result = spawnSync("n8n", args, {
      env,
      encoding: "utf8",
      timeout: 90000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.status !== 0) {
      const messages = [
        "The declared consumer must directly connect",
        "Disable native Agent Fallback",
        "requires a fresh Agent",
        "Public n8n execution identity",
        "No configured account",
        "user prefix changed",
        "Provider replay metadata",
        "one fresh Agent invocation",
        "must represent distinct",
        "unknown outcome",
        "Unexpected synthetic",
      ];
      const combined = (result.stdout ?? "") + (result.stderr ?? "");
      const category = messages.findIndex((m) => combined.includes(m));
      throw Object.assign(Error("Native smoke step failed"), {
        step,
        category,
        exitStatus: result.status,
      });
    }
    return result.stdout;
  };
  run(["import:credentials", "--input", creds]);
  step = "workflow";
  run(["import:workflow", "--input", file]);
  step = "execute";
  const out = run(["execute", "--id", workflow.id, "--rawOutput"]);
  const counts = JSON.parse(await fs.readFile(counter, "utf8"));
  if (
    JSON.stringify(counts.calls) !==
      JSON.stringify(["synthetic-a", "synthetic-b", "synthetic-b"]) ||
    !out.includes("NATIVE_ROUTER_OK")
  )
    throw Object.assign(Error("Native smoke counters failed"), {
      step: "counters",
      category: -1,
    });
  process.stdout.write(
    JSON.stringify({
      fixture: "native-router-public-apis",
      status: "passed",
      n8n: "2.45.6",
      agentVersion: 3,
      codeToolVersion: 1.3,
      accountOrder: ["a", "b", "b"],
      toolTurns: 1,
      realAccountAccess: false,
    }) + "\n",
  );
}
main().catch((error) => {
  process.stdout.write(
    JSON.stringify({
      fixture: "native-router-public-apis",
      status: "failed",
      step: error.step ?? "setup",
      category: error.category ?? -1,
      exitStatus: error.exitStatus ?? null,
    }) + "\n",
  );
  process.exitCode = 1;
});
