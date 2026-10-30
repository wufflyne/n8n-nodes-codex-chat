# Installation

One npm package installs all four Codex Wire nodes and the shared **Codex Account** credential. Use a trusted self-hosted n8n instance. This independent, experimental integration is not a verified community node and does not provide n8n Cloud support.

The verified stack is n8n `2.45.6`, n8n-workflow `2.45.3`, LangChain Core `1.2.8` and Node.js `26.12.1`. One execution process is supported; queue/multiworker mode is outside this release.

## Install from the n8n panel

1. Sign in as an Owner or Admin and open **Settings → Community Nodes**.
2. Choose **Install** and enter `n8n-nodes-codex-chat@0.0.4`.
3. Acknowledge the community-code notice and install.

**Codex Chat Model**, **Codex Account**, **Codex Account Router** and **Codex Image** appear together. Community packages must be enabled, unverified packages allowed, and package loading not prevented by server configuration. See [n8n's installation guide](https://docs.n8n.io/integrations/community-nodes/installation-and-management/gui-installation.md) and [package settings](https://docs.n8n.io/hosting/configuration/environment-variables/nodes.md).

Installation and account authorization are separate steps. Configure private account storage before linking an account or executing a model node.

## Manual npm installation

Run this as the n8n service user, inside its container or deployment environment. Use the actual community directory if your instance changes the default n8n user folder.

```sh
mkdir -p ~/.n8n/nodes
cd ~/.n8n/nodes
npm install --omit=dev --legacy-peer-deps --ignore-scripts \
  --no-audit --no-fund n8n-nodes-codex-chat@0.0.4
```

Restart n8n afterward. For an offline installation, replace the package name with an explicit local path to `n8n-nodes-codex-chat-0.0.4.tgz`. This follows [n8n's manual installation layout](https://docs.n8n.io/integrations/community-nodes/installation-and-management/manual-installation.md).

The plugin resolves the host's exact `@langchain/core` and `n8n-workflow` objects. The pinned n8n loader supplies host search paths through `NODE_PATH`. Do not install a second LangChain copy to silence a peer warning. Other layouts need a compatibility check.

## Configure account storage

The following examples use the official Linux n8n container, its persistent `/home/node/.n8n` directory, and a Compose service named `n8n`. Keep your existing service name, mounts and other settings when adapting them.

Invoke the installed account helper directly:

```sh
docker compose exec n8n \
  node /home/node/.n8n/nodes/node_modules/n8n-nodes-codex-chat/dist/cli.js --help
```

n8n's registry installer disables executable links, so a command shim is not assumed. The helper works independently of the running workflow process.

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

```sh
docker compose exec n8n sh -c \
  'umask 077; mkdir -p /home/node/.n8n/codex-wire/bindings'
docker compose exec n8n \
  node /home/node/.n8n/nodes/node_modules/n8n-nodes-codex-chat/dist/cli.js \
  device-login --label 'Automation' \
  --binding-output /home/node/.n8n/codex-wire/bindings/automation.json
```

Follow the terminal's login link and one-time code. Device login must be enabled where required by [Codex authentication settings](https://learn.chatgpt.com/docs/auth). Availability is controlled by the provider.

Copy the protected binding into the private host directory:

```sh
docker compose cp \
  n8n:/home/node/.n8n/codex-wire/bindings/automation.json ./secrets/automation.json
chmod 0600 secrets/automation.json
```

Open the file locally and enter its `profileId` and `bindingSecret` into an n8n **Codex Account** credential. Keep the binding private. Tokens are not entered into workflow fields. The complete binding is written and synced before profile activation.

### Manual import and reconnect

The same helper accepts `import --format token-set|codex-auth-json --input <protected-file|-> --label <name> --binding-output <new-file>`. Input files must be readable inside the container. Stdin avoids copying them into an image. Never put tokens in command-line arguments.

Use `device-login --label 'Automation' --reconnect /home/node/.n8n/codex-wire/bindings/automation.json` to preserve profile identity and binding. The helper does not discover a home-directory login, modify a source auth file or import Platform API keys. A refresh token alone is insufficient.

A renewable profile must exclusively own its rotating refresh token. Do not import a session another client will continue renewing. For access-only profiles, omit renewable material and reconnect when the current token expires.

`status --binding <file>` and `doctor --binding <file>` are local and never renew. Credential Test and Check Account are local as well. Network actions, model pickers and inference follow normal managed renewal. `N8N_CODEX_REFRESH_ENABLED=false` disables renewal. Public [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) uses a different registration, consent and API contract; its tokens are not interchangeable here.

## Build from source

Use Node.js `26.12.1` and Docker with Compose. From a checkout:

```sh
CODEX_RELEASE_DOCKER=direct npm run release:local
```

The build installs pinned dependencies inside Docker, runs tests and native smoke checks, writes artifacts and checks startup on empty volumes. Without `CODEX_RELEASE_DOCKER=direct`, it uses `sudo -n docker`. It does not publish or update an existing deployment. A different image already using a public release tag is preserved.

To load an existing platform-specific image archive (Linux amd64 is the verified target):

```sh
(cd artifacts && sha256sum --check SHA256SUMS)
docker load --input artifacts/codex-wire-n8n-0.0.4.tar
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
  codex-wire-v0-0-4-n8n:0.0.4 \
  keygen --output /run/codex-secrets/runtime.env
docker compose -f compose.portable.yaml up -d
```

That image stores profiles at `/var/lib/n8n-codex/profiles` and bindings under `/var/lib/n8n-codex/bindings`; adapt account-login commands to those paths. For existing data, follow [upgrade and rollback](upgrade.md) and reuse the original key, bindings and volumes.

## Namespaces

Examples use `n8n-nodes-codex-chat.<node-name>` for npm installations and can be imported directly after assigning credentials. The custom image uses `CUSTOM.<node-name>`. Existing workflow types never change automatically.

To use an example with the custom image, convert it from a source checkout:

```sh
mkdir -p artifacts
node examples/convert-namespaces.cjs \
  examples/basic-chat.json artifacts/basic-chat-custom.json custom
```

The converter changes only the four exact Codex Wire type identifiers, including nested examples, and refuses to overwrite its input. Do not bulk-convert existing workflows. The image example's optional Workflow Tool returns metadata; its Webhook branch delivers image bytes.
