#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 4 ]]; then
  echo "Usage: create-site.sh <slug> <runtime: php|node|python|static|html> <repo-url> <branch> [build-command] [start-command]" >&2
  exit 1
fi

SLUG="$1"
RUNTIME="$2"
REPO_URL="$3"
BRANCH="$4"
BUILD_COMMAND="${5:-}"
START_COMMAND="${6:-}"
HOSTING_ROOT="${HOSTING_ROOT:-/srv/hosting}"
SITE_DIR="${HOSTING_ROOT}/sites/${SLUG}"
TEMPLATE_DIR="${HOSTING_ROOT}/templates/${RUNTIME}"

if [[ ! "${SLUG}" =~ ^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$ ]]; then
  echo "Invalid slug. Use lowercase letters, numbers, and hyphens." >&2
  exit 1
fi

if [[ ! -d "${TEMPLATE_DIR}" ]]; then
  echo "Unknown runtime template: ${RUNTIME}" >&2
  exit 1
fi

install -d "${SITE_DIR}/releases" "${SITE_DIR}/shared"
cp -n "${TEMPLATE_DIR}/Dockerfile" "${SITE_DIR}/Dockerfile"
cp -n "${TEMPLATE_DIR}/compose.yaml" "${SITE_DIR}/compose.yaml"

if [[ ! -f "${SITE_DIR}/site.env" ]]; then
  cat >"${SITE_DIR}/site.env" <<EOF_SITE_ENV
SITE_SLUG=${SLUG}
RUNTIME=${RUNTIME}
REPO_URL=${REPO_URL}
BRANCH=${BRANCH}
BUILD_COMMAND=${BUILD_COMMAND}
START_COMMAND=${START_COMMAND}
SERVICE_PORT=8080
EOF_SITE_ENV
fi

if [[ ! -f "${SITE_DIR}/.env" ]]; then
  cat >"${SITE_DIR}/.env" <<EOF_APP_ENV
# Runtime environment for ${SLUG}; consumed by the site container.
NODE_ENV=production
PYTHONUNBUFFERED=1
EOF_APP_ENV
fi

echo "Created ${SITE_DIR}. Edit site.env and .env before first deploy if needed."
