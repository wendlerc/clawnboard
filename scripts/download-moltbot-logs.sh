#!/usr/bin/env bash
# Download OpenClaw logs from all moltbots via fly ssh sftp.
#
# Log locations (discovered via SSH):
#   /data/agents/main/sessions/ - Chat/conversation logs (JSONL per session, persistent)
#   /tmp/openclaw/             - OpenClaw gateway logs (openclaw-YYYY-MM-DD.log, JSONL)
#   /data/cron/runs/           - Cron job run logs (JSONL)
#
# Usage: ./scripts/download-moltbot-logs.sh [output-dir]
# Default output: ./logs/moltbot-YYYY-MM-DD/

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="${1:-$REPO_ROOT/logs/moltbot-$(date +%Y-%m-%d)}"

# Get moltbot app names (moltbot-*)
APPS=$(fly apps list 2>/dev/null | awk '/moltbot-/ {print $1}' || true)
if [ -z "$APPS" ]; then
  echo "No moltbot apps found. Run 'fly auth login' if needed."
  exit 1
fi

echo "Downloading OpenClaw logs to: $OUTPUT_DIR"
echo "Apps: $APPS"
echo ""

for APP in $APPS; do
  APP_DIR="$OUTPUT_DIR/$APP"
  mkdir -p "$APP_DIR"

  echo "=== $APP ==="

  # /data/agents/main/sessions/ - chat logs (JSONL per session)
  echo "  Downloading /data/agents/main/sessions/ (chat logs) ..."
  if [ -d "$APP_DIR/sessions" ]; then
    rm -rf "$APP_DIR/sessions"
  fi
  if fly ssh sftp get -a "$APP" -R /data/agents/main/sessions "$APP_DIR/sessions" 2>/dev/null; then
    echo "  ✓ chat logs (sessions) saved"
  else
    echo "  ✗ sessions failed"
  fi

  # /tmp/openclaw/ - gateway logs (daily rolling files, JSONL)
  # Download each file individually (recursive fails if dest exists; single files more reliable)
  echo "  Downloading /tmp/openclaw/ ..."
  mkdir -p "$APP_DIR/openclaw"
  FILES=$(fly ssh console -a "$APP" -C "ls /tmp/openclaw/" 2>/dev/null | grep -E 'openclaw-[0-9]{4}-[0-9]{2}-[0-9]{2}\.log$' || true)
  if [ -n "$FILES" ]; then
    for F in $FILES; do
      if fly ssh sftp get -a "$APP" "/tmp/openclaw/$F" "$APP_DIR/openclaw/$F" 2>/dev/null; then
        echo "    ✓ $F"
      fi
    done
  else
    echo "  (no openclaw logs - app may be suspended)"
  fi

  # /data/cron/runs/ - cron job logs (persistent, JSONL)
  # Use recursive get - dest must not exist (fly sftp won't overwrite)
  echo "  Downloading /data/cron/runs/ ..."
  if [ -d "$APP_DIR/cron-runs" ]; then
    rm -rf "$APP_DIR/cron-runs"
  fi
  if fly ssh sftp get -a "$APP" -R /data/cron/runs "$APP_DIR/cron-runs" 2>/dev/null; then
    echo "  ✓ cron runs saved"
  else
    echo "  ✗ cron-runs failed"
  fi

  echo ""
done

echo "Done. Logs saved to $OUTPUT_DIR"
