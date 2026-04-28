#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/srv/hosting/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-someting-postgres-1}"
POSTGRES_DB="${POSTGRES_DB:-someting}"
POSTGRES_USER="${POSTGRES_USER:-someting}"

mkdir -p "${BACKUP_DIR}"

STAMP="$(date +%Y%m%d%H%M%S)"
TARGET="${BACKUP_DIR}/postgres-${POSTGRES_DB}-${STAMP}.sql.gz"

docker exec "${POSTGRES_CONTAINER}" pg_dump -U "${POSTGRES_USER}" "${POSTGRES_DB}" | gzip > "${TARGET}"
find "${BACKUP_DIR}" -name "postgres-*.sql.gz" -type f -mtime +"${RETENTION_DAYS}" -delete

echo "Wrote ${TARGET}"
