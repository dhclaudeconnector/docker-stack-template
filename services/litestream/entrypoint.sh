#!/bin/sh
set -e

CONFIG_PATH="${LITESTREAM_CONFIG_PATH:-/etc/litestream.yml}"
REPLICATE_DBS="${LITESTREAM_REPLICATE_DBS:-tinyauth}"

restore_db() {
  name="$1"
  db_path="$2"
  mkdir -p "$(dirname "$db_path")"

  if [ "${LITESTREAM_INIT_MODE:-false}" = "true" ]; then
    if [ -f "$db_path" ]; then
      echo "[ERROR] LITESTREAM_INIT_MODE=true but database file already exists: ${db_path}."
      echo "        Exiting with error to stop and check manually to prevent data loss."
      exit 1
    fi
    echo "[RESTORE] Forced restore in INIT MODE for ${name}: ${db_path}"
    if ! litestream restore -config "$CONFIG_PATH" -if-replica-exists "$db_path"; then
      echo "[ERROR] Forced restore failed for ${name} in INIT MODE."
      exit 1
    fi
    if [ ! -f "$db_path" ]; then
      echo "[ERROR] Replica not found for ${name} in INIT MODE. Forced restore failed."
      exit 1
    fi
    return 0
  fi

  if [ -f "$db_path" ]; then
    echo "[RESTORE] Database already exists, skipping restore for ${name}: ${db_path}"
    return 0
  fi

  echo "[RESTORE] ${name}: ${db_path}"
  if ! litestream restore -config "$CONFIG_PATH" -if-replica-exists "$db_path"; then
    echo "[ERROR] Restore failed for ${name}. Set LITESTREAM_INIT_MODE=true only for first initialization."
    exit 1
  fi

  if [ ! -f "$db_path" ]; then
    echo "[ERROR] Replica not found for ${name}. Startup blocked to avoid data loss."
    echo "        First deploy: set LITESTREAM_INIT_MODE=true, initialize app, then set false."
    exit 1
  fi
}

case ",$REPLICATE_DBS," in
  *,tinyauth,*) restore_db "tinyauth" "/data/tinyauth/${TINYAUTH_DB_FILE:-tinyauth.db}" ;;
esac

case ",$REPLICATE_DBS," in
  *,app,*) restore_db "app" "/data/app/${LITESTREAM_APP_DB_FILE:-app.db}" ;;
esac

if [ "${1:-}" = "restore-only" ]; then
  echo "[RESTORE] Completed for: ${REPLICATE_DBS}"
  exit 0
fi

echo "[REPLICATE] Litestream watching: ${REPLICATE_DBS}"
exec litestream replicate -config "$CONFIG_PATH"
