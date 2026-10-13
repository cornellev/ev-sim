#!/usr/bin/env bash
# ev-sim installer
#
#   curl -fsSL https://raw.githubusercontent.com/cornellev/ev-sim/main/install.sh | bash
#
# Options (env or flags after bash -s --):
#   EV_SIM_DIR / --dir DIR       Install directory (default: ./ev-sim)
#   EV_SIM_REF / --ref REF       Git tag, branch, or commit (default: main)
#   EV_SIM_BRANCH / --branch B   Compatibility alias for --ref
#   EV_SIM_REPO                  Override clone URL
#   --no-install                 Clone only; skip npm ci
#   --start                      Run npm run dev after install
#   --marketplace                Write CEV_SIM_MARKETPLACE_ENABLED=1 to .env.local
#   --no-marketplace             Write CEV_SIM_MARKETPLACE_ENABLED=0 to .env.local
#   -h, --help                   Show help

set -euo pipefail

REPO_URL="${EV_SIM_REPO:-https://github.com/cornellev/ev-sim.git}"
REF="${EV_SIM_REF:-${EV_SIM_BRANCH:-main}}"
INSTALL_DIR="${EV_SIM_DIR:-}"
SKIP_NPM=0
START_DEV=0
# Empty means ask. 1 or 0 skips the prompt.
MARKETPLACE_CHOICE=""
MARKETPLACE_FLAG_SET=0
REQUIRED_NODE_VERSION="22.22.2"
SUPPORTED_NODE_MAJOR=22
NVM_INSTALL_VERSION="v0.40.3"
# present: the active Node was already supported.
# switched: nvm already had REQUIRED_NODE_VERSION and this process selected it.
# installed: this run installed that version and made it the nvm default.
NODE_SETUP="present"
NODE_DEFAULT_SET=0

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
  --ref REF        Clone tag, branch, or commit REF (default: main)
  --branch NAME    Compatibility alias for --ref
  --no-install     Skip npm ci
  --start          Start the dev server after install
  --marketplace    Enable the marketplace in .env.local
  --no-marketplace Disable the marketplace in .env.local
  -h, --help       Show this help

For a reproducible release install, pass a tag such as --ref v0.2.0.
The installer creates .env.local in the install directory. Without
--marketplace or --no-marketplace it asks whether to enable the marketplace.
Enter, y, or yes writes CEV_SIM_MARKETPLACE_ENABLED=1. n or no writes 0.
An existing assignment is kept unless a flag is passed.
A non-interactive run creates the file and leaves that setting unchanged.
When Node.js >=22.22.2 <23 is not active and nvm already has 22.22.2, the
installer switches to it. When 22.22.2 is not installed, the installer asks
whether to install it with nvm and make it the default.
Enter, y, or yes installs it, including nvm ${NVM_INSTALL_VERSION} when nvm
is missing. n or no stops. A run with no terminal stops and prints install
instructions.

Environment:
  EV_SIM_DIR, EV_SIM_REF, EV_SIM_BRANCH, EV_SIM_REPO, NO_COLOR
EOF
}

# ── args ────────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)        INSTALL_DIR="${2:-}"; shift 2 || fail "--dir requires a path" ;;
    --ref)        REF="${2:-}"; shift 2 || fail "--ref requires a tag, branch, or commit" ;;
    --branch)     REF="${2:-}"; shift 2 || fail "--branch requires a name" ;;
    --no-install) SKIP_NPM=1; shift ;;
    --start)      START_DEV=1; shift ;;
    --marketplace)
      if [[ "$MARKETPLACE_FLAG_SET" -eq 1 && "$MARKETPLACE_CHOICE" != "1" ]]; then
        fail "Pass only one of --marketplace or --no-marketplace"
      fi
      MARKETPLACE_CHOICE=1
      MARKETPLACE_FLAG_SET=1
      shift
      ;;
    --no-marketplace)
      if [[ "$MARKETPLACE_FLAG_SET" -eq 1 && "$MARKETPLACE_CHOICE" != "0" ]]; then
        fail "Pass only one of --marketplace or --no-marketplace"
      fi
      MARKETPLACE_CHOICE=0
      MARKETPLACE_FLAG_SET=1
      shift
      ;;
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

node_version_supported() {
  hash -r 2>/dev/null || true
  node -e '
    const [major, minor, patch] = process.versions.node.split(".").map(Number);
    const [requiredMajor, requiredMinor, requiredPatch] = process.argv[2].split(".").map(Number);
    const supportedMajor = Number(process.argv[1]);
    process.exit(major === supportedMajor
      && (minor > requiredMinor || (minor === requiredMinor && patch >= requiredPatch))
      && major === requiredMajor ? 0 : 1);
  ' "$SUPPORTED_NODE_MAJOR" "$REQUIRED_NODE_VERSION" >/dev/null 2>&1
}

nvm_dir() {
  printf '%s\n' "${NVM_DIR:-$HOME/.nvm}"
}

nvm_is_installed() {
  [[ -s "$(nvm_dir)/nvm.sh" ]]
}

required_node_bin() {
  printf '%s/versions/node/v%s/bin\n' "$(nvm_dir)" "$REQUIRED_NODE_VERSION"
}

# nvm.sh and the nvm function read unset variables. Restore the installer's flags after.
run_nvm() {
  set +e
  set +u
  "$@"
  local status=$?
  set -euo pipefail
  return "$status"
}

load_nvm() {
  NVM_DIR="$(nvm_dir)"
  export NVM_DIR
  if [[ ! -s "${NVM_DIR}/nvm.sh" ]]; then
    return 1
  fi
  set +e
  set +u
  # --no-use skips nvm's automatic version switch while the file is sourced.
  # shellcheck disable=SC1091
  . "${NVM_DIR}/nvm.sh" --no-use || true
  set -euo pipefail
  type nvm >/dev/null 2>&1
}

# Select an already-installed copy of REQUIRED_NODE_VERSION for this process.
switch_to_required_node() {
  local bin
  bin="$(required_node_bin)"
  if [[ ! -x "${bin}/node" ]]; then
    return 1
  fi
  if nvm_is_installed; then
    load_nvm || true
    if type nvm >/dev/null 2>&1; then
      run_nvm nvm use "$REQUIRED_NODE_VERSION" >/dev/null 2>&1 || true
    fi
  fi
  PATH="${bin}:${PATH}"
  export PATH
  hash -r 2>/dev/null || true
  have node && node_version_supported
}

install_required_node() {
  local log status bin
  NVM_DIR="$(nvm_dir)"
  export NVM_DIR

  if ! nvm_is_installed; then
    if ! have curl; then
      fail "curl is required to install nvm. Install Node.js ${REQUIRED_NODE_VERSION} from https://nodejs.org, then re-run."
    fi
    log="$(mktemp -t ev-sim-nvm.XXXXXX)"
    spin_start "Installing nvm ${NVM_INSTALL_VERSION}…"
    if curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_INSTALL_VERSION}/install.sh" | bash >"$log" 2>&1; then
      spin_stop ok "Installed nvm ${NVM_INSTALL_VERSION}"
      rm -f "$log"
    else
      spin_stop quiet
      printf '  %s✗%s  nvm install failed — last lines:\n' "$RED" "$RESET" >&2
      tail -n 20 "$log" >&2 || true
      fail "Full log: ${log}"
    fi
  fi

  load_nvm || fail "Could not load nvm from ${NVM_DIR}"

  log="$(mktemp -t ev-sim-node.XXXXXX)"
  spin_start "Installing Node.js ${REQUIRED_NODE_VERSION}…"
  status=0
  run_nvm nvm install "$REQUIRED_NODE_VERSION" >"$log" 2>&1 || status=$?
  if [[ "$status" -ne 0 ]]; then
    spin_stop quiet
    printf '  %s✗%s  Node.js install failed — last lines:\n' "$RED" "$RESET" >&2
    tail -n 20 "$log" >&2 || true
    fail "Full log: ${log}"
  fi
  rm -f "$log"
  spin_stop ok "Installed Node.js ${REQUIRED_NODE_VERSION}"

  status=0
  run_nvm nvm alias default "$REQUIRED_NODE_VERSION" >/dev/null 2>&1 || status=$?
  if [[ "$status" -ne 0 ]]; then
    warn "Installed Node.js ${REQUIRED_NODE_VERSION}, but could not set it as the nvm default"
  else
    NODE_DEFAULT_SET=1
  fi
  run_nvm nvm use "$REQUIRED_NODE_VERSION" >/dev/null 2>&1 || true
  bin="$(required_node_bin)"
  PATH="${bin}:${PATH}"
  export PATH
  hash -r 2>/dev/null || true
  if ! have node || ! node_version_supported; then
    fail "Node.js ${REQUIRED_NODE_VERSION} installed, but it is not active on PATH"
  fi
  NODE_SETUP="installed"
}

# yes, no, or skip (no terminal). Default is yes, matching the marketplace prompt.
ask_yes() {
  local prompt="$1"
  local answer=""
  # Group the tty open so a missing controlling terminal stays quiet.
  if { : >/dev/tty </dev/tty; } 2>/dev/null; then
    printf '  %s [%sY%s/n] ' "$prompt" "$BOLD" "$RESET" >/dev/tty
    if ! IFS= read -r answer </dev/tty; then
      answer=""
    fi
    answer="$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
    case "$answer" in
      n|no) printf 'no\n' ;;
      *) printf 'yes\n' ;;
    esac
    return 0
  fi
  printf 'skip\n'
}

ensure_supported_node() {
  local found="" answer
  if have node && node_version_supported; then
    ok "node $(node -v 2>/dev/null)"
    return 0
  fi

  if have node; then
    found="$(node -v 2>/dev/null || true)"
  fi

  if switch_to_required_node; then
    if [[ -n "$found" ]]; then
      ok "node $(node -v 2>/dev/null)  (switched from ${found})"
    else
      ok "node $(node -v 2>/dev/null)  (switched to ${REQUIRED_NODE_VERSION})"
    fi
    NODE_SETUP="switched"
    return 0
  fi

  if [[ -n "$found" ]]; then
    warn "Found Node.js ${found}; need >=${REQUIRED_NODE_VERSION} <23"
  else
    warn "Node.js is not installed (need >=${REQUIRED_NODE_VERSION} <23)"
  fi
  if ! nvm_is_installed; then
    info "nvm is not installed. Yes installs nvm ${NVM_INSTALL_VERSION}, then Node.js ${REQUIRED_NODE_VERSION}."
  fi
  answer="$(ask_yes "Install Node.js ${REQUIRED_NODE_VERSION} with nvm and use it as the default?")"
  case "$answer" in
    yes)
      install_required_node
      ok "node $(node -v 2>/dev/null)"
      ;;
    no)
      fail "Node.js >=${REQUIRED_NODE_VERSION} <23 is required; development uses ${REQUIRED_NODE_VERSION}. Get it at https://nodejs.org, then re-run."
      ;;
    *)
      fail "Node.js >=${REQUIRED_NODE_VERSION} <23 is required; development uses ${REQUIRED_NODE_VERSION}. No terminal available to install it. Run 'nvm install ${REQUIRED_NODE_VERSION}' or get it at https://nodejs.org, then re-run."
      ;;
  esac
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

# Replace KEY= in .env.local, or append it. Other lines stay as they are.
write_env_assignment() {
  local file="$1"
  local key="$2"
  local value="$3"
  local tmp
  tmp="$(mktemp -t ev-sim-env.XXXXXX)"
  if [[ -f "$file" ]] && grep -q "^${key}=" "$file"; then
    awk -v key="$key" -v value="$value" '
      index($0, key "=") == 1 { print key "=" value; next }
      { print }
    ' "$file" >"$tmp"
    cat "$tmp" >"$file"
    rm -f "$tmp"
    return
  fi
  rm -f "$tmp"
  if [[ -s "$file" && -n "$(tail -c 1 "$file" || true)" ]]; then
    printf '\n' >>"$file"
  fi
  printf '%s=%s\n' "$key" "$value" >>"$file"
}

configure_local_env() {
  local env_file="${INSTALL_DIR}/.env.local"

  step "Local environment"

  if [[ -e "$env_file" && ! -f "$env_file" ]]; then
    fail "${env_file} exists and is not a file"
  fi
  if [[ ! -e "$env_file" ]]; then
    (
      umask 077
      cat >"$env_file" <<'EOF'
# Local environment for ev-sim. Not committed.
# NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=
EOF
    )
    ok "Created .env.local"
  else
    info "Found existing .env.local"
  fi

  if [[ "$MARKETPLACE_FLAG_SET" -eq 0 ]] && grep -q "^CEV_SIM_MARKETPLACE_ENABLED=" "$env_file"; then
    info "Kept existing CEV_SIM_MARKETPLACE_ENABLED"
    return
  fi

  if [[ -z "$MARKETPLACE_CHOICE" ]]; then
    case "$(ask_yes "Enable the marketplace?")" in
      no) MARKETPLACE_CHOICE=0 ;;
      yes) MARKETPLACE_CHOICE=1 ;;
      *)
        info "No terminal — left CEV_SIM_MARKETPLACE_ENABLED unchanged"
        return
        ;;
    esac
  fi

  write_env_assignment "$env_file" "CEV_SIM_MARKETPLACE_ENABLED" "$MARKETPLACE_CHOICE"
  if [[ "$MARKETPLACE_CHOICE" == "1" ]]; then
    ok "Marketplace enabled in .env.local"
  else
    ok "Marketplace disabled in .env.local"
  fi
}

# ── main ────────────────────────────────────────────────────────────────────
banner

step "Checking prerequisites"

if have git; then
  ok "git  $(git --version | awk '{print $3}')"
else
  fail "git is required. Install it, then re-run this script."
fi

ensure_supported_node

if have npm; then
  ok "npm  v$(npm -v 2>/dev/null)"
else
  fail "npm is required (ships with Node.js)."
fi

step "Cloning repository"
info "$REPO_URL  (${REF})"
info "→ ${INSTALL_DIR}"

checkout_ref() {
  local target="$1"
  (
    cd "$target"
    git fetch --quiet --tags origin
    if git rev-parse --verify --quiet "refs/tags/${REF}" >/dev/null; then
      git checkout --quiet "refs/tags/${REF}"
    elif git rev-parse --verify --quiet "refs/remotes/origin/${REF}" >/dev/null; then
      git checkout --quiet -B "$REF" "origin/${REF}"
      git pull --ff-only --quiet origin "$REF"
    elif git rev-parse --verify --quiet "${REF}^{commit}" >/dev/null; then
      git checkout --quiet "$REF"
    else
      git fetch --quiet origin "$REF"
      if git rev-parse --verify --quiet "refs/tags/${REF}" >/dev/null; then
        git checkout --quiet "refs/tags/${REF}"
      else
        git checkout --quiet -B "$REF" "FETCH_HEAD"
      fi
    fi
  )
}

if [[ -d "$INSTALL_DIR/.git" ]]; then
  warn "Existing checkout found — updating instead of cloning"
  checkout_ref "$INSTALL_DIR" || fail "Failed to update existing clone at ${INSTALL_DIR} to ${REF}"
  ok "Updated existing checkout to ${REF}"
elif [[ -e "$INSTALL_DIR" ]]; then
  fail "Path exists and is not an ev-sim clone: ${INSTALL_DIR}"
else
  PARENT="$(dirname "$INSTALL_DIR")"
  mkdir -p "$PARENT"
  spin_start "Cloning…"
  if git clone --quiet "$REPO_URL" "$INSTALL_DIR" && checkout_ref "$INSTALL_DIR"; then
    spin_stop ok "Cloned ${REF} into ${INSTALL_DIR}"
  else
    spin_stop fail "git clone failed"
  fi
fi

if [[ "$SKIP_NPM" -eq 1 ]]; then
  step "Skipping dependency install (--no-install)"
else
  step "Installing dependencies"
  info "npm ci  (this may take a minute)"
  LOG_FILE="$(mktemp -t ev-sim-npm.XXXXXX)"
  spin_start "npm ci…"
  if (
    cd "$INSTALL_DIR"
    npm ci --include=dev --no-fund --no-audit >"$LOG_FILE" 2>&1
  ); then
    spin_stop ok "Dependencies installed"
    rm -f "$LOG_FILE"
  else
    spin_stop quiet
    printf '  %s✗%s  npm ci failed — last lines:\n' "$RED" "$RESET" >&2
    tail -n 20 "$LOG_FILE" >&2 || true
    fail "Full log: ${LOG_FILE}"
  fi
fi

configure_local_env

# ── done ────────────────────────────────────────────────────────────────────
printf '\n'
printf '  %s━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%s\n' "$GREEN" "$RESET"
printf '  %s%sInstallation complete%s\n' "$GREEN" "$BOLD" "$RESET"
printf '\n'
if [[ "$NODE_SETUP" == "installed" && "$NODE_DEFAULT_SET" -eq 1 ]]; then
  printf '  Node.js %s is the nvm default. Open a new terminal so this shell picks it up.\n' "$REQUIRED_NODE_VERSION"
  printf '\n'
elif [[ "$NODE_SETUP" == "installed" ]]; then
  printf '  Node.js %s was installed with nvm. Open a new terminal and run %snvm use%s in the project.\n' \
    "$REQUIRED_NODE_VERSION" "$BOLD" "$RESET"
  printf '\n'
elif [[ "$NODE_SETUP" == "switched" ]]; then
  printf '  This install used Node.js %s from nvm. In a shell that still has another Node, run %snvm use%s in the project first.\n' \
    "$REQUIRED_NODE_VERSION" "$BOLD" "$RESET"
  printf '\n'
fi
printf '  %sStart the workbench:%s\n' "$WHITE" "$RESET"
printf '\n'
printf '    %scd %s%s\n' "$CYAN" "$INSTALL_DIR" "$RESET"
printf '    %snpm run dev%s\n' "$CYAN" "$RESET"
printf '\n'
printf '  Open the URL Next prints (usually %slocalhost:3000%s).\n' "$BOLD" "$RESET"
printf '  Press %sEscape%s in the app for the mode menu.\n' "$BOLD" "$RESET"
if [[ "$MARKETPLACE_CHOICE" == "1" ]]; then
  printf '  Marketplace is enabled in %s.env.local%s.\n' "$BOLD" "$RESET"
elif [[ "$MARKETPLACE_CHOICE" == "0" ]]; then
  printf '  Marketplace is disabled in %s.env.local%s.\n' "$BOLD" "$RESET"
fi
printf '  Optional: %spython -m pip install -e ./python%s (Python 3.10–3.13, docs/python-headless.md)\n' "$CYAN" "$RESET"
printf '  Optional: %snpx cev-sim --help%s (cameras need CEV_SIM_HEADLESS_SUPERVISOR_CONFIG)\n' "$CYAN" "$RESET"
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
