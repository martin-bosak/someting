#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: deploy-site.sh <slug>" >&2
  exit 1
fi

SLUG="$1"
HOSTING_ROOT="${HOSTING_ROOT:-/srv/hosting}"
SITE_DIR="${HOSTING_ROOT}/sites/${SLUG}"
SITE_ENV="${SITE_DIR}/site.env"
LOG_FILE="${HOSTING_ROOT}/logs/deploy-${SLUG}.log"

if [[ ! -f "${SITE_ENV}" ]]; then
  echo "Missing ${SITE_ENV}. Create the site first." >&2
  exit 1
fi

# shellcheck disable=SC1090
source "${SITE_ENV}"

: "${REPO_URL:?REPO_URL is required in site.env}"
: "${BRANCH:=main}"
: "${RUNTIME:?RUNTIME is required in site.env}"

mkdir -p "${SITE_DIR}/releases" "${HOSTING_ROOT}/logs"
exec > >(tee -a "${LOG_FILE}") 2>&1

echo "[$(date --iso-8601=seconds)] Deploying ${SLUG} from ${REPO_URL}#${BRANCH}"

RELEASE_ID="$(date +%Y%m%d%H%M%S)"
RELEASE_DIR="${SITE_DIR}/releases/${RELEASE_ID}"
git clone --depth 1 --branch "${BRANCH}" "${REPO_URL}" "${RELEASE_DIR}"

ln -sfn "${RELEASE_DIR}" "${SITE_DIR}/current"

if [[ ! -f "${SITE_DIR}/Dockerfile" || ! -f "${SITE_DIR}/compose.yaml" ]]; then
  cp "${HOSTING_ROOT}/templates/${RUNTIME}/Dockerfile" "${SITE_DIR}/Dockerfile"
  cp "${HOSTING_ROOT}/templates/${RUNTIME}/compose.yaml" "${SITE_DIR}/compose.yaml"
fi

(
  cd "${SITE_DIR}"
  docker compose --env-file "${SITE_ENV}" -p "site-${SLUG}" up -d --build --remove-orphans
)

find "${SITE_DIR}/releases" -mindepth 1 -maxdepth 1 -type d | sort -r | sed -n '6,$p' | xargs -r rm -rf

echo "[$(date --iso-8601=seconds)] Deploy complete for ${SLUG}"
