#!/usr/bin/env bash
# install.sh test harness — runs entirely against temp HOMEs + temp RECALL_HOMEs.
# Never touches the real ~. launchctl/tmutil are mocked; node is a stub so no
# real archiver/launchd work happens. Run: bash test/install.test.sh
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL="$REPO/install.sh"
BLOCK="$REPO/integration/agents-block.md"
BASE_SKILL="$REPO/integration/SKILL.md"
SAVE_SKILL="$REPO/integration/agent-recall-save/SKILL.md"
SAVE_OPENAI="$REPO/integration/agent-recall-save/agents/openai.yaml"

TESTROOT="$(mktemp -d "${TMPDIR:-/tmp}/recall-install-test.XXXXXX")"
trap 'rm -rf "$TESTROOT"' EXIT
mkdir -p "$TESTROOT/tmp"

pass=0; fail=0
ok()  { pass=$((pass+1)); printf 'ok %d - %s\n' $((pass+fail)) "$1"; }
bad() { fail=$((fail+1)); printf 'not ok %d - %s\n' $((pass+fail)) "$1"; }
check() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }

# ---------- mocks ----------
MOCK="$TESTROOT/mock"           # launchctl + tmutil + stub node
MOCK_NONODE="$TESTROOT/mock-nonode"  # launchctl + tmutil + jq, NO node
mkdir -p "$MOCK" "$MOCK_NONODE"

cat > "$MOCK/launchctl" <<'EOF'
#!/bin/bash
echo "launchctl $*" >> "${MOCK_LOG:-/dev/null}"
case "${1:-}" in
  print)     [ "${MOCK_LAUNCHCTL_LOADED:-0}" = 1 ] && exit 0; exit 1 ;;
  bootout)   [ "${MOCK_BOOTOUT_FAIL:-0}" = 1 ] && exit 5; exit 0 ;;
  bootstrap) exit 0 ;;
esac
exit 0
EOF
printf '#!/bin/bash\nexit 0\n' > "$MOCK/tmutil"
printf '#!/bin/bash\nexit 0\n' > "$MOCK/node"   # stub: --check, FTS5 probe, self-test, sync, doctor all "pass"
chmod 755 "$MOCK"/*
cp "$MOCK/launchctl" "$MOCK/tmutil" "$MOCK_NONODE/"

JQ_BIN="$(command -v jq)" || { echo "jq required to run these tests" >&2; exit 1; }
ln -s "$JQ_BIN" "$MOCK_NONODE/jq"
JQ_DIR="$(dirname "$JQ_BIN")"
BASEPATH="/usr/bin:/bin:/usr/sbin:/sbin:$JQ_DIR"

# run_i <home> [ENV=val ...] [-- <args...>] : hermetic install.sh run (RECALL_HOME set)
run_i() {
  local h="$1"; shift
  local envs=(HOME="$h" RECALL_HOME="$h/recall root" TMPDIR="$TESTROOT/tmp" MOCK_LOG="$h/mock.log" PATH="$MOCK:$BASEPATH")
  while [ $# -gt 0 ] && [[ "$1" == *=* ]]; do envs+=("$1"); shift; done
  env -i "${envs[@]}" bash "$INSTALL" "$@"
}

new_home() { # $1=tag → prints path
  local h="$TESTROOT/home-$1"
  mkdir -p "$h/.claude/skills" "$h/.claude-second" "$h/.codex" "$h/.local/bin" "$h/Library/LaunchAgents"
  printf '# my rules\n' > "$h/.claude/CLAUDE.md"
  printf '{"cleanupPeriodDays":7}\n' > "$h/.claude/settings.json"
  printf '[history]\npersistence = "none"\n' > "$h/.codex/config.toml"
  : > "$h/.codex/AGENTS.md"
  printf '%s\n' "$h"
}

# =====================================================================
echo "# arg parsing"
h="$(new_home args)"
out="$(run_i "$h" --help 2>&1)"; rc=$?
check "--help exits 0" test "$rc" -eq 0
check "--help mentions --uninstall" grep -q -- --uninstall <<<"$out"

run_i "$h" --bogus >/dev/null 2>"$h/err1"; rc=$?
check "unknown flag rejected" test "$rc" -ne 0
check "unknown flag named in error" grep -q 'unknown argument: --bogus' "$h/err1"

run_i "$h" --human-only --human-only >/dev/null 2>&1; rc=$?
check "duplicate flag rejected" test "$rc" -ne 0

run_i "$h" --human-only --uninstall >/dev/null 2>&1; rc=$?
check "--human-only + --uninstall rejected" test "$rc" -ne 0

echo "# preflight"
env -i HOME="$h" RECALL_HOME="relative/path" TMPDIR="$TESTROOT/tmp" PATH="$MOCK:$BASEPATH" \
  bash "$INSTALL" >/dev/null 2>"$h/err2"; rc=$?
check "relative RECALL_HOME dies" test "$rc" -ne 0
check "relative RECALL_HOME message" grep -q 'absolute path' "$h/err2"

env -i HOME="$h" RECALL_HOME="$h/bad
newline" TMPDIR="$TESTROOT/tmp" PATH="$MOCK:$BASEPATH" bash "$INSTALL" >/dev/null 2>"$h/err3"; rc=$?
check "RECALL_HOME with newline dies" test "$rc" -ne 0
check "control-char message" grep -q 'control characters' "$h/err3"

env -i HOME="$h" RECALL_HOME="$h/r" TMPDIR="$TESTROOT/tmp" PATH="/usr/bin:/bin" \
  bash "$INSTALL" >/dev/null 2>"$h/err4"; rc=$?
check "missing node dies before mutation" test "$rc" -ne 0
check "missing node names node" grep -qi 'node not found' "$h/err4"
check "missing node: no root created" test ! -e "$h/r"

run_i "$h" RECALL_NODE="$TESTROOT/.nvm/versions/node/v20.0.0/bin/node" >/dev/null 2>"$h/err5"; rc=$?
check "nvm-pinned RECALL_NODE rejected" test "$rc" -ne 0
check "pinned-path message suggests stable path" grep -q 'RECALL_NODE' "$h/err5"

# =====================================================================
echo "# fresh install"
h="$(new_home a)"; R="$h/recall root"
cp "$h/.claude/CLAUDE.md" "$TESTROOT/seed-claude.md"
run_i "$h" > "$h/install.log" 2>&1; rc=$?
check "install exits 0" test "$rc" -eq 0

W="$h/.local/bin/recall"
check "wrapper exists + executable" test -x "$W"
check "wrapper has managed marker" grep -qF '# agent-recall-managed' "$W"
check "wrapper passes bash -n" bash -n "$W"
check "wrapper sanitizes env (env -i allowlist)" grep -q '/usr/bin/env -i' "$W"
check "wrapper has node fallback exit 69" grep -q 'exit 69' "$W"

RS="$R/bin/run-sync.sh"
check "run-sync exists + executable" test -x "$RS"
check "run-sync passes bash -n" bash -n "$RS"
check "run-sync rotates its own log" grep -q 'launchd.log' "$RS"
check "run-sync has watchdog" grep -q 'RECALL_WALL_SECONDS' "$RS"

P="$h/Library/LaunchAgents/local.agent-recall.sync.plist"
check "plist installed" test -f "$P"
check "plist lints" plutil -lint "$P"
check "plist has Umask 63" grep -q '<key>Umask</key><integer>63</integer>' "$P"
if grep -q 'StandardOutPath\|StandardErrorPath' "$P"; then bad "plist has no Standard*Path"; else ok "plist has no Standard*Path"; fi
check "launchd bootstrap invoked" grep -q "launchctl bootstrap gui/$(id -u) $P" "$h/mock.log"

check "node-path stored" test -f "$R/state/node-path"
check "node-path is 0600" test "$(stat -f %Lp "$R/state/node-path")" = "600"
check "root pointer persisted" test "$(cat "$h/.config/agent-recall/root")" = "$R"

{ cat "$TESTROOT/seed-claude.md"; echo ""; cat "$BLOCK"; } > "$TESTROOT/expected-claude.md"
check "block appended with exactly one blank separator" cmp -s "$h/.claude/CLAUDE.md" "$TESTROOT/expected-claude.md"
check "empty AGENTS.md gets bare block (no leading blank)" cmp -s "$h/.codex/AGENTS.md" "$BLOCK"
check "claude-second CLAUDE.md created with block" cmp -s "$h/.claude-second/CLAUDE.md" "$BLOCK"

check "retention set to 36500" jq -e '.cleanupPeriodDays == 36500' "$h/.claude/settings.json"
check "backup captured prior value" jq -e '.had == true and .value == 7' "$R/state/install-backups/claude-primary.json"
check "second home settings created + set" jq -e '.cleanupPeriodDays == 36500' "$h/.claude-second/settings.json"
check "second home backup had:false" jq -e '.had == false' "$R/state/install-backups/claude-second.json"

check "codex persistence=none untouched" grep -q 'persistence = "none"' "$h/.codex/config.toml"
if grep -q 'save-all' "$h/.codex/config.toml"; then bad "codex config never gets save-all"; else ok "codex config never gets save-all"; fi
check "no codex backup minted" test ! -e "$R/state/install-backups/codex-config.toml"

check "claude skill link" test "$(readlink "$h/.claude/skills/agent-recall")" = "$R/integration/agent-recall"
check "claude save skill link" test "$(readlink "$h/.claude/skills/agent-recall-save")" = "$R/integration/agent-recall-save"
check "claude-second save skill link" test "$(readlink "$h/.claude-second/skills/agent-recall-save")" = "$R/integration/agent-recall-save"
check "~/.agents/skills always created" test -d "$h/.agents/skills"
check "agents skill link" test "$(readlink "$h/.agents/skills/agent-recall")" = "$R/integration/agent-recall"
check "agents save skill link" test "$(readlink "$h/.agents/skills/agent-recall-save")" = "$R/integration/agent-recall-save"
check "save link does not point at checkout" test "$(readlink "$h/.agents/skills/agent-recall-save")" != "$REPO/integration/agent-recall-save"
check "no kimi link (no ~/.kimi-code)" test ! -e "$h/.kimi-code"
check "base SKILL.md canonical bytes" cmp -s "$BASE_SKILL" "$R/integration/agent-recall/SKILL.md"
check "save SKILL.md canonical bytes" cmp -s "$SAVE_SKILL" "$R/integration/agent-recall-save/SKILL.md"
check "save openai.yaml canonical bytes" cmp -s "$SAVE_OPENAI" "$R/integration/agent-recall-save/agents/openai.yaml"
check "save canonical directory is 0700" test "$(stat -f %Lp "$R/integration/agent-recall-save")" = "700"
check "save canonical SKILL.md is 0600" test "$(stat -f %Lp "$R/integration/agent-recall-save/SKILL.md")" = "600"
check "save metadata directory is 0700" test "$(stat -f %Lp "$R/integration/agent-recall-save/agents")" = "700"
check "save metadata file is 0600" test "$(stat -f %Lp "$R/integration/agent-recall-save/agents/openai.yaml")" = "600"
check "no legacy top-level SKILL.md" test ! -e "$R/integration/SKILL.md"
save_hash_before="$(shasum -a 256 "$R/integration/agent-recall-save/SKILL.md" | awk '{print $1}')"

echo "# run-sync behavior (real bash, stub node)"
printf '#!/bin/bash\nexit 75\n' > "$MOCK/node75"; chmod 755 "$MOCK/node75"
env -i HOME="$h" RECALL_NODE="$MOCK/node75" TMPDIR="$TESTROOT/tmp" PATH="/usr/bin:/bin" bash "$RS"; rc=$?
check "run-sync maps exit 75 -> 0" test "$rc" -eq 0
printf '#!/bin/bash\nexec sleep 60\n' > "$MOCK/nodeslow"; chmod 755 "$MOCK/nodeslow"
env -i HOME="$h" RECALL_NODE="$MOCK/nodeslow" RECALL_WALL_SECONDS=1 TMPDIR="$TESTROOT/tmp" PATH="/usr/bin:/bin" bash "$RS"; rc=$?
check "run-sync watchdog kills overrunning sync (nonzero exit)" test "$rc" -ne 0
mv "$R/state/node-path" "$R/state/node-path.hold"
env -i HOME="$h" TMPDIR="$TESTROOT/tmp" PATH="/usr/bin:/bin" bash "$W" doctor >/dev/null 2>&1; rc=$?
check "wrapper exits 69 when no node resolvable" test "$rc" -eq 69
mv "$R/state/node-path.hold" "$R/state/node-path"

echo "# idempotency"
run_i "$h" > "$h/install2.log" 2>&1; rc=$?
check "second install exits 0" test "$rc" -eq 0
check "CLAUDE.md unchanged after rerun (no blank accumulation)" cmp -s "$h/.claude/CLAUDE.md" "$TESTROOT/expected-claude.md"
check "backup still original value after rerun" jq -e '.had == true and .value == 7' "$R/state/install-backups/claude-primary.json"
check "save canonical bytes unchanged after rerun" test "$(shasum -a 256 "$R/integration/agent-recall-save/SKILL.md" | awk '{print $1}')" = "$save_hash_before"
check "save link unchanged after rerun" test "$(readlink "$h/.agents/skills/agent-recall-save")" = "$R/integration/agent-recall-save"

echo "# canonical skill refresh"
fixture="$TESTROOT/repo-fixture"
mkdir -p "$fixture"
cp "$REPO/install.sh" "$fixture/install.sh"
cp -R "$REPO/bin" "$REPO/lib" "$REPO/integration" "$fixture/"
printf '\n<!-- installer refresh fixture -->\n' >> "$fixture/integration/agent-recall-save/SKILL.md"
real_install="$INSTALL"
INSTALL="$fixture/install.sh"
run_i "$h" > "$h/install-fixture.log" 2>&1; rc=$?
check "fixture refresh install exits 0" test "$rc" -eq 0
check "fixture refresh updates canonical bytes" cmp -s "$fixture/integration/agent-recall-save/SKILL.md" "$R/integration/agent-recall-save/SKILL.md"
check "fixture refresh keeps managed link" test "$(readlink "$h/.agents/skills/agent-recall-save")" = "$R/integration/agent-recall-save"
INSTALL="$real_install"
run_i "$h" > "$h/install-restore.log" 2>&1; rc=$?
check "source restore install exits 0" test "$rc" -eq 0
check "source restore returns canonical bytes" cmp -s "$SAVE_SKILL" "$R/integration/agent-recall-save/SKILL.md"

echo "# human-only"
run_i "$h" --human-only > "$h/install3.log" 2>&1; rc=$?
check "human-only exits 0" test "$rc" -eq 0
check "human-only removed block" cmp -s "$h/.claude/CLAUDE.md" "$TESTROOT/seed-claude.md"
check "human-only removed skill link" test ! -e "$h/.claude/skills/agent-recall"
check "human-only removed save skill link" test ! -e "$h/.claude/skills/agent-recall-save"
check "human-only keeps wrapper" test -x "$W"

echo "# uninstall (no RECALL_HOME env, no node on PATH, job loaded)"
run_i "$h" > /dev/null 2>&1   # reinstall blocks/links first
env -i HOME="$h" TMPDIR="$TESTROOT/tmp" MOCK_LOG="$h/mock.log" MOCK_LAUNCHCTL_LOADED=1 \
  PATH="$MOCK_NONODE:/usr/bin:/bin:/usr/sbin:/sbin" bash "$INSTALL" --uninstall > "$h/uninstall.log" 2>&1; rc=$?
check "uninstall exits 0" test "$rc" -eq 0
check "uninstall removed wrapper" test ! -e "$W"
check "uninstall removed plist" test ! -e "$P"
check "uninstall booted out loaded job" grep -q "launchctl bootout gui/$(id -u)/local.agent-recall.sync" "$h/mock.log"
check "uninstall removed block" cmp -s "$h/.claude/CLAUDE.md" "$TESTROOT/seed-claude.md"
check "uninstall removed skill link" test ! -e "$h/.claude/skills/agent-recall"
check "uninstall removed save skill link" test ! -e "$h/.claude/skills/agent-recall-save"
check "retention restored to 7" jq -e '.cleanupPeriodDays == 7' "$h/.claude/settings.json"
check "second-home retention key deleted" jq -e 'has("cleanupPeriodDays") | not' "$h/.claude-second/settings.json"
check "backup archived after restore" bash -c 'ls "'"$R"'/state/install-backups/claude-primary.json.restored-"* >/dev/null 2>&1'
check "consumed backup gone" test ! -e "$R/state/install-backups/claude-primary.json"
check "root pointer removed" test ! -e "$h/.config/agent-recall/root"
check "archive data preserved" test -d "$R/archive"

echo "# uninstall refuses to strand a stuck job"
h="$(new_home v)"; R="$h/recall root"
run_i "$h" > /dev/null 2>&1
run_i "$h" MOCK_LAUNCHCTL_LOADED=1 MOCK_BOOTOUT_FAIL=1 --uninstall > /dev/null 2>"$h/err"; rc=$?
check "uninstall dies on bootout failure" test "$rc" -ne 0
check "plist kept when bootout fails" test -f "$h/Library/LaunchAgents/local.agent-recall.sync.plist"
check "wrapper kept when bootout fails" test -x "$h/.local/bin/recall"

echo "# marker-balance safety"
h="$(new_home b)"
printf '# rules\n<!-- BEGIN agent-recall -->\nstuff the user typed\n' > "$h/.claude/CLAUDE.md"
cp "$h/.claude/CLAUDE.md" "$TESTROOT/unbalanced-seed"
run_i "$h" > /dev/null 2>"$h/err"; rc=$?
check "unbalanced markers abort install" test "$rc" -ne 0
check "unbalanced marker error is explicit" grep -q 'unbalanced agent-recall markers' "$h/err"
check "file with unbalanced markers untouched" cmp -s "$h/.claude/CLAUDE.md" "$TESTROOT/unbalanced-seed"

echo "# malformed settings.json"
h="$(new_home c)"
printf 'not json at all\n' > "$h/.claude/settings.json"
run_i "$h" > /dev/null 2>"$h/err"; rc=$?
check "malformed settings aborts" test "$rc" -ne 0
check "malformed settings message" grep -q 'malformed' "$h/err"
check "malformed settings untouched" grep -q 'not json at all' "$h/.claude/settings.json"
check "no backup minted for malformed settings" test ! -e "$h/recall root/state/install-backups/claude-primary.json"

echo "# wrapper ownership"
h="$(new_home d)"
printf '#!/bin/sh\necho user-owned tool\n' > "$h/.local/bin/recall"; chmod 755 "$h/.local/bin/recall"
run_i "$h" > /dev/null 2>"$h/err"; rc=$?
check "foreign wrapper file blocks install" test "$rc" -ne 0
check "foreign wrapper untouched" grep -q 'user-owned tool' "$h/.local/bin/recall"

h="$(new_home e)"
ln -s /bin/echo "$h/.local/bin/recall"
run_i "$h" > /dev/null 2>&1; rc=$?
check "symlink wrapper blocks install" test "$rc" -ne 0
check "symlink wrapper untouched" test "$(readlink "$h/.local/bin/recall")" = "/bin/echo"

echo "# skill link ownership"
h="$(new_home f)"
mkdir -p "$h/elsewhere"
ln -s "$h/elsewhere" "$h/.claude/skills/agent-recall"
run_i "$h" > /dev/null 2>&1; rc=$?
check "foreign skill symlink blocks install" test "$rc" -ne 0
check "foreign skill symlink untouched" test "$(readlink "$h/.claude/skills/agent-recall")" = "$h/elsewhere"

echo "# save skill link ownership preflight"
h="$(new_home f-save-live)"
mkdir -p "$h/elsewhere"
ln -s "$h/elsewhere" "$h/.claude/skills/agent-recall-save"
cp "$h/.claude/CLAUDE.md" "$h/instructions.before"
run_i "$h" > /dev/null 2>"$h/err"; rc=$?
check "foreign live save symlink blocks install" test "$rc" -ne 0
check "foreign live save symlink preserved" test "$(readlink "$h/.claude/skills/agent-recall-save")" = "$h/elsewhere"
check "live collision occurs before root mutation" test ! -e "$h/recall root"
check "live collision leaves instructions unchanged" cmp -s "$h/.claude/CLAUDE.md" "$h/instructions.before"

h="$(new_home f-save-dead)"
ln -s "$h/missing-target" "$h/.claude/skills/agent-recall-save"
run_i "$h" > /dev/null 2>"$h/err"; rc=$?
check "foreign dead save symlink blocks install" test "$rc" -ne 0
check "foreign dead save symlink preserved" test "$(readlink "$h/.claude/skills/agent-recall-save")" = "$h/missing-target"
check "dead collision occurs before root mutation" test ! -e "$h/recall root"

h="$(new_home f-save-dir)"
mkdir -p "$h/.claude/skills/agent-recall-save"
run_i "$h" > /dev/null 2>"$h/err"; rc=$?
check "foreign save directory blocks install" test "$rc" -ne 0
check "foreign save directory preserved" test -d "$h/.claude/skills/agent-recall-save"
check "directory collision occurs before root mutation" test ! -e "$h/recall root"

h="$(new_home f-save-uninstall)"
mkdir -p "$h/elsewhere"
ln -s "$h/elsewhere" "$h/.claude/skills/agent-recall-save"
run_i "$h" --uninstall > /dev/null 2>&1; rc=$?
check "uninstall with foreign save link exits 0" test "$rc" -eq 0
check "uninstall preserves foreign save link" test "$(readlink "$h/.claude/skills/agent-recall-save")" = "$h/elsewhere"

echo "# codex AGENTS.override.md"
h="$(new_home g)"
printf '# override rules\n' > "$h/.codex/AGENTS.override.md"
run_i "$h" > /dev/null 2>&1; rc=$?
check "install with override exits 0" test "$rc" -eq 0
check "block landed in AGENTS.override.md" grep -qF '<!-- BEGIN agent-recall -->' "$h/.codex/AGENTS.override.md"
if grep -qF '<!-- BEGIN agent-recall -->' "$h/.codex/AGENTS.md"; then bad "AGENTS.md untouched when override active"; else ok "AGENTS.md untouched when override active"; fi

echo "# real --help smoke (user PATH, throwaway HOME)"
sh_home="$(mktemp -d "$TESTROOT/smoke-home.XXXXXX")"
sh_root="$(mktemp -d "$TESTROOT/smoke-root.XXXXXX")/root"
RECALL_HOME="$sh_root" HOME="$sh_home" bash "$INSTALL" --help >/dev/null 2>&1; rc=$?
check "real-env --help smoke exits 0" test "$rc" -eq 0

echo ""
echo "install.test.sh: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then exit 1; fi
exit 0
