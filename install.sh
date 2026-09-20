#!/usr/bin/env bash
# kohlab installer.
#
#   curl -fsSL https://raw.githubusercontent.com/nzkbuild/kohlab/main/install.sh | bash
#   bash install.sh [options]
#
# Options
#   --key <secret>    access key for the dashboard (generated when omitted)
#   --no-systemd      install and build, but do not create or start a service
#   --no-command      do not put `kohlab` on the PATH
#   --uninstall       stop the service and remove the unit, keeping your data
#   -h, --help        this text
#
# Environment
#   KOHLAB_HOME       where the checkout lives        (default $HOME/kohlab)
#   KOHLAB_REPO       git remote to install from      (default the public repo)
#   KOHLAB_BIN_DIR    where the command is installed  (default /usr/local/bin)
#   KOHLAB_UNIT_DIR   where the unit is written       (default /etc/systemd/system)
#   KOHLAB_PORT       dashboard port                  (default 7676)
#   KOHLAB_KEY        access key, same as --key
#
# Idempotent. Re-running updates the checkout and leaves an existing service,
# access key and unit file exactly as they are.

set -euo pipefail

KOHLAB_HOME="${KOHLAB_HOME:-$HOME/kohlab}"
KOHLAB_REPO="${KOHLAB_REPO:-https://github.com/nzkbuild/kohlab.git}"
KOHLAB_BIN_DIR="${KOHLAB_BIN_DIR:-/usr/local/bin}"
KOHLAB_UNIT_DIR="${KOHLAB_UNIT_DIR:-/etc/systemd/system}"
PORT="${KOHLAB_PORT:-7676}"
KEY="${KOHLAB_KEY:-}"
WITH_SYSTEMD=1
WITH_COMMAND=1
UNINSTALL=0
UNIT=kohlab.service

log()  { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# Defined here, not in the step that first needs it: with --no-command that step
# is skipped, and a function defined inside a skipped branch does not exist.
as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --key) KEY="${2:-}"; [ -n "$KEY" ] || die "--key needs a value"; shift 2 ;;
    --no-systemd) WITH_SYSTEMD=0; shift ;;
    --no-command) WITH_COMMAND=0; shift ;;
    -h|--help) sed -n '2,26p' "${BASH_SOURCE[0]}" | cut -c3-; exit 0 ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

# ── uninstall ────────────────────────────────────────────────────────────────
# Handled before anything else, because uninstalling must not require bun, git,
# or a checkout to still be there. Deliberately non-destructive: stopping the
# service and deleting somebody's workspaces are different requests, and only one
# of them is usually what was meant.
if [ "$UNINSTALL" -eq 1 ]; then
  step "uninstall — service only; your data is left alone"
  echo "This stops kohlab and removes $KOHLAB_UNIT_DIR/$UNIT."
  echo "Your checkout ($KOHLAB_HOME) and state directory are NOT touched."
  printf 'Continue? [y/N] '
  read -r reply
  case "$reply" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "cancelled — nothing changed"; exit 0 ;;
  esac
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl list-unit-files "$UNIT" >/dev/null 2>&1 && systemctl is-enabled "$UNIT" >/dev/null 2>&1; then
      as_root systemctl disable --now "$UNIT" || warn "could not stop $UNIT — stop it by hand"
      log "service stopped and disabled"
    else
      warn "$UNIT was not installed as a service"
    fi
  fi
  if [ -f "$KOHLAB_UNIT_DIR/$UNIT" ]; then
    as_root rm -f "$KOHLAB_UNIT_DIR/$UNIT"
    as_root systemctl daemon-reload 2>/dev/null || true
    log "unit file removed"
  fi
  if [ "$WITH_COMMAND" -eq 1 ] && [ -e "$KOHLAB_BIN_DIR/kohlab" ]; then
    as_root rm -f "$KOHLAB_BIN_DIR/kohlab"
    log "the kohlab command was removed from $KOHLAB_BIN_DIR"
  fi
  # Nothing supervises the daemon, so nothing else would ever stop it. It is
  # holding agent PTYs; leaving it running after an uninstall is a surprise.
  if pkill -f 'pty-daemon.cjs' 2>/dev/null; then
    log "the pty daemon was stopped (any live agent sessions went with it)"
  fi
  echo
  echo "Kept: $KOHLAB_HOME"
  echo "Kept: your state directory — find it with 'kohlab status', or see docs/uninstall.md"
  echo "To remove everything: rm -rf $KOHLAB_HOME \$WORKS_DIR"
  exit 0
fi

[ "$(uname -s)" = "Linux" ] || warn "this installer targets Linux; on macOS, run the steps by hand (docs/install.md)"

# ── 1. dependencies ──────────────────────────────────────────────────────────
step "1/6  dependencies"

command -v git >/dev/null 2>&1 || die "git is required: apt-get install -y git (or your package manager)"
log "git $(git --version | awk '{print $3}')"

if ! command -v bun >/dev/null 2>&1; then
  warn "bun is not installed — installing it from bun.sh"
  curl -fsSL https://bun.sh/install | bash
  # the installer writes to $HOME/.bun/bin, which this shell has not sourced
  export PATH="$HOME/.bun/bin:$PATH"
  command -v bun >/dev/null 2>&1 || die "bun install did not put bun on PATH — open a new shell and re-run"
fi
BUN="$(command -v bun)"
log "bun $("$BUN" --version)"

# ── 2. checkout ──────────────────────────────────────────────────────────────
step "2/6  checkout — $KOHLAB_HOME"

if [ -d "$KOHLAB_HOME/.git" ]; then
  log "found an existing checkout — updating it"
  # A deployment that has local commits is a deliberate state, not an installer
  # error: warn and leave it. `kohlab update` is the supported way to move it.
  git -C "$KOHLAB_HOME" pull --ff-only || warn "could not fast-forward (local commits?) — leaving the checkout alone"
else
  [ -e "$KOHLAB_HOME" ] && die "$KOHLAB_HOME exists and is not a git checkout — move it aside, or set KOHLAB_HOME"
  log "cloning $KOHLAB_REPO"
  git clone "$KOHLAB_REPO" "$KOHLAB_HOME"
fi
log "at $(git -C "$KOHLAB_HOME" rev-parse --short HEAD) ($(git -C "$KOHLAB_HOME" rev-parse --abbrev-ref HEAD))"

# ── 3. dependencies + dashboard ──────────────────────────────────────────────
step "3/6  install — dependencies and the dashboard"

( cd "$KOHLAB_HOME" && "$BUN" install --silent )
log "backend dependencies"
( cd "$KOHLAB_HOME/web" && "$BUN" install --silent && "$BUN" run build >/dev/null )
log "frontend dependencies + dashboard build"

# ── 4. the command ───────────────────────────────────────────────────────────
step "4/6  command — kohlab on the PATH"

if [ "$WITH_COMMAND" -eq 1 ]; then
  # A wrapper, not a symlink: the entry point's shebang is `#!/usr/bin/env bun`,
  # and bun lives in a directory that only interactive shells put on PATH. An
  # absolute interpreter path is what makes `kohlab` work from cron, from a
  # systemd unit, and from `ssh host kohlab ...`.
  WRAPPER="#!/bin/sh
# kohlab — generated by install.sh; re-run it to refresh this path.
exec \"$BUN\" run \"$KOHLAB_HOME/cli.ts\" \"\$@\""

  mkdir -p "$KOHLAB_BIN_DIR" 2>/dev/null || as_root mkdir -p "$KOHLAB_BIN_DIR"
  TARGET="$KOHLAB_BIN_DIR/kohlab"
  if [ -e "$TARGET" ] && ! grep -q "kohlab — generated by install.sh" "$TARGET" 2>/dev/null; then
    warn "$TARGET already exists and was not written by this installer — leaving it alone"
  else
    printf '%s\n' "$WRAPPER" > "$TARGET" 2>/dev/null || printf '%s\n' "$WRAPPER" | as_root tee "$TARGET" >/dev/null
    as_root chmod 755 "$TARGET"
    log "$TARGET"
  fi
  case ":$PATH:" in
    *":$KOHLAB_BIN_DIR:"*) ;;
    *) warn "$KOHLAB_BIN_DIR is not on your PATH — add it, or call $TARGET by full path" ;;
  esac
else
  warn "skipped (--no-command)"
fi

# ── 5. service ───────────────────────────────────────────────────────────────
step "5/6  service — $UNIT"

if [ "$WITH_SYSTEMD" -eq 0 ]; then
  warn "skipped (--no-systemd) — run it in the foreground with: kohlab serve"
else
  if [ -f "$KOHLAB_UNIT_DIR/$UNIT" ]; then
    log "keeping the existing $KOHLAB_UNIT_DIR/$UNIT"
    warn "the access key for that server is in $KOHLAB_UNIT_DIR/$UNIT (KOHLAB_KEY=)"
  else
    if [ -z "$KEY" ]; then
      if command -v openssl >/dev/null 2>&1; then
        KEY="$(openssl rand -hex 24)"
      else
        KEY="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-48)"
      fi
      log "generated an access key"
    fi
    mkdir -p "$KOHLAB_UNIT_DIR" 2>/dev/null || true
    cat > "$KOHLAB_UNIT_DIR/$UNIT" <<EOF
[Unit]
Description=Kohlab — persistent AI agent workspace server
After=network.target

[Service]
Type=simple
ExecStart=$BUN run $KOHLAB_HOME/server.ts
WorkingDirectory=$KOHLAB_HOME
Environment=WORKS_DIR=$KOHLAB_HOME/.works
Environment=PORT=$PORT
Environment=KOHLAB_KEY=$KEY
Restart=always
RestartSec=2
# The PTY daemon is spawned detached on purpose, so it outlives the server and
# keeps every agent session alive across a restart. systemd's default
# KillMode=control-group signals the whole unit cgroup, which would kill that
# daemon and take every live agent with it. Signal only the server.
KillMode=process
User=$(id -un)

[Install]
WantedBy=multi-user.target
EOF
    log "wrote $KOHLAB_UNIT_DIR/$UNIT"
    # Shown once, on purpose. Without this the person who just installed the
    # server has to go read the unit file to log in — the initiator is the one
    # person who must never be locked out of the box they just built.
    cat <<EOF

  Access key — shown once, also stored in $KOHLAB_UNIT_DIR/$UNIT:

      $KEY

  Save it now. The dashboard asks for it the first time you open it.
EOF
  fi

  if [ "$KOHLAB_UNIT_DIR" = "/etc/systemd/system" ] && command -v systemctl >/dev/null 2>&1; then
    as_root systemctl daemon-reload
    as_root systemctl enable --now "$UNIT"
    sleep 2
    if systemctl is-active --quiet "$UNIT"; then
      log "$UNIT is running on port $PORT"
    else
      warn "$UNIT did not come up — journalctl -u $UNIT -n 40"
    fi
  else
    warn "not starting it: $KOHLAB_UNIT_DIR is not the systemd directory. Wire it up yourself (docs/systemd.md)"
  fi
fi

# ── 6. verify ────────────────────────────────────────────────────────────────
step "6/6  verify"

# Verify the artifact this run installed, not whatever `kohlab` happened to be
# on PATH already — a wrapper with the wrong interpreter path is exactly the
# kind of thing an installer must catch.
if [ "$WITH_COMMAND" -eq 1 ] && [ -x "$KOHLAB_BIN_DIR/kohlab" ]; then
  if "$KOHLAB_BIN_DIR/kohlab" version; then
    log "$KOHLAB_BIN_DIR/kohlab works"
  else
    die "$KOHLAB_BIN_DIR/kohlab is broken — check that $BUN still exists"
  fi
fi

KOHLAB="$(command -v kohlab || true)"
if [ -n "$KOHLAB" ]; then
  "$KOHLAB" doctor || true
else
  "$BUN" run "$KOHLAB_HOME/cli.ts" doctor || true
fi

cat <<EOF

$(log "done — kohlab is installed at $KOHLAB_HOME")

  kohlab status      what is installed and what is running
  kohlab open        the dashboard URL for this machine
  kohlab create ~/my-project "fix the billing bug" claude
  kohlab update      update kohlab; running agents keep running

  docs: $KOHLAB_HOME/docs/install.md  ·  $KOHLAB_HOME/docs/upgrade.md
EOF
