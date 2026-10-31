# Installation

Install version 0.1.0 from the n8n community panel, npm, or the matching release tarball. For standalone Agents and shared account ownership, see [the gateway guide](gateway.md). Existing embedded workflows keep their node IDs and credentials. Verify the release checksums before using offline artifacts.

One npm package installs all four Codex Wire nodes and the shared **Codex Account** credential. Use a trusted self-hosted n8n instance. This independent, experimental integration is not a verified community node and does not provide n8n Cloud support.

The pinned stack is n8n `2.45.6`, n8n-workflow `2.45.3`, LangChain Core `1.2.8` and Node.js `26.12.1`. One execution process is supported; queue/multiworker mode is outside this release.

## Install from the n8n panel

1. Sign in as an Owner or Admin and open **Settings → Community Nodes**.
2. Choose **Install** and enter `n8n-nodes-codex-chat@0.1.0`.
3. Acknowledge the community-code notice and install.

**Codex Chat Model**, **Codex Account**, **Codex Account Router** and **Codex Image** appear together. Community packages must be enabled, unverified packages allowed, and package loading not prevented by server configuration. See [n8n's installation guide](https://docs.n8n.io/integrations/community-nodes/installation-and-management/gui-installation.md) and [package settings](https://docs.n8n.io/hosting/configuration/environment-variables/nodes.md).

Installation and account authorization are separate steps. Configure private account storage before linking an account or executing a model node.

## Manual npm installation

Run this as the n8n service user, inside its container or deployment environment. Use the actual community directory if your instance changes the default n8n user folder.

```sh
mkdir -p ~/.n8n/nodes
cd ~/.n8n/nodes
npm install --omit=dev --legacy-peer-deps --ignore-scripts \
  --no-audit --no-fund n8n-nodes-codex-chat@0.1.0
```

Restart n8n afterward. For an offline installation, replace the package name with an explicit local path to `n8n-nodes-codex-chat-0.1.0.tgz`. This follows [n8n's manual installation layout](https://docs.n8n.io/integrations/community-nodes/installation-and-management/manual-installation.md).

The plugin resolves the host's exact `@langchain/core` and `n8n-workflow` objects. The pinned n8n loader supplies host search paths through `NODE_PATH`. Do not install a second LangChain copy to silence a peer warning. Other layouts need a compatibility check.

## Configure account storage

The following examples use the official Linux n8n container, its persistent `/home/node/.n8n` directory, and a Compose service named `n8n`. Keep your existing service name, mounts and other settings when adapting them.

Invoke the installed account helper directly:

```sh
docker compose exec n8n \
  node /home/node/.n8n/nodes/node_modules/n8n-nodes-codex-chat/dist/cli.js --help
```

n8n's registry installer disables executable links, so a command shim is not assumed. Read-only status can run alongside n8n. Embedded device login, import, reconnect and recovery require the sole workflow owner to be stopped; a second helper cannot acquire its store lock.

### Create a key for a new store

**Skip key generation when upgrading an existing store. Reuse its key.** This sequence refuses an existing host key file, creates a temporary key inside the container and copies it into a private host directory. It never prints the key.

```sh
(
  set -eu
  test ! -e secrets/runtime.env
  test ! -L secrets/runtime.env
  test ! -L secrets
  mkdir -p secrets
  chmod 0700 secrets

  docker compose exec n8n sh -c \
    'umask 077; mkdir -p /tmp/codex-wire-key'
  docker compose exec n8n \
    node /home/node/.n8n/nodes/node_modules/n8n-nodes-codex-chat/dist/cli.js \
    keygen --output /tmp/codex-wire-key/runtime.env
  docker compose cp n8n:/tmp/codex-wire-key/runtime.env ./secrets/runtime.env
  chmod 0600 secrets/runtime.env
)
```

The helper also refuses an existing temporary output. Keep the host key outside the profile store and version control. Protect n8n's own encryption configuration separately.

### Set the runtime environment

Merge this into your existing service, retaining its current volumes and environment files:

```yaml
services:
  n8n:
    env_file:
      - ./secrets/runtime.env
    environment:
      N8N_CODEX_STORE_DIR: /home/node/.n8n/codex-wire/profiles
```

```sh
docker compose up -d n8n
```

`N8N_CODEX_STORE_KEY` is a base64-encoded 32-byte key. `N8N_CODEX_STORE_DIR` must be a private writable directory on persistent storage. The example keeps profiles and bindings in n8n's data volume while the key stays in the host secret file. Never store the master key inside the profile directory or dump the resolved environment into logs.

## Link an account

For embedded mode, use a maintenance window. Pause triggers and new workflow admissions, wait for active executions to settle, and retain the current immutable image ID/package version. Keep the Compose service image pinned and unchanged throughout this sequence. The account helper must inherit the same service user, installed community directory, persistent volume and protected environment/key. Do not use a fresh container with an empty volume or a different package version.

```sh
# Create only the binding directory while the service is available.
docker compose exec n8n sh -c \
  'umask 077; mkdir -p /home/node/.n8n/codex-wire/bindings'
# After active executions have drained, stop the sole owner.
docker compose stop -t 120 n8n
# Compose inherits the same image, service user, mounts and protected environment.
docker compose run --rm --no-deps --pull never --entrypoint node n8n \
  /home/node/.n8n/nodes/node_modules/n8n-nodes-codex-chat/dist/cli.js \
  device-login --offline --label 'Automation' \
  --binding-output /home/node/.n8n/codex-wire/bindings/automation.json
# Restart after successful helper completion and verify local status.
docker compose up -d --no-deps n8n
docker compose exec n8n \
  node /home/node/.n8n/nodes/node_modules/n8n-nodes-codex-chat/dist/cli.js \
  status --binding /home/node/.n8n/codex-wire/bindings/automation.json
```

Follow the terminal's login link and one-time code. Device login must be enabled where required by [Codex authentication settings](https://learn.chatgpt.com/docs/auth). If the helper reports an owner fence, stop and inspect all possible store users; never delete a lock because of its age. A forced process stop can leave a deliberate fence. Preserve the store and any delivered binding when an operation fails; use the recovery procedure below instead of repeating an uncertain token renewal. Resume workflow admissions after local status and a harmless workflow succeed.

Copy the binding from the persistent service volume into your existing private host directory:

```sh
docker compose cp \
  n8n:/home/node/.n8n/codex-wire/bindings/automation.json ./secrets/automation.json
chmod 0600 secrets/automation.json
```

Open it locally and enter `profileId` and `bindingSecret` in an n8n **Codex Account** credential. Tokens never enter workflow fields. The helper writes and syncs the complete binding before activation; an interrupted initial import may need that binding for recovery.

For gateway mode, use the protected console or `--online` with `N8N_CODEX_ADMIN_URL` and `N8N_CODEX_ADMIN_TOKEN_FILE`. These operations run through the existing gateway owner. Do not mount its profile store or key into n8n or a second helper.

### Manual import and reconnect

During the same stopped-owner maintenance window, the same one-off helper accepts `import --format token-set|codex-auth-json --input <protected-file|-> --label <name> --binding-output <new-file>`. Input files must be readable inside the container. Stdin avoids copying them into an image. Never put tokens in command-line arguments.

Use the same one-off service command with `device-login --offline --label 'Automation' --reconnect /home/node/.n8n/codex-wire/bindings/automation.json` to preserve profile identity and binding. The helper does not discover a home-directory login, modify a source auth file or import Platform API keys. A refresh token alone is insufficient.

The encrypted store-wide journal owns each exact rotating token across manual, device and prepared imports, reconnects and renewals. Independent login families for the same verified account are legal and share account admission limits. A renewable profile must exclusively own its rotating refresh token. Do not import a session another client will continue renewing. For access-only profiles, omit renewable material and reconnect when the current token expires.

`status --binding <file>` and `doctor --binding <file>` are local and never renew. Credential Test and Check Account are local as well. Network actions, model pickers and inference follow normal managed renewal. `N8N_CODEX_REFRESH_ENABLED=false` disables renewal. Public [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) uses a different registration, consent and API contract; its tokens are not interchangeable here.

### Recover a captured successful renewal

After draining and stopping the embedded owner, run the same one-off helper with `recover --offline --binding <protected-binding-file>`. Recovery verifies the captured replacement's identity and commits it locally; it never sends another refresh POST. Public identity-verification keys may need to be fetched. A successful verified response that omitted a refresh token, or explicitly returned the same one, advances a new same-owner renewal epoch only after the durable commit.

A lost response, failed capture, malformed response, identity mismatch or conflicting profile cannot be guessed or replayed. Preserve the encrypted journal and use an independent login when recovery cannot prove the replacement. Manual import never writes back to the source auth file. See [upgrade and rollback](upgrade.md) before moving the store.

## Build from source

Use Node.js `26.12.1` and Docker with Compose. From a checkout:

```sh
CODEX_RELEASE_SECURITY_BUNDLE=/absolute/prepared-build/security \
  CODEX_RELEASE_DOCKER=direct npm run release:local
```

This command builds the **legacy CUSTOM embedded image** from the root `Dockerfile.n8n`, conventionally tagged `codex-wire-n8n:0.1.0`. It contains the four native nodes and security layer. Its release manifest identifies `legacy-custom-embedded`; it does not install the 17-file standalone Agents lifecycle overlay. Use the separately built companion below for an Agents account pool.

First prepare the exact source/dependency/security bundle with the [bounded companion build](gateway.md#reproducible-companion-assembly). `CODEX_RELEASE_SECURITY_BUNDLE` is mandatory: the release command verifies its source hashes, lock, compiled outputs and signed OS inputs before Docker work. The build installs pinned dependencies inside Docker, runs tests and native smoke checks, writes artifacts and checks startup on empty volumes. Without `CODEX_RELEASE_DOCKER=direct`, it uses `sudo -n docker`. It does not publish or update an existing deployment. A different image already using a public release tag is preserved.

To load an existing platform-specific image archive (Linux amd64 is the verified target):

```sh
(cd artifacts && sha256sum --check SHA256SUMS)
docker load --input artifacts/codex-wire-n8n-0.1.0.tar
```

The source-built image already includes the package and uses this helper location:

```text
/opt/n8n-codex/node_modules/.bin/n8n-codex-account
```

For a new bundled-image installation, provision the key through a narrow writable secrets-directory mount, then start the supplied Compose:

```sh
mkdir -p secrets
chmod 0700 secrets
docker run --rm --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$PWD/secrets,dst=/run/codex-secrets" \
  --entrypoint /opt/n8n-codex/node_modules/.bin/n8n-codex-account \
  codex-wire-n8n:0.1.0 \
  keygen --output /run/codex-secrets/runtime.env
docker compose -f compose.portable.yaml up -d
```

That image stores profiles at `/var/lib/n8n-codex/profiles` and bindings under `/var/lib/n8n-codex/bindings`; adapt account-login commands to those paths. For existing data, follow [upgrade and rollback](upgrade.md) and reuse the original key, bindings and volumes.

The **matched Agents companion** comes from `integration/qualification/Dockerfile.n8n` (emitted as `n8n.Dockerfile` by the bounded build). It includes the lifecycle and security overlays, keeps `N8N_CUSTOM_EXTENSIONS` empty, and initially loads no Codex community nodes. Install the same tarball through the community loader to add the four native nodes with the npm namespace. Its installed helper is then under the actual n8n community directory, normally `/home/node/.n8n/nodes/node_modules/n8n-nodes-codex-chat/dist/cli.js`; `/opt/n8n-codex/node_modules/.bin/n8n-codex-account` belongs to the legacy embedded image. Use the exact companion image ID and variant in its release receipt; an image tag alone does not establish which recipe it contains.

## Namespaces

Examples use `n8n-nodes-codex-chat.<node-name>` for npm installations, including community installation on the matched Agents companion, and can be imported directly after assigning credentials. The legacy CUSTOM embedded image uses `CUSTOM.<node-name>`. Existing workflow types never change automatically.

To use an example with the custom image, convert it from a source checkout:

```sh
mkdir -p artifacts
node examples/convert-namespaces.cjs \
  examples/basic-chat.json artifacts/basic-chat-custom.json custom
```

The converter changes only the four exact Codex Wire type identifiers, including nested examples, and refuses to overwrite its input. Do not bulk-convert existing workflows. The image example's optional Workflow Tool returns metadata; its Webhook branch delivers image bytes.

By [wufflyne](https://wufflyne.com).
