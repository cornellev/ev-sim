#!/usr/bin/env bash
# ev-sim installer
#
#   curl -fsSL https://raw.githubusercontent.com/cornellev/ev-sim/main/install.sh | bash
#
# Options (env or flags after bash -s --):
#   EV_SIM_DIR / --dir DIR       Install directory (default: ./ev-sim)
#   EV_SIM_BRANCH / --branch B   Git branch (default: main)
#   EV_SIM_REPO                  Override clone URL
#   --no-install                 Clone only; skip npm install
#   --start                      Run npm run dev after install
#   -h, --help                   Show help

set -euo pipefail

REPO_URL="${EV_SIM_REPO:-https://github.com/cornellev/ev-sim.git}"
BRANCH="${EV_SIM_BRANCH:-main}"
INSTALL_DIR="${EV_SIM_DIR:-}"
SKIP_NPM=0
START_DEV=0
MIN_NODE_MAJOR=20

# ── colors ──────────────────────────────────────────────────────────────────
if [[ -t 1 ]] && [[ "${NO_COLOR:-}" == "" ]] && [[ "${TERM:-}" != "dumb" ]]; then
  BOLD=$'\033[1m'
  DIM=$'\033[2m'
  RESET=$'\033[0m'
  RED=$'\033[31m'
  GREEN=$'\033[32m'
  YELLOW=$'\033[33m'
  CYAN=$'\033[36m'
  WHITE=$'\033[97m'
  GRAY=$'\033[90m'
else
  BOLD=""; DIM=""; RESET=""; RED=""; GREEN=""; YELLOW=""; CYAN=""; WHITE=""; GRAY=""
fi

ok()   { printf '  %s✓%s  %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '  %s!%s  %s\n' "$YELLOW" "$RESET" "$*"; }
fail() { printf '  %s✗%s  %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }
step() { printf '\n%s▸%s  %s%s%s\n' "$CYAN" "$RESET" "$BOLD" "$*" "$RESET"; }
info() { printf '  %s·%s  %s\n' "$GRAY" "$RESET" "$*"; }

usage() {
  cat <<EOF
${BOLD}ev-sim installer${RESET}

Usage:
  curl -fsSL https://raw.githubusercontent.com/cornellev/ev-sim/main/install.sh | bash
  curl -fsSL ... | bash -s -- [options]

Options:
  --dir DIR        Install into DIR (default: ./ev-sim)
  --branch NAME    Clone branch NAME (default: main)
  --no-install     Skip npm install
  --start          Start the dev server after install
  -h, --help       Show this help

Environment:
  EV_SIM_DIR, EV_SIM_BRANCH, EV_SIM_REPO, NO_COLOR
EOF
}

# ── args ────────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)        INSTALL_DIR="${2:-}"; shift 2 || fail "--dir requires a path" ;;
    --branch)     BRANCH="${2:-}"; shift 2 || fail "--branch requires a name" ;;
    --no-install) SKIP_NPM=1; shift ;;
    --start)      START_DEV=1; shift ;;
    -h|--help)    usage; exit 0 ;;
    *)            fail "Unknown option: $1 (try --help)" ;;
  esac
done

INSTALL_DIR="${INSTALL_DIR:-$PWD/ev-sim}"

# Expand ~ if present
INSTALL_DIR="${INSTALL_DIR/#\~/$HOME}"

# ── banner ──────────────────────────────────────────────────────────────────
banner() {
  printf '\n'
  printf '%s' "$CYAN$BOLD"
  cat <<'EOF'
                         _
   ___ _   __      _____(_)___ ___
  / _ \ | / /_____/ ___/ / __ `__ \
 /  __/ |/ /_____(__  ) / / / / / /
 \___/|___/     /____/_/_/ /_/ /_/
EOF
  printf '%s' "$RESET"
  printf '  %sCornell EV · autonomous driving simulation workbench%s\n' "$DIM" "$RESET"
  printf '\n'
}

# ── helpers ─────────────────────────────────────────────────────────────────
have() { command -v "$1" >/dev/null 2>&1; }

node_major() {
  node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0
}

spinner_pid=""
spin_start() {
  local msg="$1"
  if [[ ! -t 1 ]]; then
    info "$msg"
    return
  fi
  (
    local frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
    local i=0
    while true; do
      printf '\r  %s%s%s  %s' "$CYAN" "${frames:i++%10:1}" "$RESET" "$msg"
      sleep 0.08
    done
  ) &
  spinner_pid=$!
  printf '\033[?25l' 2>/dev/null || true
}

spin_stop() {
  local status="${1:-ok}"
  local msg="${2:-}"
  if [[ -n "${spinner_pid}" ]] && kill -0 "$spinner_pid" 2>/dev/null; then
    kill "$spinner_pid" 2>/dev/null || true
    wait "$spinner_pid" 2>/dev/null || true
    spinner_pid=""
    printf '\r\033[K'
  fi
  printf '\033[?25h' 2>/dev/null || true
  if [[ -n "$msg" ]]; then
    if [[ "$status" == "ok" ]]; then
      ok "$msg"
    elif [[ "$status" != "quiet" ]]; then
      fail "$msg"
    fi
  fi
}

cleanup() {
  spin_stop quiet
  printf '\033[?25h' 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ── main ────────────────────────────────────────────────────────────────────
banner

step "Checking prerequisites"

if have git; then
  ok "git  $(git --version | awk '{print $3}')"
else
  fail "git is required. Install it, then re-run this script."
fi

if have node; then
  NODE_V="$(node -v 2>/dev/null || true)"
  MAJOR="$(node_major)"
  if [[ "$MAJOR" -lt "$MIN_NODE_MAJOR" ]]; then
    fail "Node.js ${MIN_NODE_MAJOR}+ required (found ${NODE_V}). Get it at https://nodejs.org"
  fi
  ok "node ${NODE_V}"
else
  fail "Node.js ${MIN_NODE_MAJOR}+ is required. Get it at https://nodejs.org then re-run."
fi

if have npm; then
  ok "npm  v$(npm -v 2>/dev/null)"
else
  fail "npm is required (ships with Node.js)."
fi

step "Cloning repository"
info "$REPO_URL  (${BRANCH})"
info "→ ${INSTALL_DIR}"

if [[ -d "$INSTALL_DIR/.git" ]]; then
  warn "Existing checkout found — updating instead of cloning"
  (
    cd "$INSTALL_DIR"
    git fetch --quiet origin "$BRANCH"
    git checkout --quiet "$BRANCH"
    git pull --ff-only --quiet origin "$BRANCH"
  ) || fail "Failed to update existing clone at ${INSTALL_DIR}"
  ok "Updated existing checkout"
elif [[ -e "$INSTALL_DIR" ]]; then
  fail "Path exists and is not an ev-sim clone: ${INSTALL_DIR}"
else
  PARENT="$(dirname "$INSTALL_DIR")"
  mkdir -p "$PARENT"
  spin_start "Cloning…"
  if git clone --branch "$BRANCH" --depth 1 --quiet "$REPO_URL" "$INSTALL_DIR"; then
    spin_stop ok "Cloned into ${INSTALL_DIR}"
  else
    spin_stop fail "git clone failed"
  fi
fi

if [[ "$SKIP_NPM" -eq 1 ]]; then
  step "Skipping dependency install (--no-install)"
else
  step "Installing dependencies"
  info "npm install  (this may take a minute)"
  LOG_FILE="$(mktemp -t ev-sim-npm.XXXXXX)"
  spin_start "npm install…"
  if (
    cd "$INSTALL_DIR"
    npm install --no-fund --no-audit >"$LOG_FILE" 2>&1
  ); then
    spin_stop ok "Dependencies installed"
    rm -f "$LOG_FILE"
  else
    spin_stop quiet
    printf '  %s✗%s  npm install failed — last lines:\n' "$RED" "$RESET" >&2
    tail -n 20 "$LOG_FILE" >&2 || true
    fail "Full log: ${LOG_FILE}"
  fi
fi

# ── done ────────────────────────────────────────────────────────────────────
printf '\n'
printf '  %s━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%s\n' "$GREEN" "$RESET"
printf '  %s%sInstallation complete%s\n' "$GREEN" "$BOLD" "$RESET"
printf '\n'
printf '  %sStart the workbench:%s\n' "$WHITE" "$RESET"
printf '\n'
printf '    %scd %s%s\n' "$CYAN" "$INSTALL_DIR" "$RESET"
printf '    %snpm run dev%s\n' "$CYAN" "$RESET"
printf '\n'
printf '  Open the URL Next prints (usually %slocalhost:3000%s).\n' "$BOLD" "$RESET"
printf '  Press %sEscape%s in the app for the mode menu.\n' "$BOLD" "$RESET"
printf '\n'
printf '  Docs → %sdocs/getting-started.md%s\n' "$DIM" "$RESET"
printf '  %s━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%s\n' "$GREEN" "$RESET"
printf '\n'

if [[ "$START_DEV" -eq 1 ]]; then
  step "Starting dev server"
  cd "$INSTALL_DIR"
  # Clear EXIT trap so we don't kill the server's process group noise
  trap - EXIT
  printf '\033[?25h' 2>/dev/null || true
  exec npm run dev
fi
