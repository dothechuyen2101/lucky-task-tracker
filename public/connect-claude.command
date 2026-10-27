#!/usr/bin/env bash
# Task Tracker — connect your Claude subscription (macOS / Linux).
#
# Uses the Claude plan you already pay for. Does NOT create an API key and
# does not cost anything extra.
#
#   curl -fsSL <your-task-tracker-url>/connect-claude.sh | bash
#
# or download it and run:  bash connect-claude.sh

set -uo pipefail

echo
echo "  ========================================================"
echo "    Task Tracker  -  connect your Claude subscription"
echo "  ========================================================"
echo
echo "  1. Installs Claude Code, if you do not already have it"
echo "  2. Opens your browser so you can sign in to Claude"
echo "  3. Prints your connection token (and copies it, on macOS)"
echo
echo "  Nothing is sent anywhere by this script. You paste the"
echo "  token into Task Tracker yourself."
echo

CLAUDE_BIN=""
if command -v claude >/dev/null 2>&1; then
  CLAUDE_BIN="claude"
elif [ -x "$HOME/.local/bin/claude" ]; then
  CLAUDE_BIN="$HOME/.local/bin/claude"
fi

if [ -z "$CLAUDE_BIN" ]; then
  echo "  Claude Code is not installed. Installing it now..."
  echo
  curl -fsSL https://claude.ai/install.sh | bash
  export PATH="$HOME/.local/bin:$PATH"

  if command -v claude >/dev/null 2>&1; then
    CLAUDE_BIN="claude"
  elif [ -x "$HOME/.local/bin/claude" ]; then
    CLAUDE_BIN="$HOME/.local/bin/claude"
  fi
fi

if [ -z "$CLAUDE_BIN" ]; then
  echo
  echo "  >> Could not install Claude Code automatically."
  echo "     Install it, then run this again:"
  echo
  echo "       curl -fsSL https://claude.ai/install.sh | bash"
  echo
  exit 1
fi

echo "  Claude Code is ready."
echo
echo "  --------------------------------------------------------"
echo "  Your browser is about to open. Sign in and approve."
echo "  --------------------------------------------------------"
echo

# tee so the interactive flow stays visible while we keep a copy to extract
# from — Claude Code prints the token once and stores it nowhere.
CAPTURE="$(mktemp)"
trap 'rm -f "$CAPTURE"' EXIT

"$CLAUDE_BIN" setup-token 2>&1 | tee "$CAPTURE"

TOKEN="$(grep -oE 'sk-ant-oat[A-Za-z0-9_-]+' "$CAPTURE" | head -1 || true)"

echo
echo "  ========================================================"
if [ -n "$TOKEN" ]; then
  if command -v pbcopy >/dev/null 2>&1; then
    printf '%s' "$TOKEN" | pbcopy
    echo "    Done. Token COPIED TO YOUR CLIPBOARD."
  elif command -v xclip >/dev/null 2>&1; then
    printf '%s' "$TOKEN" | xclip -selection clipboard
    echo "    Done. Token COPIED TO YOUR CLIPBOARD."
  else
    echo "    Done. Your token:"
    echo
    echo "    $TOKEN"
  fi
  echo "  ========================================================"
  echo
  echo "    Paste it into Task Tracker Settings → Your Claude."
  echo "    Starts with: ${TOKEN:0:14}..."
else
  echo "    Could not read the token automatically."
  echo "  ========================================================"
  echo
  echo "    Look above for a line starting with  sk-ant-oat"
  echo "    and copy it by hand."
fi
echo
echo "  Keep this token private - it works like a password for"
echo "  your Claude account."
echo
