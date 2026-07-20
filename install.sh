#!/usr/bin/env bash
# agent-recall installer — idempotent, reversible. Flags: --uninstall, --human-only
set -euo pipefail
umask 077

REPO="$(cd "$(dirname "$0")" && pwd)"
ROOT="${RECALL_HOME:-$HOME/Library/Application Support/AgentRecall}"
BIN="$ROOT/bin"; STATE="$ROOT/state"; BACKUPS="$STATE/install-backups"
WRAPPER="$HOME/.local/bin/recall"
PLIST="$HOME/Library/LaunchAgents/local.agent-recall.sync.plist"
LABEL="local.agent-recall.sync"
NODE_BIN="$(command -v node)"
MARK_BEGIN='<!-- BEGIN agent-recall -->'
MARK_END='<!-- END agent-recall -->'
AGENT_FILES=("$HOME/.claude/CLAUDE.md" "$HOME/.claude-second/CLAUDE.md" "$HOME/.codex/AGENTS.md" "$HOME/.grok/AGENTS.md" "$HOME/.pi/agent/AGENTS.md")
SKILL_DIRS=("$HOME/.claude/skills" "$HOME/.claude-second/skills" "$HOME/.agents/skills" "$HOME/.kimi-code/skills")

[ "$(id -u)" -eq 0 ] && { echo "refusing to run as root"; exit 1; }
[ -n "$NODE_BIN" ] || { echo "node required"; exit 1; }

remove_block() { # $1=file
  [ -f "$1" ] || return 0
  awk -v b="$MARK_BEGIN" -v e="$MARK_END" '$0==b{skip=1} !skip{print} $0==e{skip=0}' "$1" > "$1.tmp" && mv "$1.tmp" "$1"
}
append_block() { # $1=file
  mkdir -p "$(dirname "$1")"; touch "$1"
  remove_block "$1"
  { echo ""; cat "$REPO/integration/agents-block.md"; } >> "$1"
}

uninstall() {
  echo "uninstalling agent-recall (data preserved at $ROOT)"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST" "$WRAPPER"
  for f in "${AGENT_FILES[@]}"; do remove_block "$f"; done
  for d in "${SKILL_DIRS[@]}"; do [ -L "$d/agent-recall" ] && rm "$d/agent-recall"; done
  # restore retention only if still our value
  for pair in "claude-primary:$HOME/.claude/settings.json" "claude-second:$HOME/.claude-second/settings.json"; do
    name="${pair%%:*}"; f="${pair#*:}"; b="$BACKUPS/$name.json"
    if [ -f "$b" ] && [ -f "$f" ] && [ "$(jq -r '.cleanupPeriodDays // empty' "$f")" = "36500" ]; then
      if [ "$(jq -r '.had' "$b")" = "true" ]; then
        jq --argjson v "$(jq '.value' "$b")" '.cleanupPeriodDays = $v' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
      else
        jq 'del(.cleanupPeriodDays)' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
      fi
    fi
  done
  echo "done. Archive/index/memory kept. Remove manually if desired: rm -rf \"$ROOT\""
  exit 0
}
[ "${1:-}" = "--uninstall" ] && uninstall
HUMAN_ONLY=false; [ "${1:-}" = "--human-only" ] && HUMAN_ONLY=true

echo "== agent-recall install =="

# 1. directories
mkdir -p "$BIN" "$STATE" "$BACKUPS" "$ROOT/archive" "$ROOT/logs" "$ROOT/memory/global/facts" "$ROOT/memory/projects" "$ROOT/integration"
chmod 700 "$ROOT" "$BIN" "$STATE" "$ROOT/archive" "$ROOT/logs" "$ROOT/memory"
touch "$ROOT/.metadata_never_index"
tmutil addexclusion "$ROOT" 2>/dev/null || true

# 2. retention: Claude homes (jq merge, one-time backup)
for pair in "claude-primary:$HOME/.claude/settings.json" "claude-second:$HOME/.claude-second/settings.json"; do
  name="${pair%%:*}"; f="${pair#*:}"
  [ -d "$(dirname "$f")" ] || continue
  [ -f "$f" ] || echo '{}' > "$f"
  if [ ! -f "$BACKUPS/$name.json" ]; then
    if jq -e 'has("cleanupPeriodDays")' "$f" >/dev/null; then
      jq '{had:true, value:.cleanupPeriodDays}' "$f" > "$BACKUPS/$name.json"
    else
      echo '{"had":false,"value":null}' > "$BACKUPS/$name.json"
    fi
  fi
  jq '.cleanupPeriodDays = 36500' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  echo "retention: $name cleanupPeriodDays=36500"
done

# 3. retention: Codex save-all (managed block; backup whole file once)
CODEX_TOML="$HOME/.codex/config.toml"
if [ -d "$HOME/.codex" ]; then
  [ -f "$CODEX_TOML" ] || touch "$CODEX_TOML"
  [ -f "$BACKUPS/codex-config.toml" ] || cp "$CODEX_TOML" "$BACKUPS/codex-config.toml"
  if grep -q '^\[history\]' "$CODEX_TOML"; then
    if grep -A3 '^\[history\]' "$CODEX_TOML" | grep -q 'persistence'; then
      sed -i '' 's/^\([[:space:]]*persistence[[:space:]]*=\).*/\1 "save-all"/' "$CODEX_TOML"
    else
      sed -i '' '/^\[history\]/a\
persistence = "save-all"
' "$CODEX_TOML"
    fi
  else
    printf '\n# agent-recall managed\n[history]\npersistence = "save-all"\n' >> "$CODEX_TOML"
  fi
  echo "retention: codex history.persistence=save-all"
fi

# 4. binaries + wrapper
cp "$REPO/bin/archive.mjs" "$REPO/bin/recall.mjs" "$BIN/"
chmod 700 "$BIN"/*.mjs
mkdir -p "$HOME/.local/bin"
cat > "$WRAPPER" <<WRAP
#!/usr/bin/env bash
# agent-recall-managed
export RECALL_HOME="\${RECALL_HOME:-$ROOT}"
exec env NODE_NO_WARNINGS=1 "$NODE_BIN" "$BIN/recall.mjs" "\$@"
WRAP
chmod 755 "$WRAPPER"

cat > "$BIN/run-sync.sh" <<RUNSYNC
#!/usr/bin/env bash
# launchd entry point — bounded one-shot
export RECALL_HOME="$ROOT"
exec env NODE_NO_WARNINGS=1 "$NODE_BIN" "$BIN/recall.mjs" sync --quiet
RUNSYNC
chmod 700 "$BIN/run-sync.sh"

# 5. verify BEFORE wiring launchd (avoids lock races during install)
echo "== self-test (isolated temp home) =="
"$WRAPPER" self-test
echo "== first sync (full corpus — may take a couple minutes) =="
"$WRAPPER" sync

# 6. launchd (30-min one-shot, low priority, no KeepAlive)
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$BIN/run-sync.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>1800</integer>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>ThrottleInterval</key><integer>300</integer>
  <key>StandardOutPath</key><string>$ROOT/logs/launchd.log</string>
  <key>StandardErrorPath</key><string>$ROOT/logs/launchd.log</string>
</dict></plist>
PLIST
plutil -lint "$PLIST" >/dev/null
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "launchd: $LABEL every 30m"

# 7. agent integration
cp "$REPO/integration/SKILL.md" "$ROOT/integration/SKILL.md"
mkdir -p "$ROOT/integration/agent-recall"
cp "$REPO/integration/SKILL.md" "$ROOT/integration/agent-recall/SKILL.md"
if [ "$HUMAN_ONLY" = false ]; then
  for f in "${AGENT_FILES[@]}"; do [ -d "$(dirname "$f")" ] && append_block "$f" && echo "instructions: $f"; done
  for d in "${SKILL_DIRS[@]}"; do
    [ -d "$(dirname "$d")" ] || continue
    mkdir -p "$d"
    ln -sfn "$ROOT/integration/agent-recall" "$d/agent-recall"
    echo "skill: $d/agent-recall"
  done
else
  for f in "${AGENT_FILES[@]}"; do remove_block "$f"; done
  for d in "${SKILL_DIRS[@]}"; do [ -L "$d/agent-recall" ] && rm "$d/agent-recall"; done
  echo "human-only mode: no agent instructions installed"
fi

# 8. final health report
echo "== doctor =="
"$WRAPPER" doctor || true
echo ""
echo "install complete. Try:  recall search \"<something you discussed weeks ago>\""
