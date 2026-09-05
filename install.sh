#!/usr/bin/env bash
# kohlab one-line installer.
#   curl -fsSL https://raw.githubusercontent.com/nzkbuild/kohlab/main/install.sh | bash
# Installs the repo into ~/kohlab (or $KOHLAB_HOME), checks bun+git, and prints
# the next steps. Idempotent — safe to re-run.

set -euo pipefail

KOHLAB_HOME="${KOHLAB_HOME:-$HOME/kohlab}"
REPO="${KOHLAB_REPO:-https://github.com/nzkbuild/kohlab.git}"

log() { printf '\033[1;32m✓\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$1"; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$1" >&2; exit 1; }

# --- deps ---
command -v git >/dev/null 2>&1 || die "git is required: sudo apt-get install -y git"
command -v bun >/dev/null 2>&1 || die "bun is required: curl -fsSL https://bun.sh/install | bash"
log "bun $(bun --version), git $(git --version | awk '{print $3}')"

# --- clone / update ---
if [ -d "$KOHLAB_HOME/.git" ]; then
  log "found existing install at $KOHLAB_HOME — pulling"
  git -C "$KOHLAB_HOME" pull --ff-only
else
  log "cloning $REPO → $KOHLAB_HOME"
  git clone "$REPO" "$KOHLAB_HOME"
fi

# --- install deps + build the dashboard ---
cd "$KOHLAB_HOME"
bun install --silent
(cd web && bun install --silent && bun run build)

# --- access key (optional) ---
if [ -z "${KOHLAB_KEY:-}" ] && [ ! -f "$KOHLAB_HOME/.kohlab-key" ]; then
  : # leave open; user opts in below
fi

cat <<EOF

$(log "done — kohlab installed at $KOHLAB_HOME")

Next steps:
  1. (optional) set an access key:  export KOHLAB_KEY="\$(openssl rand -hex 24)"
  2. start the server:              cd $KOHLAB_HOME && bun run cli.ts server
  3. open from your machine:        ssh -L 7676:localhost:7676 user@your-server
                                     → http://localhost:7676

Auto-start on reboot: docs/systemd.md
EOF
