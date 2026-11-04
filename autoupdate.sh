#!/usr/bin/env bash
# Safe GitHub deployment watchdog.
# The running bot already checks for updates every 35 seconds; this script is
# also available for cron/systemd recovery or a one-time manual sync.

set -u

APP_DIR="${APP_DIR:-/home/patrikryian/sihali-whatsapp-campaign-bot}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-codex/production-readiness}"
PM2_APP="${PM2_APP:-whatsapp-bot}"

if [ ! -d "$APP_DIR/.git" ]; then
    APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

cd "$APP_DIR" || exit 1

check_and_sync() {
    git fetch origin "$DEPLOY_BRANCH" >/dev/null 2>&1 || return 1

    local local_hash remote_hash remote_ahead timestamp
    local_hash="$(git rev-parse HEAD 2>/dev/null)" || return 1
    remote_hash="$(git rev-parse "origin/$DEPLOY_BRANCH" 2>/dev/null)" || return 1
    remote_ahead="$(git rev-list --count "HEAD..origin/$DEPLOY_BRANCH" 2>/dev/null)" || return 1

    [ "$remote_ahead" -gt 0 ] || return 0

    timestamp="$(date '+%Y-%m-%d %H:%M:%S')"
    echo "[$timestamp] Updating $DEPLOY_BRANCH (${local_hash:0:7} -> ${remote_hash:0:7})"

    if ! git merge --ff-only "origin/$DEPLOY_BRANCH"; then
        echo "[$timestamp] Update stopped: the VM branch is not a clean fast-forward." >&2
        return 1
    fi

    npm ci --omit=dev || return 1
    mkdir -p "$HOME/.fonts" "$HOME/.local/share/fonts"
    cp media/*.ttf "$HOME/.fonts/" 2>/dev/null || true
    cp media/*.ttf "$HOME/.local/share/fonts/" 2>/dev/null || true
    fc-cache -f "$HOME/.fonts" 2>/dev/null || true
    pm2 restart "$PM2_APP" --update-env || return 1
    pm2 save >/dev/null || true
    echo "[$timestamp] Update complete: $(git rev-parse --short HEAD)"
}

if [ "${1:-}" = "--daemon" ]; then
    echo "Watching origin/$DEPLOY_BRANCH every 35 seconds..."
    while true; do
        check_and_sync
        sleep 35
    done
else
    check_and_sync
fi
