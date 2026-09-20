#!/usr/bin/env bash
# kohlab updater — save → check → download → install → build → reload.
#
#   bash scripts/update.sh          update this checkout, then reload the service
#   bash scripts/update.sh --check  say what would happen, change nothing
#   bash scripts/update.sh --force  reload even if KillMode would kill live agents
#   KOHLAB_UNIT=other bash scripts/update.sh    use a different systemd unit
#
# Running agents are NOT interrupted. Workspaces are separate git worktrees with
# their own branches, so nothing here touches an agent's files; and the reload
# restarts only the server process, leaving the detached PTY daemon — every live
# session — running (that is what KillMode=process in the unit is for).
#
# Your work is not the updater's collateral either. Uncommitted changes go to the
# stash before anything is downloaded (HEAD never moves, because a new workspace
# branches from wherever HEAD points); commits that were never pushed are pushed.
# If install, build or reload fails, the checkout returns to the commit it
# started from, is rebuilt, and is reloaded — so the known-good version is what
# is actually serving.
#
# Versioning lives in package.json (`version`). What counts as "an update" is
# always commits behind @{u}; versions are only reported, and a downgrade is
# refused.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT="${KOHLAB_UNIT:-kohlab}"
CHECK=0
FORCE=0

for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}" | cut -c3-; exit 0 ;;
    *) echo "unknown flag: $arg (try --check, --force, --help)" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
log()  { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

pkg_version() {
  V_FILE="$1" bun -e 'const fs=require("fs");process.stdout.write(String(JSON.parse(fs.readFileSync(process.env.V_FILE,"utf8")).version??"?"))'
}

command -v git >/dev/null 2>&1 || die "git is required"
command -v bun >/dev/null 2>&1 || die "bun is required: curl -fsSL https://bun.sh/install | bash"

TMP="$(mktemp -d)"

# OTA mode: the dashboard runs this with KOHLAB_OTA=1 and sends our stdout to
# $WORKS_DIR/update.log. These two markers are how it tells "running" from
# "finished, exit N" afterwards — the reload restarts the server that spawned us
# before we finish, so nothing in memory survives to report the outcome.
# Both live in ONE trap: a second `trap ... EXIT` would replace the cleanup.
cleanup() {
  local code=$?
  rm -rf "$TMP"
  if [ "${KOHLAB_OTA:-0}" = "1" ]; then
    printf '# kohlab update finished %s000 exit %s\n' "$(date +%s)" "$code"
  fi
}
trap cleanup EXIT

if [ "${KOHLAB_OTA:-0}" = "1" ]; then
  printf '# kohlab update started %s000 pid %s\n' "$(date +%s)" "$$"
fi

cd "$REPO"
git rev-parse --git-dir >/dev/null 2>&1 || die "$REPO is not a git checkout — update it the way you installed it"
git config --get remote.origin.url >/dev/null 2>&1 || die "no 'origin' remote in $REPO — there is nothing to update from"

CURRENT="$(git rev-parse --abbrev-ref HEAD)"
UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
[ -n "$UPSTREAM" ] || die "'$CURRENT' has no upstream — set one with: git push -u origin $CURRENT"
REMOTE_BRANCH="${UPSTREAM#origin/}"

step "kohlab update — $REPO · $CURRENT ← $UPSTREAM"

# ── what the unit looks like ─────────────────────────────────────────────────
# Read once, up front: the state backup needs WORKS_DIR, the health probe needs
# PORT, and the reload needs to know whether the unit is running at all.
UNIT_ACTIVE=0
UNIT_KILLMODE=""
UNIT_PORT="7676"
UNIT_WORKS=""
RESTART=()

if command -v systemctl >/dev/null 2>&1; then
  UENV="$(systemctl show "$UNIT" -p Environment 2>/dev/null || true)"
  # systemd merges every Environment= line into ONE line, so WORKS_DIR can sit
  # anywhere on it. Matching only at the start of a space-split token silently
  # finds nothing — and the backup that follows would protect the wrong path.
  UNIT_WORKS="$(printf '%s' "$UENV" | sed -n 's/.*WORKS_DIR=\([^ ]*\).*/\1/p' | tail -1)"
  UNIT_PORT="$(printf '%s' "$UENV" | tr ' ' '\n' | sed -n 's/^Environment=//; s/^PORT=//p' | head -1)"
  UNIT_PORT="${UNIT_PORT:-7676}"
  UNIT_KILLMODE="$(systemctl show "$UNIT" -p KillMode 2>/dev/null | sed 's/^KillMode=//' || true)"
  if systemctl is-active -q "$UNIT" 2>/dev/null; then
    UNIT_ACTIVE=1
    if [ "$(id -u)" -eq 0 ]; then
      RESTART=(systemctl restart "$UNIT")
    elif command -v sudo >/dev/null 2>&1; then
      RESTART=(sudo systemctl restart "$UNIT")
    fi
  fi
fi
UNIT_WORKS="${UNIT_WORKS:-${WORKS_DIR:-}}"

# `systemctl is-active` is not a health check: the unit is Type=simple, so systemd
# calls it active the moment the process forks, and Restart=always keeps it
# active through a crash loop. Probe the port that is actually being served.
PROBE_TRIES="${KOHLAB_PROBE_TRIES:-12}"
PROBE_WAIT="${KOHLAB_PROBE_WAIT:-1}"

probe() {
  P="$UNIT_PORT" bun -e 'fetch("http://127.0.0.1:"+process.env.P+"/",{redirect:"manual"}).then(r=>process.exit(r.status<400?0:1)).catch(()=>process.exit(1))' 2>/dev/null
}

health_ok() {
  local i
  i=1
  while [ "$i" -le "$PROBE_TRIES" ]; do
    if probe; then return 0; fi
    sleep "$PROBE_WAIT"
    i=$((i + 1))
  done
  return 1
}

STAMP="$(date +%Y%m%d-%H%M%S)"
STASH_MSG=""
BACKUP=""

# ── 1. save ──────────────────────────────────────────────────────────────────
step "1/5  save — your work first, before anything is downloaded"

if [ -n "$(git status --porcelain)" ]; then
  CHANGED="$(git status --porcelain | wc -l | tr -d ' ')"
  STASH_MSG="kohlab update autosave $STAMP"
  warn "$CHANGED uncommitted path(s) — saving them to the stash first"
  if [ "$CHECK" -eq 1 ]; then
    warn "--check: leaving them where they are"
  else
    # Stash rather than an autosave branch: HEAD must not move. Workspaces are
    # git worktrees of this repo and `git worktree add` branches from whatever
    # HEAD points at, so a HEAD parked on a side branch mid-update could hand a
    # newly created agent the wrong base. A stash also leaves nothing behind on
    # origin.
    git -c "user.name=$(git config user.name || echo kohlab-update)" \
        -c "user.email=$(git config user.email || echo kohlab@localhost)" \
        stash push -q -u -m "$STASH_MSG"
    log "stashed: $STASH_MSG"
    log "recover your work with:  git stash pop"
  fi
else
  log "no uncommitted changes"
fi

AHEAD="$(git rev-list --count "$UPSTREAM..HEAD" 2>/dev/null || echo 0)"
if [ "$AHEAD" -gt 0 ]; then
  warn "$AHEAD commit(s) on $CURRENT were never pushed"
  if [ "$CHECK" -eq 1 ]; then
    warn "--check: not pushing"
  elif git push -q origin "$CURRENT" 2>/dev/null; then
    log "pushed $AHEAD commit(s) → $UPSTREAM"
  else
    warn "could not push (no credentials, or $UPSTREAM moved) — they exist only on this box"
  fi
fi

# ── 2. check ─────────────────────────────────────────────────────────────────
step "2/5  check — is there a new version?"

git fetch -q origin "$REMOTE_BRANCH" || die "git fetch failed — no network, or no access to $(git config --get remote.origin.url)"
git show "$UPSTREAM:package.json" > "$TMP/remote-package.json" || die "$UPSTREAM has no package.json — is $REMOTE_BRANCH the right upstream?"

LOCAL_V="$(pkg_version package.json)"
REMOTE_V="$(pkg_version "$TMP/remote-package.json")"

log "here   v$LOCAL_V  ($(git rev-parse --short HEAD))"
log "remote v$REMOTE_V  ($(git rev-parse --short "$UPSTREAM"))"

# Commits behind upstream decide this — never the version strings. A version
# that is merely different could be *older*, and pulling it would rewind over
# commits you have not pushed yet.
PENDING="$(git rev-list --count "HEAD..$UPSTREAM")"
if [ "$PENDING" -eq 0 ]; then
  step "already up to date — v$LOCAL_V, nothing to download (nothing changed)"
  exit 0
fi

NEWER="$(printf '%s\n%s\n' "$LOCAL_V" "$REMOTE_V" | sort -V 2>/dev/null | tail -1 || true)"
if [ "$NEWER" = "$LOCAL_V" ] && [ "$REMOTE_V" != "$LOCAL_V" ]; then
  die "upstream is v$REMOTE_V and you are on v$LOCAL_V — refusing to go backwards. Push your commits first: git push origin $CURRENT"
fi

log "$PENDING commit(s) available: v$LOCAL_V → v$REMOTE_V"

if [ "$CHECK" -eq 1 ]; then
  git --no-pager log --oneline "HEAD..$UPSTREAM" | sed 's/^/      /'
  step "--check — nothing downloaded, installed or restarted"
  exit 0
fi

# ── 3. download ──────────────────────────────────────────────────────────────
step "3/5  download — $CURRENT ← $UPSTREAM"

# Back up the small state files a bad migration could damage. Not the whole
# WORKS_DIR: the checkout cannot touch it, and it can be large. Kept on disk
# afterwards until you delete it.
if [ -n "$UNIT_WORKS" ] && [ -d "$UNIT_WORKS" ]; then
  KEEP=""
  for f in state.json users.json audit.log; do
    if [ -f "$UNIT_WORKS/$f" ]; then KEEP="$KEEP $f"; fi
  done
  if [ -n "$KEEP" ]; then
    BACKUP="$(dirname "$UNIT_WORKS")/kohlab-state-$STAMP.tgz"
    # shellcheck disable=SC2086
    tar czf "$BACKUP" -C "$UNIT_WORKS" $KEEP && log "state backed up → $BACKUP"
  fi
else
  warn "no WORKS_DIR found (unit not installed?) — skipping the state backup"
fi

PRE="$(git rev-parse HEAD)"
RELOADED=0

rollback() {
  warn "rolling the checkout back to $(git rev-parse --short "$PRE")"
  # Only this working tree moves. Worktrees of this repo (every workspace) have
  # their own HEAD and branches, so no agent's files are touched.
  git reset -q --hard "$PRE"
  bun install --silent >/dev/null 2>&1 || warn "rollback: bun install failed"
  ( cd web && bun install --silent >/dev/null 2>&1 && bun run build >/dev/null 2>&1 ) || warn "rollback: dashboard rebuild failed"
  log "restored to v$(pkg_version package.json)"
  # Files on disk are not enough if the new build already reached the unit: the
  # running process would still be the new one. Restart so the rollback is real.
  if [ "$RELOADED" -eq 1 ] && [ "${#RESTART[@]}" -gt 0 ]; then
    warn "restarting $UNIT so the restored build is the one serving"
    "${RESTART[@]}" >/dev/null 2>&1 || warn "rollback: restart failed"
    if health_ok; then
      log "$UNIT is serving v$(pkg_version package.json) again"
    else
      warn "$UNIT is not answering on port $UNIT_PORT even on the restored build"
    fi
  fi
}

if ! git merge -q --ff-only "$UPSTREAM"; then
  die "cannot fast-forward: $CURRENT and $UPSTREAM have diverged. Push your commits (git push origin $CURRENT), then re-run — do not reset, that would discard them."
fi
AFTER="$(git rev-parse HEAD)"
AFTER_V="$(pkg_version package.json)"
log "downloaded $(git rev-list --count "$PRE..$AFTER") commit(s): v$LOCAL_V → v$AFTER_V"

# ── 4. install ───────────────────────────────────────────────────────────────
step "4/5  install — dependencies and the dashboard"

if ! bun install --silent; then
  rollback
  die "bun install failed — nothing was reloaded"
fi
log "backend dependencies"

if ! ( cd web && bun install --silent && bun run build ); then
  rollback
  die "frontend install/build failed — nothing was reloaded"
fi
log "frontend dependencies + dashboard build"

# ── 5. reload ────────────────────────────────────────────────────────────────
step "5/5  reload — $UNIT"

if [ "$UNIT_ACTIVE" -ne 1 ]; then
  log "v$AFTER_V installed; $UNIT is not running under systemd"
  warn "start your server to pick it up:  cd $REPO && bun run cli.ts server"
  exit 0
fi

if [ "${#RESTART[@]}" -eq 0 ]; then
  die "not root and no sudo. v$AFTER_V is installed — reload it yourself: systemctl restart $UNIT"
fi

if [ "$UNIT_KILLMODE" != "process" ] && [ "$FORCE" -ne 1 ]; then
  warn "$UNIT has KillMode=$UNIT_KILLMODE. Restarting signals the whole unit cgroup, which kills the detached PTY daemon — and every live agent session with it."
  warn "Add KillMode=process to the unit (docs/systemd.md), or re-run with --force to accept the loss."
  die "v$AFTER_V is installed; only the reload is pending"
fi

if ! "${RESTART[@]}"; then
  rollback
  die "reload failed — check: journalctl -u $UNIT -n 40"
fi
RELOADED=1

if ! health_ok; then
  warn "$UNIT restarted but nothing answered on http://127.0.0.1:$UNIT_PORT/ within 12s"
  warn "journalctl -u $UNIT -n 40"
  rollback
  die "v$AFTER_V did not come up"
fi
log "$UNIT is serving v$AFTER_V on port $UNIT_PORT"

step "done — v$LOCAL_V → v$AFTER_V"
git --no-pager log --oneline "$PRE..$AFTER" | sed 's/^/      /'
log "agents were not interrupted — verify with:  cd $REPO && bun run cli.ts ls"
if [ -n "$STASH_MSG" ]; then
  warn "your uncommitted work is in the stash:  git stash pop"
fi
if [ -n "$BACKUP" ]; then
  warn "state backup kept at $BACKUP — delete it once you are happy"
fi
exit 0
