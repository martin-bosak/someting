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
DEPLOY_ENV="${SITE_DIR}/deploy.env"
LOG_FILE="${HOSTING_ROOT}/logs/deploy-${SLUG}.log"

if [[ ! -f "${SITE_ENV}" ]]; then
  echo "Missing ${SITE_ENV}. Create the site first." >&2
  exit 1
fi

# shellcheck disable=SC1090
source "${SITE_ENV}"

if [[ -f "${DEPLOY_ENV}" ]]; then
  # shellcheck disable=SC1090
  source "${DEPLOY_ENV}"
fi

: "${REPO_URL:?REPO_URL is required in site.env}"
: "${BRANCH:=main}"
: "${RUNTIME:?RUNTIME is required in site.env}"

mkdir -p "${SITE_DIR}/releases" "${HOSTING_ROOT}/logs"
exec > >(tee -a "${LOG_FILE}") 2>&1

if [[ -n "${REPO_SUBDIR:-}" ]]; then
  echo "[$(date -Iseconds)] Deploying ${SLUG} from ${REPO_URL}#${BRANCH} (subdir: ${REPO_SUBDIR})"
else
  echo "[$(date -Iseconds)] Deploying ${SLUG} from ${REPO_URL}#${BRANCH}"
fi

if [[ "${REPO_URL}" == upload://* ]]; then
  if [[ ! -e "${SITE_DIR}/current" ]]; then
    echo "Uploaded site ${SLUG} has no current release. Use upload-static-site.sh first." >&2
    exit 1
  fi
else
  RELEASE_ID="$(date +%Y%m%d%H%M%S)"
  RELEASE_DIR="${SITE_DIR}/releases/${RELEASE_ID}"
  if [[ "${GIT_AUTH_MODE:-none}" == "https-token" ]]; then
    ASKPASS_SCRIPT="$(mktemp)"
    GIT_TOKEN="$(printf '%s' "${GIT_TOKEN_B64:?GIT_TOKEN_B64 is required}" | base64 -d)"
    export GIT_USERNAME="${GIT_USERNAME:-x-access-token}" GIT_TOKEN
    cat >"${ASKPASS_SCRIPT}" <<'EOF_ASKPASS'
#!/usr/bin/env sh
case "$1" in
  *Username*) printf '%s\n' "$GIT_USERNAME" ;;
  *Password*) printf '%s\n' "$GIT_TOKEN" ;;
  *) printf '\n' ;;
esac
EOF_ASKPASS
    chmod 700 "${ASKPASS_SCRIPT}"
    GIT_ASKPASS="${ASKPASS_SCRIPT}" GIT_TERMINAL_PROMPT=0 git clone --depth 1 --branch "${BRANCH}" "${REPO_URL}" "${RELEASE_DIR}"
    rm -f "${ASKPASS_SCRIPT}"
  elif [[ "${GIT_AUTH_MODE:-none}" == "ssh-key" ]]; then
    GIT_SSH_COMMAND="ssh -i ${GIT_SSH_KEY_PATH:?GIT_SSH_KEY_PATH is required} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" \
      git clone --depth 1 --branch "${BRANCH}" "${REPO_URL}" "${RELEASE_DIR}"
  else
    GIT_TERMINAL_PROMPT=0 git clone --depth 1 --branch "${BRANCH}" "${REPO_URL}" "${RELEASE_DIR}"
  fi
  if [[ -n "${REPO_SUBDIR:-}" ]]; then
    SUBDIR_PATH="${RELEASE_DIR}/${REPO_SUBDIR}"
    if [[ ! -d "${SUBDIR_PATH}" ]]; then
      echo "REPO_SUBDIR ${REPO_SUBDIR} does not exist in the cloned repository." >&2
      exit 1
    fi
    ln -sfn "${SUBDIR_PATH}" "${SITE_DIR}/current"
  else
    ln -sfn "${RELEASE_DIR}" "${SITE_DIR}/current"
  fi
fi

if [[ ! -f "${SITE_DIR}/Dockerfile" || ! -f "${SITE_DIR}/compose.yaml" ]]; then
  cp "${HOSTING_ROOT}/templates/${RUNTIME}/Dockerfile" "${SITE_DIR}/Dockerfile"
  cp "${HOSTING_ROOT}/templates/${RUNTIME}/compose.yaml" "${SITE_DIR}/compose.yaml"
fi

(
  cd "${SITE_DIR}"
  docker compose --env-file "${SITE_ENV}" -p "site-${SLUG}" up -d --build --remove-orphans
)

find "${SITE_DIR}/releases" -mindepth 1 -maxdepth 1 -type d | sort -r | sed -n '6,$p' | xargs -r rm -rf

echo "[$(date -Iseconds)] Deploy complete for ${SLUG}"
