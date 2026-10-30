<h1 align="center">Codex Wire for n8n</h1>

<p align="center">Codex subscription accounts for native n8n workflows and standalone Agents.</p>
<p align="center"><strong>v0.0.5</strong> · Self-hosted · Four nodes + explicit gateway · MIT</p>

Codex Wire connects an independently linked Codex account to n8n's AI Agent, tools, memory and parsers. Model requests go directly over HTTP; n8n owns workflow execution and tool calls. There is no embedded Codex CLI agent or Platform API-key fallback.

This is an independent, experimental integration with the private Codex backend. Models, capabilities and allowance depend on your account. Install all four nodes from the single [`n8n-nodes-codex-chat`](https://www.npmjs.com/package/n8n-nodes-codex-chat) npm package.

## Standalone Agents and shared account ownership

The optional gateway provides a protected four-view account console, device/manual onboarding, scoped connection keys, bounded Responses streaming and a full account pool. Native workflows and standalone Agents use the same sole account owner. The pool requires the included matched n8n lifecycle integration; stock n8n supports a fixed-account connection. See [gateway setup, privacy and recovery](docs/gateway.md).

The local release includes a single npm tarball and matched gateway/n8n images. [Qualification coverage](docs/qualification.md) and [compatibility metadata](compatibility.json) distinguish synthetic installation tests from historical 0.0.4 live observations. Public publication and production deployment are separate operator steps.

## Four focused nodes

| Node | Use it for |
| --- | --- |
| **Codex Chat Model** | Native AI workflows with tools, streaming, structured output and supported photo inputs. |
| **Codex Account** | Local account status, available models, quota windows, reset allocations and actual execution usage. |
| **Codex Account Router** | An ordered chain of 2–5 accounts for the first request of a fresh Agent invocation. The admitted account stays fixed through all tool turns. |
| **Codex Image** | The account's source-pinned `gpt-image-2` generation action, returned as native n8n binary data. |

Start with one account and **Codex Chat Model**. Reasoning, speed, output, reliability, prompt affinity and account recovery are optional controls. Defaults preserve the chosen model and its settings; automatic reset is off.

## Quick start

Use a compatible **self-hosted n8n** instance and a Codex account you control. The verified versions are listed below. Account storage and its encryption key are configured once on the server; model selection and workflow execution stay in n8n.

### 1. Install the package

As an n8n Owner or Admin, open **Settings → Community Nodes → Install** and enter:

```text
n8n-nodes-codex-chat@0.0.5
```

Until publication, use the reviewed local tarball and the manual installation procedure. After publication, acknowledge n8n's community-code notice and install. **Codex Chat Model**, **Codex Account**, **Codex Account Router** and **Codex Image** appear together. Community and unverified packages must be enabled on the instance.

For a terminal-based installation, use the [npm installation guide](docs/install.md#manual-npm-installation). A standalone Docker build remains available under [build from source](docs/install.md#build-from-source).

### 2. Configure account storage

Follow [server setup](docs/install.md#configure-account-storage) to provision `N8N_CODEX_STORE_DIR` and a private `N8N_CODEX_STORE_KEY`, then restart n8n with the same persistent data volume. Keep the key separate from the profile store. **Reuse existing keys and bindings when upgrading.**

### 3. Link your account

These commands use the official n8n container's default community-package directory and a Compose service named `n8n`; adjust them for your deployment:

```sh
docker compose exec n8n sh -c \
  'umask 077; mkdir -p /home/node/.n8n/codex-wire/bindings'

docker compose exec n8n \
  node /home/node/.n8n/nodes/node_modules/n8n-nodes-codex-chat/dist/cli.js \
  device-login --label 'Automation' \
  --binding-output /home/node/.n8n/codex-wire/bindings/automation.json
```

Follow the login link and one-time code in your terminal. [Copy the protected binding](docs/install.md#link-an-account) and enter its `profileId` and `bindingSecret` in an n8n **Codex Account** credential. A renewable profile must exclusively own its rotating refresh token; use a separate login for this automation.

The helper also supports [manual import and reconnecting](docs/install.md#manual-import-and-reconnect). The npm installation path uses `node …/dist/cli.js`; the bundled Docker image has its own helper path.

### 4. Connect a native AI Agent

Add **AI Agent**, attach **Codex Chat Model** to its **Chat Model** input, select your credential and choose an available model. Add ordinary n8n tools or a parser as needed. You can also import [Basic Chat](examples/basic-chat.json), assign the credential and select your model.

The model list is account-specific and cached for up to five minutes. **Codex Account → Get Models** refreshes it. New catalog model IDs appear when they use a supported protocol; existing workflows keep their selected model.

## Start from an example

| Workflow | What it shows |
| --- | --- |
| [Basic Chat](examples/basic-chat.json) | One account and a native AI Agent. |
| [Tools and Structured Output](examples/tools-and-structured-output.json) | Deterministic native work, tool results and a structured parser. |
| [Account Selection with Simple Memory](examples/account-selection-with-simple-memory.json) | Choose an account before the Agent and scope memory to that account. |
| [Fresh Agent with Account Router](examples/fresh-agent-account-router.json) | Ordered accounts, safe initial quota recovery and sticky tool turns. |
| [Generate Image to Native Binary](examples/generate-image-native-binary.json) | Native binary output and an HTTP delivery branch. |

Examples use the npm community-package namespace and can be imported directly after installation. Assign credentials before running them. For the bundled Docker image, use the [namespace converter](docs/install.md#namespaces) first. The image example's Workflow Tool returns metadata; its Webhook branch delivers image bytes.

## Behavior you can rely on

- **n8n owns the workflow.** Tools, parsing and memory remain native. Each model invocation performs one generation; native parser repair may make additional calls.
- **Settings are explicit.** Provider Default (No Override) omits a setting. Advertised defaults are shown separately. No hidden model, reasoning, verbosity or image-quality downgrade occurs.
- **Recovery has a clear boundary.** The Router can move to another account only before admission, after an initial HTTP 429 and a fresh authenticated quota check. Every HTTP 2xx pins the account, including an empty or failed stream. Memory and native Agent Fallback are unsupported on the Router path.
- **Reset use is opt-in.** Manual use requires an eligible earned allocation and acknowledgement. Optional automatic reset uses finite caps and durable uncertainty fences. It never buys credits or changes billing settings.
- **Usage stays honest.** Execution reports show actual reported counts and coverage. Missing data remains unknown. Prompt affinity does not promise cache hits or token savings.

[Model behavior](docs/models.md) · [Account recovery](docs/account-recovery.md) · [Token guidance](docs/token-efficiency.md)

## Compatibility

| Component | Tested version |
| --- | --- |
| n8n | `2.45.6` |
| n8n-workflow | `2.45.3` |
| LangChain Core | `1.2.8` |
| Node.js | `26.12.1` |
| Codex client contract | `0.166.0` — [`55c099a`](https://github.com/openai/codex/tree/55c099a142eb302188fee00ab9e9062f2db1c359) |

Embedded mode supports one trusted self-hosted execution process; gateway mode gives n8n no OAuth/store access and centralizes ownership. The matched standalone Agents integration preserves operation identity through approval/checkpoint restart. Native workflow continuation after a process restart, queue/multiworker mode, direct PDF/audio/video input, embeddings and hosted provider tools are outside this release. New protocol types require an adapter update. The backend can change independently of this package.

[Compatibility metadata](compatibility.json) separates synthetic/native tests from limited live evidence. All 0.0.5 real-account activity remains unqualified; historical baseline live observations do not qualify changed 0.0.5 bytes. Community loading uses the pinned host dependency resolution. The installation guide covers the required server configuration and helper path. No n8n Cloud support or official OpenAI/n8n affiliation is claimed.

## Development

For local TypeScript work, use the pinned Node version:

```sh
npm ci --ignore-scripts --no-audit --no-fund --cache .npm-cache
npm ci --prefix integration/consumer --ignore-scripts --no-audit --no-fund --cache "$PWD/.npm-cache"
CODEX_WIRE_SDK_ROOT="$PWD/integration/consumer/node_modules" npm run check
npm run typecheck
```

The source tree keeps protocol, authentication, account recovery and native adapters in separate modules. Tests use synthetic providers. The [development guide](docs/development.md) covers module boundaries, extension rules and local release tooling; [installation](docs/install.md) covers runtime setup and community packaging.

[MIT license](LICENSE) · By [wufflyne](https://wufflyne.com).
