#!/bin/bash
# ==============================================================================
# Sihali Khurd Election 2026 - Automatic GitHub Sync Watchdog
# Checks GitHub repository for new commits every minute and auto-deploys
# ==============================================================================

DIR="/home/patrikryian/sihali-whatsapp-campaign-bot"
if [ ! -d "$DIR" ]; then
    DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

cd "$DIR" || exit 1

# Silently fetch latest commits
git fetch origin main > /dev/null 2>&1

LOCAL=$(git rev-parse HEAD 2>/dev/null)
REMOTE=$(git rev-parse origin/main 2>/dev/null)

if [ -n "$LOCAL" ] && [ -n "$REMOTE" ] && [ "$LOCAL" != "$REMOTE" ]; then
    TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$TIMESTAMP] 🚀 New GitHub commit detected! ($LOCAL -> $REMOTE)"
    git pull origin main
    pm2 restart whatsapp-bot
    echo "[$TIMESTAMP] ✅ Bot updated and PM2 reloaded successfully!"
fi
