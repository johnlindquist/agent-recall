#!/usr/bin/env bash
# agent-recall installer — idempotent, reversible, transactional.
#   install.sh [--human-only | --uninstall | --help]
#
# Order of operations (no user-visible mutation until staging validates):
#   preflight -> self-test (repo copy) -> stage+validate (mktemp) ->
#   bootout existing job -> apply -> first sync -> bootstrap -> doctor
set -Eeuo pipefail
umask 077

die() { echo "install.sh: ERROR: $1" >&2; exit "${2:-1}"; }

usage() {
  cat <<'USAGE'
usage: install.sh [--human-only | --uninstall | --help]

  (no flags)    install/refresh: launchd sync job, `recall` wrapper,
                agent instruction blocks + skill links, Claude retention
  --human-only  install/refresh, but remove agent instruction blocks and
                skill links (CLI + launchd only)
  --uninstall   unload launchd job, remove wrapper/plist/blocks/links,
                restore Claude retention. Archive/index/memory preserved.
  --help        show this help

environment:
  RECALL_HOME   install root (default: ~/Library/Application Support/AgentRecall)
  RECALL_NODE   stable node binary for the wrapper/launchd job (overrides discovery)
USAGE
}

# ---------- 0. argument parsing (before any environment probing) ----------
HUMAN_ONLY=false
UNINSTALL=false
while [ $# -gt 0 ]; do
  case "$1" in
    --human-only)
      if [ "$HUMAN_ONLY" = true ]; then die "duplicate flag: --human-only"; fi
      HUMAN_ONLY=true ;;
    --uninstall)
      if [ "$UNINSTALL" = true ]; then die "duplicate flag: --uninstall"; fi
      UNINSTALL=true ;;
    --help|-h)
      usage; exit 0 ;;
    *)
      usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done
if [ "$HUMAN_ONLY" = true ] && [ "$UNINSTALL" = true ]; then
  die "--human-only cannot be combined with --uninstall"
fi

# ---------- failure reporting ----------
STAGE_NAME="startup"
COMPLETED=""
mark_stage() { COMPLETED="$COMPLETED $STAGE_NAME"; STAGE_NAME="$1"; }
trap 'echo "install.sh: FAILED during stage \"$STAGE_NAME\". Completed stages:${COMPLETED:- (none)}. The system may be partially updated; fix the error and rerun, or run install.sh --uninstall." >&2' ERR
STAGE_DIR=""
cleanup() { if [ -n "$STAGE_DIR" ] && [ -d "$STAGE_DIR" ]; then rm -rf "$STAGE_DIR"; fi; }
trap cleanup EXIT

# ---------- basic environment ----------
if [ "$(uname -s)" != "Darwin" ]; then die "this installer supports macOS (Darwin) only"; fi
if [ "$(id -u)" -eq 0 ]; then die "refusing to run as root"; fi
GUI_DOMAIN="gui/$(id -u)"

resolve_repo() { # readlink-chase BASH_SOURCE so a symlinked install.sh still finds the repo
  local src="${BASH_SOURCE[0]}" dir
  while [ -L "$src" ]; do
    dir="$(cd -P "$(dirname "$src")" >/dev/null && pwd)"
    src="$(readlink "$src")"
    case "$src" in /*) ;; *) src="$dir/$src" ;; esac
  done
  cd -P "$(dirname "$src")" >/dev/null && pwd
}
REPO="$(resolve_repo)"

# ---------- RECALL_HOME resolution + safety ----------
ROOT_POINTER="$HOME/.config/agent-recall/root"
DEFAULT_ROOT="$HOME/Library/Application Support/AgentRecall"
if [ "$UNINSTALL" = true ]; then
  # uninstall works without the env var: fall back to the persisted root
  if [ -n "${RECALL_HOME:-}" ]; then ROOT="$RECALL_HOME"
  elif [ -r "$ROOT_POINTER" ]; then ROOT="$(head -n 1 "$ROOT_POINTER")"
  else ROOT="$DEFAULT_ROOT"; fi
else
  ROOT="${RECALL_HOME:-$DEFAULT_ROOT}"
fi
case "$ROOT" in
  /*) ;;
  *) die "RECALL_HOME must be an absolute path (got: $ROOT)" ;;
esac
if [ "$(printf '%s' "$ROOT" | LC_ALL=C tr -d '[:cntrl:]')" != "$ROOT" ]; then
  die "RECALL_HOME contains control characters — refusing"
fi

BIN="$ROOT/bin"
STATE="$ROOT/state"
BACKUPS="$STATE/install-backups"
WRAPPER="$HOME/.local/bin/recall"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
LABEL="local.agent-recall.sync"
PLIST="$LAUNCH_AGENTS/$LABEL.plist"
MANAGED_MARK="# agent-recall-managed"
MARK_BEGIN='<!-- BEGIN agent-recall -->'
MARK_END='<!-- END agent-recall -->'
SKILL_TARGET="$ROOT/integration/agent-recall"

CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
KIMI_DIR="${KIMI_CODE_HOME:-$HOME/.kimi-code}"
CODEX_AGENTS_FILE="$CODEX_DIR/AGENTS.md"
# Codex honors AGENTS.override.md when present and non-empty — target it instead
if [ -s "$CODEX_DIR/AGENTS.override.md" ]; then CODEX_AGENTS_FILE="$CODEX_DIR/AGENTS.override.md"; fi
AGENT_FILES=("$HOME/.claude/CLAUDE.md" "$HOME/.claude-second/CLAUDE.md" "$CODEX_AGENTS_FILE" "$HOME/.grok/AGENTS.md" "$HOME/.pi/agent/AGENTS.md")
# For removal, sweep both codex candidates regardless of which one is active
ALL_AGENT_FILES=("${AGENT_FILES[@]}" "$CODEX_DIR/AGENTS.md" "$CODEX_DIR/AGENTS.override.md")
SKILL_DIRS=("$HOME/.claude/skills" "$HOME/.claude-second/skills" "$HOME/.agents/skills" "$KIMI_DIR/skills")

# ---------- managed-block editing (validated, single-pass, atomic) ----------
remove_block() { # $1=file — strip our block + trailing blank lines; exit 2 on unbalanced markers
  local f="$1" tmp
  if [ -L "$f" ]; then die "refusing to edit symlinked instruction file: $f" 2; fi
  if [ ! -f "$f" ]; then return 0; fi
  tmp="$(mktemp "$(dirname "$f")/.agent-recall.XXXXXX")"
  chmod 600 "$tmp"
  if ! awk -v b="$MARK_BEGIN" -v e="$MARK_END" '
      $0 == b { if (inblk) exit 2; inblk = 1; next }
      $0 == e { if (!inblk) exit 2; inblk = 0; next }
      inblk   { next }
      $0 == "" { blanks++; next }
      { while (blanks > 0) { print ""; blanks-- } print }
      END { if (inblk) exit 2 }
    ' "$f" > "$tmp"; then
    rm -f "$tmp"
    die "unbalanced agent-recall markers in $f — fix the file manually, then rerun" 2
  fi
  mv -f "$tmp" "$f"
}

append_block() { # $1=file — remove any existing block, then append with exactly one blank separator
  local f="$1" tmp
  if [ -L "$f" ]; then die "refusing to edit symlinked instruction file: $f" 2; fi
  mkdir -p "$(dirname "$f")"
  if [ ! -f "$f" ]; then : > "$f"; fi
  remove_block "$f"
  tmp="$(mktemp "$(dirname "$f")/.agent-recall.XXXXXX")"
  chmod 600 "$tmp"
  cat "$f" > "$tmp"
  if [ -s "$tmp" ]; then
    if [ -n "$(tail -c 1 "$tmp")" ]; then printf '\n' >> "$tmp"; fi
    printf '\n' >> "$tmp"
  fi
  cat "$REPO/integration/agents-block.md" >> "$tmp"
  mv -f "$tmp" "$f"
}

# ---------- Claude retention (validated backup / guarded restore) ----------
apply_retention() { # $1=name $2=settings.json
  local name="$1" f="$2" tmp
  local b="$BACKUPS/$name.json"
  if [ ! -d "$(dirname "$f")" ]; then return 0; fi
  if [ ! -f "$f" ]; then printf '{}\n' > "$f"; fi
  if ! jq -e 'type == "object"' "$f" >/dev/null 2>&1; then
    die "malformed $f (not a JSON object) — refusing to edit or back it up; fix it first"
  fi
  if [ ! -f "$b" ]; then
    tmp="$(mktemp "$BACKUPS/.$name.XXXXXX")"
    chmod 600 "$tmp"
    if jq -e 'has("cleanupPeriodDays")' "$f" >/dev/null; then
      jq '{had: true, value: .cleanupPeriodDays}' "$f" > "$tmp"
    else
      printf '{"had":false,"value":null}\n' > "$tmp"
    fi
    mv -f "$tmp" "$b"
  fi
  tmp="$(mktemp "$(dirname "$f")/.settings.XXXXXX")"
  chmod 600 "$tmp"
  jq '.cleanupPeriodDays = 36500' "$f" > "$tmp"
  mv -f "$tmp" "$f"
  echo "retention: $name cleanupPeriodDays=36500"
}

restore_retention() { # $1=name $2=settings.json — only if the current value is still ours
  local name="$1" f="$2" tmp
  local b="$BACKUPS/$name.json"
  if [ ! -f "$b" ] || [ ! -f "$f" ]; then return 0; fi
  if ! command -v jq >/dev/null 2>&1; then
    echo "WARN: jq not found — skipping retention restore for $name (backup kept at $b)"
    return 0
  fi
  if ! jq -e '.cleanupPeriodDays == 36500' "$f" >/dev/null 2>&1; then return 0; fi
  tmp="$(mktemp "$(dirname "$f")/.settings.XXXXXX")"
  chmod 600 "$tmp"
  if [ "$(jq -r '.had' "$b")" = "true" ]; then
    jq --argjson v "$(jq -c '.value' "$b")" '.cleanupPeriodDays = $v' "$f" > "$tmp"
  else
    jq 'del(.cleanupPeriodDays)' "$f" > "$tmp"
  fi
  mv -f "$tmp" "$f"
  # archive the consumed backup so a future install takes a fresh baseline
  mv -f "$b" "$b.restored-$(date +%Y%m%d%H%M%S)"
  echo "retention: restored $name"
}

# ---------- skill links (never clobber foreign targets) ----------
install_skill_link() { # $1=skills dir
  local link="$1/agent-recall"
  if [ -L "$link" ]; then
    if [ "$(readlink "$link")" = "$SKILL_TARGET" ]; then return 0; fi   # already ours
    if [ ! -e "$link" ]; then ln -sfn "$SKILL_TARGET" "$link"; return 0; fi  # dead symlink
    die "refusing to replace $link (symlink to $(readlink "$link"), not ours)"
  fi
  if [ -e "$link" ]; then die "refusing to replace $link (existing non-symlink)"; fi
  ln -s "$SKILL_TARGET" "$link"
}

remove_skill_link() { # $1=skills dir — only remove links that point at us
  local link="$1/agent-recall"
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$SKILL_TARGET" ]; then rm -f "$link"; fi
}

xml_escape() {
  local s="$1"
  s="${s//&/&amp;}"; s="${s//</&lt;}"; s="${s//>/&gt;}"
  s="${s//\"/&quot;}"; s="${s//\'/&apos;}"
  printf '%s' "$s"
}

# ---------- uninstall (dispatched before node/jq preflight: needs neither node nor jq) ----------
do_uninstall() {
  echo "== agent-recall uninstall (data preserved at $ROOT) =="
  if launchctl print "$GUI_DOMAIN/$LABEL" >/dev/null 2>&1; then
    if ! launchctl bootout "$GUI_DOMAIN/$LABEL"; then
      die "could not unload launchd job $LABEL — leaving plist and wrapper in place; retry or reboot"
    fi
  fi
  rm -f "$PLIST"
  if [ -L "$WRAPPER" ]; then
    echo "WARN: $WRAPPER is a symlink not managed by agent-recall — leaving it"
  elif [ -e "$WRAPPER" ]; then
    if grep -qF "$MANAGED_MARK" "$WRAPPER"; then
      rm -f "$WRAPPER"
    else
      echo "WARN: $WRAPPER lacks the '$MANAGED_MARK' marker — leaving it"
    fi
  fi
  local f d
  for f in "${ALL_AGENT_FILES[@]}"; do remove_block "$f"; done
  for d in "${SKILL_DIRS[@]}"; do remove_skill_link "$d"; done
  restore_retention claude-primary "$HOME/.claude/settings.json"
  restore_retention claude-second "$HOME/.claude-second/settings.json"
  rm -f "$ROOT_POINTER"
  echo "done. Archive/index/memory kept. Remove manually if desired: rm -rf \"$ROOT\""
  exit 0
}
if [ "$UNINSTALL" = true ]; then do_uninstall; fi

# ---------- 1. preflight (no mutation) ----------
STAGE_NAME="preflight"
echo "== agent-recall install =="
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  die "node not found on PATH — install Node.js >= 22.5 (e.g. brew install node) or fix PATH"
fi
if ! command -v jq >/dev/null 2>&1; then die "jq not found on PATH — brew install jq"; fi
if ! "$NODE_BIN" --input-type=module -e 'import {DatabaseSync} from "node:sqlite"; const db=new DatabaseSync(":memory:"); db.exec("CREATE VIRTUAL TABLE p USING fts5(x)"); db.close()' >/dev/null 2>&1; then
  die "$NODE_BIN lacks node:sqlite FTS5 support — need Node >= 22.5 built with SQLite FTS5"
fi

# stable node path for launchd/wrapper fallback (version-pinned paths break on upgrade)
LAUNCHD_NODE=""
if [ -n "${RECALL_NODE:-}" ]; then
  LAUNCHD_NODE="$RECALL_NODE"
else
  for cand in /opt/homebrew/opt/node/bin/node /usr/local/opt/node/bin/node /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$cand" ]; then LAUNCHD_NODE="$cand"; break; fi
  done
  if [ -z "$LAUNCHD_NODE" ]; then LAUNCHD_NODE="$NODE_BIN"; fi
fi
case "$LAUNCHD_NODE" in
  */Cellar/*|*/.nvm/versions/*)
    die "node path '$LAUNCHD_NODE' is version-pinned and will break on upgrade — set RECALL_NODE to a stable path (e.g. /opt/homebrew/opt/node/bin/node)" ;;
esac
if [ ! -x "$LAUNCHD_NODE" ]; then die "node for launchd is not executable: $LAUNCHD_NODE"; fi

# ---------- 2. self-test from the repo copy (before any mutation) ----------
mark_stage "self-test"
echo "== self-test (repo copy, isolated temp home) =="
env NODE_NO_WARNINGS=1 "$NODE_BIN" "$REPO/bin/recall.mjs" self-test

# ---------- 3. stage everything in mktemp and validate ----------
mark_stage "staging"
STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-recall-install.XXXXXX")"
mkdir -p "$STAGE_DIR/bin" "$STAGE_DIR/lib"
cp "$REPO/bin/archive.mjs" "$REPO/bin/recall.mjs" "$STAGE_DIR/bin/"
cp "$REPO/lib/"*.mjs "$STAGE_DIR/lib/"
for m in "$STAGE_DIR"/bin/*.mjs "$STAGE_DIR"/lib/*.mjs; do
  "$NODE_BIN" --check "$m"
done

ROOT_Q="$(printf '%q' "$ROOT")"
BIN_Q="$(printf '%q' "$BIN")"
STATE_Q="$(printf '%q' "$STATE")"

# -- wrapper: resolves node at invocation time, hands node a sanitized env --
cat > "$STAGE_DIR/recall" <<EOF
#!/usr/bin/env bash
$MANAGED_MARK
set -euo pipefail
umask 077
ROOT=$ROOT_Q
STATE_DIR=$STATE_Q
BIN_DIR=$BIN_Q
EOF
cat >> "$STAGE_DIR/recall" <<'EOF'
NODE=""
if [ -n "${RECALL_NODE:-}" ] && [ -x "${RECALL_NODE}" ]; then
  NODE="$RECALL_NODE"
elif command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
elif [ -r "$STATE_DIR/node-path" ]; then
  stored="$(head -n 1 "$STATE_DIR/node-path")"
  if [ -x "$stored" ]; then NODE="$stored"; fi
fi
if [ -z "$NODE" ]; then
  echo "recall: no usable node interpreter found (install node, or set RECALL_NODE=/path/to/node)" >&2
  exit 69
fi
export RECALL_HOME="${RECALL_HOME:-$ROOT}"
# env -i allowlist: drops NODE_OPTIONS/NODE_PATH/RIPGREP_CONFIG_PATH/DYLD_* etc.
exec /usr/bin/env -i \
  HOME="$HOME" \
  USER="${USER:-}" \
  TMPDIR="${TMPDIR:-/tmp}" \
  PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin" \
  RECALL_HOME="$RECALL_HOME" \
  NODE_NO_WARNINGS=1 \
  "$NODE" "$BIN_DIR/recall.mjs" "$@"
EOF

# -- run-sync.sh: launchd entry point — self-rotating log, watchdog, 75->0 --
cat > "$STAGE_DIR/run-sync.sh" <<EOF
#!/usr/bin/env bash
$MANAGED_MARK
# launchd entry point — bounded one-shot
set -euo pipefail
umask 077
ROOT=$ROOT_Q
STATE_DIR=$STATE_Q
BIN_DIR=$BIN_Q
EOF
cat >> "$STAGE_DIR/run-sync.sh" <<'EOF'
LOG="$ROOT/logs/launchd.log"
mkdir -p "$ROOT/logs"
if [ -f "$LOG" ]; then
  size="$(stat -f %z "$LOG" 2>/dev/null || echo 0)"
  if [ "$size" -ge 2097152 ]; then mv -f "$LOG" "$LOG.1"; fi
fi
exec >>"$LOG" 2>&1
NODE=""
if [ -n "${RECALL_NODE:-}" ] && [ -x "${RECALL_NODE}" ]; then
  NODE="$RECALL_NODE"
elif command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
elif [ -r "$STATE_DIR/node-path" ]; then
  stored="$(head -n 1 "$STATE_DIR/node-path")"
  if [ -x "$stored" ]; then NODE="$stored"; fi
fi
if [ -z "$NODE" ]; then
  echo "run-sync: no usable node interpreter found (set RECALL_NODE)" >&2
  exit 69
fi
/usr/bin/env -i \
  HOME="$HOME" \
  USER="${USER:-}" \
  TMPDIR="${TMPDIR:-/tmp}" \
  PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin" \
  RECALL_HOME="$ROOT" \
  NODE_NO_WARNINGS=1 \
  "$NODE" "$BIN_DIR/recall.mjs" sync --quiet &
child=$!
(
  sleep "${RECALL_WALL_SECONDS:-300}"
  kill -TERM "$child" 2>/dev/null || true
  sleep 10
  kill -KILL "$child" 2>/dev/null || true
) &
watchdog=$!
rc=0
wait "$child" || rc=$?
kill "$watchdog" 2>/dev/null || true
wait "$watchdog" 2>/dev/null || true
# 75 (EX_TEMPFAIL: another archiver holds the lock) is benign under launchd
if [ "$rc" -eq 75 ]; then exit 0; fi
exit "$rc"
EOF

RUNSYNC_XML="$(xml_escape "$BIN/run-sync.sh")"
cat > "$STAGE_DIR/$LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$RUNSYNC_XML</string></array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>1800</integer>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>ThrottleInterval</key><integer>300</integer>
  <key>ExitTimeOut</key><integer>330</integer>
  <key>Umask</key><integer>63</integer>
</dict></plist>
PLIST

bash -n "$STAGE_DIR/recall"
bash -n "$STAGE_DIR/run-sync.sh"
plutil -lint "$STAGE_DIR/$LABEL.plist" >/dev/null
echo "staged + validated: bin/lib modules, wrapper, run-sync.sh, plist"

# ---------- 4. bootout existing job (only if loaded) ----------
mark_stage "bootout"
if launchctl print "$GUI_DOMAIN/$LABEL" >/dev/null 2>&1; then
  if ! launchctl bootout "$GUI_DOMAIN/$LABEL"; then
    die "could not unload existing launchd job $LABEL — retry or reboot"
  fi
fi

# ---------- 5. apply ----------
mark_stage "apply"
mkdir -p "$BIN" "$STATE" "$BACKUPS" "$ROOT/archive" "$ROOT/logs" "$ROOT/lib" \
  "$ROOT/memory/global/facts" "$ROOT/memory/projects" "$ROOT/integration/agent-recall"
chmod 700 "$ROOT" "$BIN" "$STATE" "$ROOT/archive" "$ROOT/logs" "$ROOT/lib" "$ROOT/memory" "$ROOT/integration"
touch "$ROOT/.metadata_never_index"
if ! tm_err="$(tmutil addexclusion "$ROOT" 2>&1)"; then
  echo "WARN: tmutil addexclusion failed: $tm_err"
fi

# persist the root so --uninstall works without RECALL_HOME
mkdir -p "$HOME/.config/agent-recall"
ptmp="$(mktemp "$HOME/.config/agent-recall/.root.XXXXXX")"
printf '%s\n' "$ROOT" > "$ptmp"
chmod 600 "$ptmp"
mv -f "$ptmp" "$ROOT_POINTER"

# stored node path for wrapper/run-sync fallback (launchd has a bare PATH)
ntmp="$(mktemp "$STATE/.node-path.XXXXXX")"
printf '%s\n' "$LAUNCHD_NODE" > "$ntmp"
chmod 600 "$ntmp"
mv -f "$ntmp" "$STATE/node-path"

# retention: Claude homes only. Codex is deliberately NOT touched: it saves
# transcripts by default, and an explicit persistence="none" is user opt-out
# that must not be reversed.
apply_retention claude-primary "$HOME/.claude/settings.json"
apply_retention claude-second "$HOME/.claude-second/settings.json"

# binaries + modules
cp "$STAGE_DIR/bin/"*.mjs "$BIN/"
chmod 700 "$BIN"/*.mjs
cp "$STAGE_DIR/lib/"*.mjs "$ROOT/lib/"
chmod 600 "$ROOT/lib/"*.mjs

# run-sync.sh (atomic)
rtmp="$(mktemp "$BIN/.run-sync.XXXXXX")"
cat "$STAGE_DIR/run-sync.sh" > "$rtmp"
chmod 700 "$rtmp"
mv -f "$rtmp" "$BIN/run-sync.sh"

# wrapper: require absent or ours; never truncate through a symlink
mkdir -p "$HOME/.local/bin"
if [ -L "$WRAPPER" ]; then
  die "refusing to overwrite $WRAPPER: it is a symlink (not managed by agent-recall)"
fi
if [ -e "$WRAPPER" ] && ! grep -qF "$MANAGED_MARK" "$WRAPPER"; then
  die "refusing to overwrite $WRAPPER: missing '$MANAGED_MARK' marker (not ours)"
fi
wtmp="$(mktemp "$HOME/.local/bin/.recall.XXXXXX")"
cat "$STAGE_DIR/recall" > "$wtmp"
chmod 755 "$wtmp"
mv -f "$wtmp" "$WRAPPER"
echo "wrapper: $WRAPPER"

# agent integration payload (single canonical copy under integration/agent-recall)
cp "$REPO/integration/SKILL.md" "$ROOT/integration/agent-recall/SKILL.md"
chmod 600 "$ROOT/integration/agent-recall/SKILL.md"
rm -f "$ROOT/integration/SKILL.md"   # legacy unused top-level copy

if [ "$HUMAN_ONLY" = false ]; then
  for f in "${AGENT_FILES[@]}"; do
    if [ -d "$(dirname "$f")" ]; then
      append_block "$f"
      echo "instructions: $f"
    fi
  done
  for d in "${SKILL_DIRS[@]}"; do
    if [ "$d" = "$HOME/.agents/skills" ]; then
      mkdir -p "$d"
    elif [ -d "$(dirname "$d")" ]; then
      mkdir -p "$d"
    else
      continue
    fi
    install_skill_link "$d"
    echo "skill: $d/agent-recall"
  done
else
  for f in "${ALL_AGENT_FILES[@]}"; do remove_block "$f"; done
  for d in "${SKILL_DIRS[@]}"; do remove_skill_link "$d"; done
  echo "human-only mode: no agent instructions installed"
fi

# plist (already linted from the staged copy)
mkdir -p "$LAUNCH_AGENTS"
ltmp="$(mktemp "$LAUNCH_AGENTS/.$LABEL.XXXXXX")"
cat "$STAGE_DIR/$LABEL.plist" > "$ltmp"
chmod 644 "$ltmp"
mv -f "$ltmp" "$PLIST"

# ---------- 6. first sync ----------
mark_stage "first-sync"
echo "== first sync (full corpus — may take a couple minutes) =="
env RECALL_HOME="$ROOT" "$WRAPPER" sync

# ---------- 7. launchd bootstrap ----------
mark_stage "launchd-bootstrap"
launchctl bootstrap "$GUI_DOMAIN" "$PLIST"
echo "launchd: $LABEL every 30m"

# ---------- 8. final health report ----------
mark_stage "doctor"
echo "== doctor =="
if ! env RECALL_HOME="$ROOT" "$WRAPPER" doctor; then
  echo "WARN: doctor reported issues (see above)"
fi

mark_stage "done"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo "NOTE: $HOME/.local/bin is not on your PATH. Add this to ~/.zprofile yourself:"
     echo '  export PATH="$HOME/.local/bin:$PATH"' ;;
esac
echo ""
echo "install complete. Try:  recall search \"<something you discussed weeks ago>\""
