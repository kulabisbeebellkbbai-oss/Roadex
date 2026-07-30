#!/usr/bin/env bash
set -euo pipefail

umask 077

readonly PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly STATE_ROOT="$HOME/.local/share/roadex-controlled-operations"
readonly CONFIG_ROOT="$HOME/.config/roadex"
readonly UNIT_ROOT="$HOME/.config/systemd/user"
readonly LIBEXEC_ROOT="$HOME/.local/libexec"
readonly RUNTIME_ROOT="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
readonly SOCKET_PATH="$RUNTIME_ROOT/roadex-controlled-operations.sock"
readonly TEMP_ROOT="$(mktemp -d)"
readonly ACTIVATE="${1:-}"
COMMITTED=false
ACTIVATION_STARTED=false
HOST_WAS_ACTIVE=false
HOST_WAS_ENABLED=false
ROADEX_WAS_ACTIVE=false

declare -a TARGETS=(
  "$LIBEXEC_ROOT/roadex-controlled-peer-check"
  "$CONFIG_ROOT/controlled-operations.env"
  "$UNIT_ROOT/roadex-controlled-operations.service"
  "$UNIT_ROOT/roadex.service.d/controlled-operations.conf"
  "$STATE_ROOT/ssh/id_ed25519"
  "$STATE_ROOT/ssh/known_hosts"
)
declare -a STAGED=(
  "$TEMP_ROOT/roadex-controlled-peer-check"
  "$TEMP_ROOT/controlled-operations.env"
  "$TEMP_ROOT/roadex-controlled-operations.service"
  "$TEMP_ROOT/roadex-controlled-operations.conf"
  "$TEMP_ROOT/id_ed25519"
  "$TEMP_ROOT/known_hosts"
)
declare -a MODES=(0755 0600 0644 0644 0600 0600)
declare -a EXISTED=(false false false false false false)

rollback() {
  local exit_code=$?
  trap - EXIT
  if [[ "$COMMITTED" == false ]]; then
    for index in "${!TARGETS[@]}"; do
      if [[ "${EXISTED[$index]}" == true ]]; then
        install -m "${MODES[$index]}" \
          "$TEMP_ROOT/backup-$index" \
          "${TARGETS[$index]}.roadex-restore-$$"
        mv -- "${TARGETS[$index]}.roadex-restore-$$" "${TARGETS[$index]}"
      elif [[ -e "${TARGETS[$index]}" ]]; then
        unlink -- "${TARGETS[$index]}"
      fi
    done
    systemctl --user daemon-reload || true
    if [[ "$ACTIVATION_STARTED" == true ]]; then
      if [[ "$HOST_WAS_ENABLED" == true ]]; then
        systemctl --user enable roadex-controlled-operations.service || true
      else
        systemctl --user disable roadex-controlled-operations.service || true
      fi
      if [[ "$HOST_WAS_ACTIVE" == true ]]; then
        systemctl --user restart roadex-controlled-operations.service || true
      else
        systemctl --user stop roadex-controlled-operations.service || true
      fi
      if [[ "$ROADEX_WAS_ACTIVE" == true ]]; then
        systemctl --user restart roadex.service || true
      else
        systemctl --user stop roadex.service || true
      fi
    fi
  fi
  rm -r -- "$TEMP_ROOT"
  exit "$exit_code"
}
trap rollback EXIT

if [[ -n "$ACTIVATE" && "$ACTIVATE" != --activate ]]; then
  printf 'usage: %s [--activate]\n' "$0" >&2
  exit 2
fi

mkdir -p \
  "$STATE_ROOT/ssh" \
  "$STATE_ROOT/audit" \
  "$CONFIG_ROOT" \
  "$UNIT_ROOT/roadex.service.d" \
  "$LIBEXEC_ROOT"
chmod 0700 \
  "$STATE_ROOT" \
  "$STATE_ROOT/ssh" \
  "$STATE_ROOT/audit" \
  "$CONFIG_ROOT" \
  "$LIBEXEC_ROOT"

cc \
  -std=c11 -O2 -Wall -Wextra -Werror \
  -D_FORTIFY_SOURCE=2 -fstack-protector-strong -fPIE -pie \
  -Wl,-z,relro,-z,now \
  -o "${STAGED[0]}" \
  "$PROJECT_ROOT/native/roadex-controlled-peer-check.c"

readonly SSH_KEY_SOURCE="${ROADEX_CONTROLLED_OPERATIONS_GITHUB_SSH_KEY_SOURCE:-${TARGETS[4]}}"
test -f "$SSH_KEY_SOURCE"
install -m 0600 \
  "$SSH_KEY_SOURCE" \
  "$TEMP_ROOT/id_ed25519"
ssh-keygen -F github.com -f "${ROADEX_CONTROLLED_OPERATIONS_KNOWN_HOSTS_SOURCE:-$HOME/.ssh/known_hosts}" 2>/dev/null \
  | sed '/^#/d' > "$TEMP_ROOT/known_hosts"
test -s "$TEMP_ROOT/known_hosts"

if [[ -f "${TARGETS[1]}" ]]; then
  cp -- "${TARGETS[1]}" "${STAGED[1]}"
else
  : "${ROADEX_CONTROLLED_OPERATIONS_AUTHORIZED_USERS:?required for initial installation}"
  : "${ROADEX_CONTROLLED_OPERATIONS_WORKSPACE_IDS:?required for initial installation}"
  : "${ROADEX_CONTROLLED_OPERATIONS_REPOSITORIES_JSON:?required for initial installation}"
  hmac="$(openssl rand -hex 32)"
  audit_hmac="$(openssl rand -hex 32)"
  test "$hmac" != "$audit_hmac"
  printf '%s\n' \
    'ROADEX_CONTROLLED_OPERATIONS_ENABLED=true' \
    'ROADEX_CONTROLLED_OPERATIONS_EXECUTOR_ENABLED=true' \
    'ROADEX_CONTROLLED_OPERATIONS_LISTENER_ENABLED=true' \
    'ROADEX_CONTROLLED_OPERATIONS_NPM_ADAPTER_ENABLED=true' \
    'ROADEX_CONTROLLED_OPERATIONS_GITHUB_SSH_ADAPTER_ENABLED=true' \
    "ROADEX_CONTROLLED_OPERATIONS_AUTHORIZED_USERS=$ROADEX_CONTROLLED_OPERATIONS_AUTHORIZED_USERS" \
    "ROADEX_CONTROLLED_OPERATIONS_WORKSPACE_IDS=$ROADEX_CONTROLLED_OPERATIONS_WORKSPACE_IDS" \
    "ROADEX_CONTROLLED_OPERATIONS_REPOSITORIES_JSON=$ROADEX_CONTROLLED_OPERATIONS_REPOSITORIES_JSON" \
    "ROADEX_CONTROLLED_OPERATION_SOCKET=$SOCKET_PATH" \
    "ROADEX_CONTROLLED_OPERATIONS_REPLAY_PATH=$STATE_ROOT/replay" \
    "ROADEX_CONTROLLED_OPERATIONS_AUDIT_PATH=$STATE_ROOT/audit/events.jsonl" \
    "ROADEX_CONTROLLED_OPERATIONS_HMAC_KEY=$hmac" \
    "ROADEX_CONTROLLED_OPERATIONS_AUDIT_HMAC_KEY=$audit_hmac" \
    > "${STAGED[1]}"
fi

install -m 0644 \
  "$PROJECT_ROOT/deployment/systemd/roadex-controlled-operations.service" \
  "${STAGED[2]}"
install -m 0644 \
  "$PROJECT_ROOT/deployment/systemd/roadex-controlled-operations.conf" \
  "${STAGED[3]}"

test "$(stat -c '%a' "${STAGED[0]}")" = 700 \
  -o "$(stat -c '%a' "${STAGED[0]}")" = 755
test "$(grep -c '^ROADEX_CONTROLLED_OPERATIONS_HMAC_KEY=' "${STAGED[1]}")" = 1
test "$(grep -c '^ROADEX_CONTROLLED_OPERATIONS_AUDIT_HMAC_KEY=' "${STAGED[1]}")" = 1
test "$(grep -c '=true$' "${STAGED[1]}")" = 5
awk '$2 == "ssh-ed25519" { found = 1 } END { exit found ? 0 : 1 }' "$TEMP_ROOT/known_hosts"

for index in "${!TARGETS[@]}"; do
  if [[ -e "${TARGETS[$index]}" ]]; then
    EXISTED[$index]=true
    cp -a -- "${TARGETS[$index]}" "$TEMP_ROOT/backup-$index"
  fi
done

for index in "${!TARGETS[@]}"; do
  install -m "${MODES[$index]}" \
    "${STAGED[$index]}" \
    "${TARGETS[$index]}.roadex-new-$$"
  mv -- "${TARGETS[$index]}.roadex-new-$$" "${TARGETS[$index]}"
done
systemctl --user daemon-reload
if [[ "${ROADEX_CONTROLLED_INSTALL_FAIL_AFTER_FILES:-}" == true ]]; then
  false
fi

if [[ "$ACTIVATE" == --activate ]]; then
  ACTIVATION_STARTED=true
  systemctl --user is-active --quiet roadex-controlled-operations.service && HOST_WAS_ACTIVE=true
  systemctl --user is-enabled --quiet roadex-controlled-operations.service && HOST_WAS_ENABLED=true
  systemctl --user is-active --quiet roadex.service && ROADEX_WAS_ACTIVE=true
  systemctl --user enable roadex-controlled-operations.service
  systemctl --user restart roadex-controlled-operations.service
  systemctl --user restart roadex.service
  systemctl --user is-active --quiet roadex-controlled-operations.service
  systemctl --user is-active --quiet roadex.service
  for _ in {1..20}; do
    if [[ -S "$SOCKET_PATH" ]]; then
      break
    fi
    sleep 0.25
  done
  test -S "$SOCKET_PATH"
  test "$(stat -c '%a' "$SOCKET_PATH")" = 600
  for _ in {1..20}; do
    if curl -fsS http://127.0.0.1:8780/api/health >/dev/null; then
      break
    fi
    sleep 0.25
  done
  curl -fsS http://127.0.0.1:8780/api/health >/dev/null
fi

COMMITTED=true
printf 'helper=%s env=%s unit=%s dropin=%s activated=%s\n' \
  "$(stat -c '%U:%G:%a' "${TARGETS[0]}")" \
  "$(stat -c '%U:%G:%a' "${TARGETS[1]}")" \
  "$(stat -c '%U:%G:%a' "${TARGETS[2]}")" \
  "$(stat -c '%U:%G:%a' "${TARGETS[3]}")" \
  "$([[ "$ACTIVATE" == --activate ]] && printf true || printf false)"
