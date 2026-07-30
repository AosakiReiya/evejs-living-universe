#!/usr/bin/env bash
set -Eeuo pipefail

readonly DATA_ROOT="${EVEJS_DATA_ROOT:-/var/lib/evejs}"
readonly GAMESTORE_ROOT="${DATA_ROOT}/gameStore"
readonly GAMESTORE_DATA="${GAMESTORE_ROOT}/data"
readonly GAMESTORE_IMAGES="${GAMESTORE_ROOT}/images"
readonly GAMESTORE_MANIFEST="${GAMESTORE_ROOT}/manifest.json"
readonly DOWNLOAD_ROOT="${DATA_ROOT}/downloads/sde"
readonly SDE_BUILD="3396210"
readonly SDE_URL="${EVEJS_SDE_URL:-https://developers.eveonline.com/static-data/tranquility/eve-online-static-data-${SDE_BUILD}-jsonl.zip}"
readonly SDE_ZIP="${DOWNLOAD_ROOT}/eve-online-static-data-${SDE_BUILD}-jsonl.zip"
readonly SDE_ROOT="${DATA_ROOT}/sde/eve-online-static-data-${SDE_BUILD}-jsonl"
readonly MARKET_ROOT="${DATA_ROOT}/market"
readonly MARKET_DATABASE="${MARKET_ROOT}/market.sqlite"
readonly MARKET_CANDIDATE="${MARKET_ROOT}/market.sqlite.candidate"
readonly MARKET_BACKUP_ROOT="${MARKET_ROOT}/backups"
readonly MARKET_LOCK="${MARKET_ROOT}/.market.lock"
readonly MARKET_DATABASE_TOOL="/app/docker/market-database-tool.js"
readonly MARKET_SERVER_CONFIG="/app/docker/market-server.toml"
readonly MARKET_CANDIDATE_SERVER_CONFIG="/app/docker/market-server-candidate.toml"
readonly MARKET_SEED_V1_CONFIG="/app/docker/market-seed.toml"
readonly MARKET_SEED_V2_CONFIG="/app/docker/market-seed-v2.toml"

log() {
  printf '[evejs-docker] %s\n' "$*"
}

ensure_sde() {
  mkdir -p "${DOWNLOAD_ROOT}" "$(dirname "${SDE_ROOT}")"

  if [[ -f "${SDE_ZIP}" ]] && ! unzip -tq "${SDE_ZIP}" >/dev/null 2>&1; then
    log "Discarding an incomplete cached SDE download."
    rm -f "${SDE_ZIP}"
  fi

  if [[ ! -f "${SDE_ZIP}" ]]; then
    log "Downloading EVE static data build ${SDE_BUILD} (first start only)."
    curl --fail --location --retry 5 --retry-all-errors \
      --output "${SDE_ZIP}.partial" "${SDE_URL}"
    mv "${SDE_ZIP}.partial" "${SDE_ZIP}"
  fi

  if [[ ! -f "${SDE_ROOT}/_sde.jsonl" ]]; then
    log "Extracting EVE static data (first start only)."
    rm -rf "${SDE_ROOT}.partial"
    mkdir -p "${SDE_ROOT}.partial"
    unzip -q "${SDE_ZIP}" -d "${SDE_ROOT}.partial"
    rm -rf "${SDE_ROOT}"
    mv "${SDE_ROOT}.partial" "${SDE_ROOT}"
  fi
}

ensure_gamestore() {
  if [[ -f "${GAMESTORE_MANIFEST}" && -f "${GAMESTORE_DATA}/itemTypes/data.json" ]]; then
    log "Existing game database found; keeping persisted state."
    return
  fi

  ensure_sde
  log "Building the game database (first start only)."
  node --max-old-space-size=8192 /app/tools/DatabaseCreator/database-creator.js \
    --sde-dir "${SDE_ROOT}" \
    --out "${GAMESTORE_DATA}" \
    --build "${SDE_BUILD}" \
    --sde-url "${SDE_URL}" \
    --force
}

initialize() {
  mkdir -p "${DATA_ROOT}"
  ensure_gamestore
  # Runtime-generated images (character portraits, alliance logos) live beside
  # the game database so the volume carries them. Pre-create the directory with
  # the runtime user's ownership rather than letting the server create it.
  mkdir -p "${GAMESTORE_IMAGES}"
  log "Persistent game data initialization is complete."
}

require_market_database() {
  if [[ ! -s "${MARKET_DATABASE}" ]]; then
    log "No market database exists at ${MARKET_DATABASE}."
    log "Choose a seed engine explicitly before startup, for example:"
    log "  docker compose run --rm --no-deps market-tools rebuild v1 --preset jita_new_caldari"
    return 1
  fi
}

acquire_market_exclusive_lock() {
  mkdir -p "${MARKET_ROOT}"
  exec 8>"${MARKET_LOCK}"
  if ! flock --nonblock --exclusive 8; then
    log "The market database is currently in use."
    log "Stop the runtime first: docker compose stop server market"
    return 1
  fi
}

clean_market_candidate() {
  rm -f \
    "${MARKET_CANDIDATE}" \
    "${MARKET_CANDIDATE}-shm" \
    "${MARKET_CANDIDATE}-wal" \
    "${MARKET_CANDIDATE}.building" \
    "${MARKET_CANDIDATE}.building-shm" \
    "${MARKET_CANDIDATE}.building-wal" \
    "${MARKET_CANDIDATE}.previous" \
    "${MARKET_CANDIDATE}.previous-shm" \
    "${MARKET_CANDIDATE}.previous-wal"
}

run_market_daemon() {
  require_market_database
  acquire_market_exclusive_lock
  exec market-server --config "${MARKET_SERVER_CONFIG}" serve
}

run_market() {
  run_market_daemon
}

run_server() {
  cd /app/server
  exec node \
    --report-on-fatalerror \
    --report-uncaught-exception \
    --report-dir=./logs/node-reports \
    --max-old-space-size=8192 \
    .
}

run_living_economy_topology_sync() {
  if [[ ! -f /app/evejs.config.x-eve.json ]]; then
    return 0
  fi
  if ! grep -q '"livingEconomyEnabled".*true' /app/evejs.config.x-eve.json 2>/dev/null; then
    return 0
  fi
  log "Synchronising Living Economy market topology."
  node /app/server/scripts/syncLivingEconomyMarketTopology.js \
    --database "${MARKET_DATABASE}" \
    --static-data "${GAMESTORE_DATA}" || log "Topology sync completed with warnings."
}

run_all() {
  initialize
  require_market_database

  (run_market_daemon) &
  local market_pid=$!
  local market_ready=0

  for _ in $(seq 1 300); do
    if curl --fail --silent http://127.0.0.1:40110/health >/dev/null; then
      market_ready=1
      break
    fi
    if ! kill -0 "${market_pid}" 2>/dev/null; then
      wait "${market_pid}"
      return $?
    fi
    sleep 1
  done

  if [[ "${market_ready}" -ne 1 ]]; then
    log "Market server did not become healthy within 300 seconds."
    kill -TERM "${market_pid}" 2>/dev/null || true
    wait "${market_pid}" 2>/dev/null || true
    return 1
  fi

  run_living_economy_topology_sync

  (cd /app/server && exec node \
    --report-on-fatalerror \
    --report-uncaught-exception \
    --report-dir=./logs/node-reports \
    --max-old-space-size=8192 \
    .) &
  local server_pid=$!

  shutdown() {
    trap - INT TERM
    kill -TERM "${server_pid}" "${market_pid}" 2>/dev/null || true
    wait "${server_pid}" 2>/dev/null || true
    wait "${market_pid}" 2>/dev/null || true
  }
  trap shutdown INT TERM

  set +e
  wait -n "${server_pid}" "${market_pid}"
  local status=$?
  set -e
  shutdown
  return "${status}"
}

market_tools_help() {
  cat <<'EOF'
EvEJS Docker market tools

Usage:
  docker compose run --rm --no-deps market-tools <command> [arguments]

Commands:
  engines                    Explain the v1 and v2 seed engines.
  rebuild v1 [seed args]     Replace market.sqlite with a synthetic v1 seed.
  rebuild v2 [import args]   Replace market.sqlite from the latest EVE Ref snapshot.
  status                     Show the persisted manifest, table counts, and backup count.
  doctor                     Validate the final database (market must be stopped).
  backup [label]             Create a retained SQLite backup (market must be stopped).
  backups                    List retained backups.
  restore <latest|filename>  Restore a retained backup (market must be stopped).
  presets                    List v1 geography presets.
  snapshot-info              Inspect the current v2 source snapshot without rebuilding.
  help                       Show this message.

Rebuild, doctor, backup, and restore are deliberately offline operations. Stop both services first:
  docker compose stop server market

V2 reuses the matching cached snapshot by default. Add --fresh-download to a
v2 rebuild command when you need to download the published snapshot again.
EOF
}

market_engines() {
  cat <<'EOF'
v1  Synthetic, deterministic liquidity generated from local static data.
    Presets: jita_new_caldari, jita_only, new_caldari_only, full_universe.

v2  Current Tranquility station-market liquidity imported from EVE Ref.
    Filters: all-station, npc-only, player-only, market-scope,
    market-scope-with-npc. Player-structure orders are intentionally excluded.

Both engines replace the same market.sqlite used by the same Rust market daemon.
EOF
}

market_v1_has_selection() {
  local argument
  for argument in "$@"; do
    case "${argument}" in
      --preset|--preset=*|--solar-system-id|--solar-system-id=*|--solar-system-name|--solar-system-name=*)
        return 0
        ;;
    esac
  done
  return 1
}

market_v2_has_reuse_download() {
  local argument
  for argument in "$@"; do
    if [[ "${argument}" == "--reuse-download" ]]; then
      return 0
    fi
  done
  return 1
}

install_market_candidate() {
  local backup_label="$1"
  local rollback_backup=""

  rollback_backup="$(node "${MARKET_DATABASE_TOOL}" backup \
    "${MARKET_DATABASE}" "${MARKET_BACKUP_ROOT}" "${backup_label}")"

  rm -f "${MARKET_DATABASE}-wal" "${MARKET_DATABASE}-shm"
  mv -f "${MARKET_CANDIDATE}" "${MARKET_DATABASE}"

  if market-server --config "${MARKET_SERVER_CONFIG}" doctor; then
    if [[ -n "${rollback_backup}" ]]; then
      log "Previous market retained at ${rollback_backup}."
    fi
    return 0
  fi

  log "Installed market validation failed. Attempting automatic rollback."
  if [[ -z "${rollback_backup}" ]]; then
    log "No previous market database was available to restore."
    return 1
  fi

  clean_market_candidate
  node "${MARKET_DATABASE_TOOL}" stage-restore \
    "${MARKET_BACKUP_ROOT}" "$(basename "${rollback_backup}")" "${MARKET_CANDIDATE}" \
    >/dev/null
  rm -f "${MARKET_DATABASE}" "${MARKET_DATABASE}-wal" "${MARKET_DATABASE}-shm"
  mv "${MARKET_CANDIDATE}" "${MARKET_DATABASE}"
  market-server --config "${MARKET_SERVER_CONFIG}" doctor
  log "Rollback restored ${rollback_backup}."
  return 1
}

market_rebuild() {
  local engine="${1:-}"
  if [[ -z "${engine}" ]]; then
    log "Choose a seed engine: rebuild v1 ... or rebuild v2 ..."
    return 2
  fi
  shift

  case "${engine}" in
    v1|v2) ;;
    *)
      log "Unknown market seed engine '${engine}'. Expected v1 or v2."
      return 2
      ;;
  esac

  acquire_market_exclusive_lock
  ensure_gamestore
  clean_market_candidate

  log "WARNING: rebuilding replaces seeded liquidity, player orders, events, and history."
  log "Building market candidate with seed engine ${engine}."

  if [[ "${engine}" == "v1" ]]; then
    local -a v1_arguments=("$@")
    if ! market_v1_has_selection "${v1_arguments[@]}"; then
      v1_arguments+=(--preset jita_new_caldari)
      log "No v1 geography was supplied; using safe default jita_new_caldari."
    fi
    market-seed \
      --config "${MARKET_SEED_V1_CONFIG}" \
      build \
      --force \
      "${v1_arguments[@]}"
  else
    local -a v2_arguments=("$@")
    local -a filtered_v2_arguments=()
    local fresh_download=0
    local argument
    for argument in "${v2_arguments[@]}"; do
      if [[ "${argument}" == "--fresh-download" ]]; then
        fresh_download=1
      else
        filtered_v2_arguments+=("${argument}")
      fi
    done
    if [[ "${fresh_download}" -eq 1 ]] && market_v2_has_reuse_download "${filtered_v2_arguments[@]}"; then
      log "Do not combine --fresh-download with --reuse-download."
      return 2
    fi
    if [[ "${fresh_download}" -eq 0 ]] && ! market_v2_has_reuse_download "${filtered_v2_arguments[@]}"; then
      filtered_v2_arguments+=(--reuse-download)
    fi
    if [[ "${fresh_download}" -eq 1 ]]; then
      log "Ignoring the cached v2 snapshot for this rebuild."
    fi
    v2_arguments=("${filtered_v2_arguments[@]}")
    market-seederv2 \
      --config "${MARKET_SEED_V2_CONFIG}" \
      build \
      --yes \
      "${v2_arguments[@]}"
  fi

  node "${MARKET_DATABASE_TOOL}" prepare \
    "${MARKET_CANDIDATE}" "${MARKET_DATABASE}" >/dev/null
  market-server --config "${MARKET_CANDIDATE_SERVER_CONFIG}" doctor
  node "${MARKET_DATABASE_TOOL}" prepare \
    "${MARKET_CANDIDATE}" "${MARKET_DATABASE}" >/dev/null
  install_market_candidate "before-${engine}-rebuild"
  clean_market_candidate
  log "Market rebuild with ${engine} completed successfully."
}

market_backup() {
  local label="${1:-manual}"
  acquire_market_exclusive_lock
  require_market_database
  local backup_path
  backup_path="$(node "${MARKET_DATABASE_TOOL}" backup \
    "${MARKET_DATABASE}" "${MARKET_BACKUP_ROOT}" "${label}")"
  log "Market backup created: ${backup_path}"
}

market_doctor() {
  acquire_market_exclusive_lock
  require_market_database
  market-server --config "${MARKET_SERVER_CONFIG}" doctor
}

market_restore() {
  local selector="${1:-}"
  if [[ -z "${selector}" ]]; then
    log "Choose a backup filename or use: restore latest"
    return 2
  fi

  acquire_market_exclusive_lock
  clean_market_candidate
  local selected_backup
  selected_backup="$(node "${MARKET_DATABASE_TOOL}" stage-restore \
    "${MARKET_BACKUP_ROOT}" "${selector}" "${MARKET_CANDIDATE}")"
  node "${MARKET_DATABASE_TOOL}" prepare \
    "${MARKET_CANDIDATE}" "${MARKET_DATABASE}" >/dev/null
  market-server --config "${MARKET_CANDIDATE_SERVER_CONFIG}" doctor
  node "${MARKET_DATABASE_TOOL}" prepare \
    "${MARKET_CANDIDATE}" "${MARKET_DATABASE}" >/dev/null
  install_market_candidate "before-restore"
  clean_market_candidate
  log "Restored market backup ${selected_backup}."
}

market_tools() {
  local command="${1:-help}"
  shift || true
  case "${command}" in
    engines)
      market_engines
      ;;
    rebuild)
      market_rebuild "$@"
      ;;
    status)
      node "${MARKET_DATABASE_TOOL}" status "${MARKET_DATABASE}" "${MARKET_BACKUP_ROOT}"
      ;;
    doctor)
      market_doctor
      ;;
    backup)
      market_backup "$@"
      ;;
    backups)
      node "${MARKET_DATABASE_TOOL}" backups "${MARKET_BACKUP_ROOT}"
      ;;
    restore)
      market_restore "$@"
      ;;
    presets)
      market-seed --config "${MARKET_SEED_V1_CONFIG}" presets
      ;;
    snapshot-info)
      market-seederv2 --config "${MARKET_SEED_V2_CONFIG}" snapshot-info
      ;;
    help|--help|-h)
      market_tools_help
      ;;
    *)
      log "Unknown market-tools command '${command}'."
      market_tools_help
      return 2
      ;;
  esac
}

case "${1:-all}" in
  init)
    initialize
    ;;
  market)
    run_market
    ;;
  server)
    run_server
    ;;
  all)
    run_all
    ;;
  market-tools)
    shift
    market_tools "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
