#!/usr/bin/env bash
set -euo pipefail
: "${QUALIFICATION_ROOT:?Set the approved workspace qualification directory}"
: "${CANDIDATE_ROOT:?Set the approved candidate directory}"
: "${UPSTREAM_ROOT:?Set the patched pinned upstream source directory}"
: "${BUILD_RESOURCE_PREFIX:?Set an operator-approved Docker resource prefix}"
: "${BUILD_CHECKPOINT:?Set a fresh lowercase checkpoint name for this stage}"
[[ "$BUILD_RESOURCE_PREFIX" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]] || exit 1
[[ "$BUILD_CHECKPOINT" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || { printf '%s\n' 'Invalid build checkpoint.' >&2; exit 1; }
[[ "$(id -u)" != 0 ]] || { printf '%s\n' 'Run this script as the workspace user; it invokes sudo only for Docker.' >&2; exit 1; }
mkdir -p "${QUALIFICATION_ROOT}/docker-cli" "${QUALIFICATION_ROOT}/cli-cache"
docker_command=(sudo -n env "DOCKER_CONFIG=${QUALIFICATION_ROOT}/docker-cli" "XDG_CACHE_HOME=${QUALIFICATION_ROOT}/cli-cache" docker)
if [[ "${UNPRIVILEGED_DOCKER:-0}" == 1 ]]; then docker_command=(env "DOCKER_CONFIG=${QUALIFICATION_ROOT}/docker-cli" "XDG_CACHE_HOME=${QUALIFICATION_ROOT}/cli-cache" docker); fi
build_output="${QUALIFICATION_ROOT}/build-output/${BUILD_CHECKPOINT}"
mkdir -p "$build_output" "${QUALIFICATION_ROOT}/npm-cache" "${QUALIFICATION_ROOT}/pnpm-cache"
# Run only after personal host approval and a pre-change host journal entry.
# Dependency resolution and compilation occur inside this explicit cgroup limit.
"${docker_command[@]}" run --name "${BUILD_RESOURCE_PREFIX}-build-${BUILD_CHECKPOINT}" --cpus=2 --memory=4g --memory-swap=4g --pids-limit=256 \
  --user "$(id -u):$(id -g)" --cap-drop=ALL --security-opt=no-new-privileges \
  --mount "type=bind,src=${CANDIDATE_ROOT},dst=/source,readonly" \
  --mount "type=bind,src=${UPSTREAM_ROOT},dst=/upstream,readonly" \
  --mount "type=bind,src=${build_output},dst=/output" \
  --mount "type=bind,src=${QUALIFICATION_ROOT}/npm-cache,dst=/npm-cache" \
  --mount "type=bind,src=${QUALIFICATION_ROOT}/pnpm-cache,dst=/pnpm-cache" \
  --env npm_config_cache=/npm-cache --env NPM_CONFIG_CACHE=/npm-cache --env TMPDIR=/output/tmp \
  --env NODE_OPTIONS=--max-old-space-size=3072 \
  docker.io/library/node:26.12.1-bookworm-slim@sha256:88e480776c6149ff1d098cd304f44bf18057fb5d284a3329b78162d29821e28c \
  node /source/integration/scripts/build-workspace.cjs
# Keep the completed build container and images for audit/rollback until approved cleanup.
