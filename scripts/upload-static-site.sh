#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: upload-static-site.sh <slug> <archive.tar.gz> [display-name]" >&2
  exit 1
fi

SLUG="$1"
ARCHIVE="$2"
NAME="${3:-$1}"
HOSTING_ROOT="${HOSTING_ROOT:-/srv/hosting}"
PLATFORM_DIR="${PLATFORM_DIR:-/opt/someting}"
SITE_DIR="${HOSTING_ROOT}/sites/${SLUG}"
TEMPLATE_DIR="${HOSTING_ROOT}/templates/html"
LOG_FILE="${HOSTING_ROOT}/logs/upload-${SLUG}.log"

if [[ ! "${SLUG}" =~ ^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$ ]]; then
  echo "Invalid slug. Use lowercase letters, numbers, and hyphens." >&2
  exit 1
fi

if [[ ! -f "${ARCHIVE}" ]]; then
  echo "Archive not found: ${ARCHIVE}" >&2
  exit 1
fi

if [[ ! -d "${TEMPLATE_DIR}" ]]; then
  echo "Missing html template at ${TEMPLATE_DIR}. Run bootstrap-vps.sh after deploying the latest platform." >&2
  exit 1
fi

mkdir -p "${SITE_DIR}/releases" "${SITE_DIR}/shared" "${HOSTING_ROOT}/logs"
exec > >(tee -a "${LOG_FILE}") 2>&1

echo "[$(date -Iseconds)] Uploading static site ${SLUG}"

cp "${TEMPLATE_DIR}/Dockerfile" "${SITE_DIR}/Dockerfile"
cp "${TEMPLATE_DIR}/compose.yaml" "${SITE_DIR}/compose.yaml"

if [[ ! -f "${SITE_DIR}/site.env" ]]; then
  cat >"${SITE_DIR}/site.env" <<EOF_SITE_ENV
SITE_SLUG=${SLUG}
RUNTIME=html
REPO_URL=upload://${SLUG}
BRANCH=uploaded
BUILD_COMMAND=
START_COMMAND=
SERVICE_PORT=8080
EOF_SITE_ENV
fi

if [[ ! -f "${SITE_DIR}/.env" ]]; then
  cat >"${SITE_DIR}/.env" <<EOF_APP_ENV
# Runtime environment for uploaded static site ${SLUG}.
EOF_APP_ENV
  chmod 600 "${SITE_DIR}/.env"
fi

RELEASE_ID="$(date +%Y%m%d%H%M%S)"
RELEASE_DIR="${SITE_DIR}/releases/${RELEASE_ID}"
mkdir -p "${RELEASE_DIR}"
tar -xzf "${ARCHIVE}" -C "${RELEASE_DIR}"
ln -sfn "${RELEASE_DIR}" "${SITE_DIR}/current"

(
  cd "${SITE_DIR}"
  docker compose --env-file "${SITE_DIR}/site.env" -p "site-${SLUG}" up -d --build --remove-orphans
)

find "${SITE_DIR}/releases" -mindepth 1 -maxdepth 1 -type d | sort -r | sed -n '6,$p' | xargs -r rm -rf

if [[ -f "${PLATFORM_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${PLATFORM_DIR}/.env"
  set +a
  SQL_SLUG="${SLUG//\'/\'\'}"
  SQL_NAME="${NAME//\'/\'\'}"

  (
    cd "${PLATFORM_DIR}"
    docker compose exec -T postgres psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
      -c "insert into sites (slug, name, runtime, repo_url, branch, status)
          values ('${SQL_SLUG}', '${SQL_NAME}', 'html', 'upload://${SQL_SLUG}', 'uploaded', 'deployed')
          on conflict (slug) do update
          set name = excluded.name,
              runtime = 'html',
              repo_url = excluded.repo_url,
              branch = 'uploaded',
              status = 'deployed',
              updated_at = now();"
  )
fi

echo "[$(date -Iseconds)] Upload complete for ${SLUG}"
