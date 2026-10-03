#!/usr/bin/env bash
# Copy a kohlab backup to another machine, so losing this one does not lose the state.
#
#   KOHLAB_BACKUP_DEST=user@host:backups/kohlab/ bash scripts/backup-offbox.sh
#   KOHLAB_BACKUP_VIA=rclone KOHLAB_BACKUP_DEST=remote:kohlab bash scripts/backup-offbox.sh
#
# Uploads only; the destination keeps every archive until you prune it there.
set -euo pipefail

DEST="${KOHLAB_BACKUP_DEST:?set KOHLAB_BACKUP_DEST, e.g. user@host:backups/kohlab/ (rsync) or remote:path (rclone)}"
VIA="${KOHLAB_BACKUP_VIA:-rsync}"
KOHLAB="${KOHLAB_BIN:-kohlab}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
file="$tmp/kohlab-$(date +%Y%m%d-%H%M%S).tar.gz"

# shellcheck disable=SC2086  # KOHLAB_BIN may be a command with arguments
$KOHLAB backup "$file" >/dev/null
case "$VIA" in
  rsync)  rsync -a --chmod=F600 "$file" "$DEST" ;;
  rclone) rclone copy "$file" "$DEST" ;;
  *) echo "KOHLAB_BACKUP_VIA must be rsync or rclone" >&2; exit 2 ;;
esac
echo "kohlab backup sent to $DEST ($(basename "$file"))"
