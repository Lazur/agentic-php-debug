#!/usr/bin/env bash
# Agentic PHP Debug — installer.
#
#   curl -fsSL https://raw.githubusercontent.com/Lazur/agentic-php-debug/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/Lazur/agentic-php-debug/main/install.sh | bash -s -- --project ~/code/my-app
#   ./install.sh --help                  # from a checkout: installs that checkout in place
#
# Re-running is safe and is also how you update. Nothing outside the install
# directory is touched except what the summary lists (MCP client registrations,
# skill links, ~/.local/bin shims, and — only with --xdebug — a PHP ini file).
#
# Written for bash 3.2 (macOS default): no associative arrays, no ${var,,}.

set -euo pipefail

# PHP_DEBUG_MCP_* are the pre-rename names of these variables and are still read.
CORE_REPO="${AGENTIC_PHP_DEBUG_REPO:-${PHP_DEBUG_MCP_REPO:-https://github.com/Lazur/agentic-php-debug.git}}"
MIN_NODE=20

# --- output -----------------------------------------------------------------

if [ -t 1 ]; then
  B=$'\033[1m'; D=$'\033[2m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; C=$'\033[36m'; N=$'\033[0m'
else
  B=; D=; R=; G=; Y=; C=; N=
fi
step() { printf '\n%s==>%s %s%s%s\n' "$C" "$N" "$B" "$*" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; WARNINGS=$((WARNINGS + 1)); }
info() { printf '  %s%s%s\n' "$D" "$*" "$N"; }
die()  { printf '\n%serror:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }
has()  { command -v "$1" >/dev/null 2>&1; }
WARNINGS=0

usage() {
  cat <<EOF
${B}Agentic PHP Debug installer${N}

Installs the MCP server, registers it with the MCP clients it finds, and checks
that PHP + Xdebug can reach it.

${B}Usage${N}
  install.sh [options]

${B}Where${N}
  --dir DIR              Install root (default: \$AGENTIC_PHP_DEBUG_HOME or ~/.agentic-php-debug)
  --ref REF              Git branch or tag to install (default: main)
  --source DIR           Use an existing checkout instead of cloning
                         (default when install.sh is run from inside a checkout)

${B}What${N}
  --project DIR          Set up one PHP project: per-project config, skill link,
                         project-scoped registration
  --remote-root PATH     Docker/VM document root to map onto --project
                         (e.g. /var/www/html). Writes pathMappings for you.
  --port N               Xdebug listen port written into new configs (default: 9003)
  --xdebug               Install/enable Xdebug for the local 'php' if it is missing

${B}MCP client registration${N}
  --client LIST          auto | none | comma list of: claude,codex  (default: auto)
  --mode MODE            all | react | plan | split  (default: all)
                           all   one server exposing every tool
                           split two servers: php-debug (react) + php-debug-plan (plan)
  --allow-command-trigger
                         Let debug plans spawn processes (plan trigger kind "command")

${B}Other${N}
  --uninstall            Remove registrations, links, shims and the install dir
  -y, --yes              Do not ask for confirmation (uninstall)
  -h, --help             This help

${B}Environment${N}
  AGENTIC_PHP_DEBUG_HOME, AGENTIC_PHP_DEBUG_REPO
  (the old PHP_DEBUG_MCP_* names are still accepted)
EOF
}

# --- arguments --------------------------------------------------------------

# Installs from before the rename live in ~/.php-debug-mcp (see migrate_legacy_dir).
LEGACY_DIR="$HOME/.php-debug-mcp"
INSTALL_DIR="${AGENTIC_PHP_DEBUG_HOME:-${PHP_DEBUG_MCP_HOME:-}}"
DEFAULT_DIR=0
[ -n "$INSTALL_DIR" ] || { INSTALL_DIR="$HOME/.agentic-php-debug"; DEFAULT_DIR=1; }
REF=main
SOURCE=
PROJECT=
REMOTE_ROOT=
XDEBUG_PORT=9003
WITH_XDEBUG=0
CLIENTS=auto
MODE=all
ALLOW_CMD=0
UNINSTALL=0
YES=0

need_arg() { [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value (see --help)"; }

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir)          need_arg "$@"; INSTALL_DIR="$2"; DEFAULT_DIR=0; shift ;;
      --ref)          need_arg "$@"; REF="$2"; shift ;;
      --source)       need_arg "$@"; SOURCE="$2"; shift ;;
      --project)      need_arg "$@"; PROJECT="$2"; shift ;;
      --remote-root)  need_arg "$@"; REMOTE_ROOT="$2"; shift ;;
      --port)         need_arg "$@"; XDEBUG_PORT="$2"; shift ;;
      --client)       need_arg "$@"; CLIENTS="$2"; shift ;;
      --mode)         need_arg "$@"; MODE="$2"; shift ;;
      --xdebug)       WITH_XDEBUG=1 ;;
      --allow-command-trigger) ALLOW_CMD=1 ;;
      --uninstall)    UNINSTALL=1 ;;
      -y|--yes)       YES=1 ;;
      -h|--help)      usage; exit 0 ;;
      *)              die "unknown option: $1 (see --help)" ;;
    esac
    shift
  done

  case "$MODE" in all|react|plan|split) ;; *) die "--mode must be all, react, plan or split" ;; esac
  case "$XDEBUG_PORT" in ''|*[!0-9]*) die "--port must be a number" ;; esac
  [ -z "$REMOTE_ROOT" ] || [ -n "$PROJECT" ] || die "--remote-root only makes sense with --project"

  INSTALL_DIR="$(abspath "$INSTALL_DIR")"
  if [ -n "$PROJECT" ]; then
    [ -d "$PROJECT" ] || die "--project directory does not exist: $PROJECT"
    PROJECT="$(cd "$PROJECT" && pwd -P)"
  fi
}

abspath() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    "~"*) printf '%s\n' "$HOME${1#\~}" ;;
    *) printf '%s/%s\n' "$(pwd -P)" "$1" ;;
  esac
}

# When run as a file from inside a checkout, install that checkout in place.
detect_source() {
  [ -z "$SOURCE" ] || { SOURCE="$(cd "$SOURCE" && pwd -P)"; return; }
  local self="${BASH_SOURCE[0]:-}"
  [ -n "$self" ] && [ -f "$self" ] || return 0
  local dir; dir="$(cd "$(dirname "$self")" && pwd -P)"
  if [ -f "$dir/package.json" ] && grep -q '"name": "agentic-php-debug"' "$dir/package.json"; then
    SOURCE="$dir"
  fi
}

# --- prerequisites ----------------------------------------------------------

check_prereqs() {
  step "Checking prerequisites"
  has git  || die "git is required. Install it (macOS: xcode-select --install; Debian/Ubuntu: apt install git)."
  ok "git $(git --version | awk '{print $3}')"

  if ! has node; then
    die "Node.js >= $MIN_NODE is required. Install it from https://nodejs.org, or: brew install node / nvm install --lts"
  fi
  local major; major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge "$MIN_NODE" ] || die "Node.js >= $MIN_NODE is required, found $(node -v). Try: nvm install --lts"
  NODE_BIN="$(command -v node)"
  ok "node $(node -v) ($NODE_BIN)"
  has npm || die "npm is required (it ships with Node.js)"
  ok "npm $(npm -v)"
  case "$NODE_BIN" in
    */.nvm/*|*/.fnm/*|*/.volta/*|*/.asdf/*)
      info "node comes from a version manager; the shims pin this binary so GUI MCP clients find it." ;;
  esac
}

# --- fetch + build ----------------------------------------------------------

# fetch_repo <url> <dest> — clone, or fast-forward an installer-managed clone.
fetch_repo() {
  local url="$1" dest="$2"
  if [ -d "$dest/.git" ]; then
    if [ -n "$(git -C "$dest" status --porcelain --untracked-files=no)" ]; then
      warn "$dest has local changes — not updating it"
      return
    fi
    git -C "$dest" fetch --quiet --depth 1 origin "$REF"
    git -C "$dest" checkout --quiet --detach FETCH_HEAD
    ok "updated $(basename "$dest") to $REF ($(git -C "$dest" rev-parse --short HEAD))"
  elif [ -e "$dest" ]; then
    die "$dest exists but is not a git checkout — move it away or pick another --dir"
  else
    git clone --quiet --depth 1 --branch "$REF" "$url" "$dest"
    ok "cloned $(basename "$dest") @ $REF ($(git -C "$dest" rev-parse --short HEAD))"
  fi
}

# run_in <dir> <cmd…> — build output goes to install.log; its tail is shown only on failure.
run_in() {
  local dir="$1"; shift
  if ! (cd "$dir" && "$@") </dev/null >>"$LOG" 2>&1; then
    printf '\n' >&2; tail -n 25 "$LOG" >&2
    die "'$*' failed in $dir (full log: $LOG)"
  fi
}

npm_install() {
  local dir="$1"
  # A developer's own checkout keeps its node_modules; managed clones get a clean ci.
  if [ -z "$SOURCE" ] && [ -f "$dir/package-lock.json" ] \
    && (cd "$dir" && npm ci --no-audit --no-fund) </dev/null >>"$LOG" 2>&1; then
    return
  fi
  run_in "$dir" npm install --no-audit --no-fund
}

# True when only a pre-rename install exists and no --dir / *_HOME overrides the default.
has_legacy_install() {
  [ "$DEFAULT_DIR" = 1 ] && [ ! -e "$INSTALL_DIR" ] && [ -d "$LEGACY_DIR" ] && [ ! -L "$LEGACY_DIR" ]
}

# Move a pre-rename install to the new default and leave a link behind, so MCP
# client configs that still name ~/.php-debug-mcp/bin/php-debug-mcp keep working.
migrate_legacy_dir() {
  has_legacy_install || return 0
  mv "$LEGACY_DIR" "$INSTALL_DIR"
  ln -s "$INSTALL_DIR" "$LEGACY_DIR"
  ok "moved $LEGACY_DIR to $INSTALL_DIR (the old path is now a link)"
}

install_core() {
  step "Installing the MCP server"
  migrate_legacy_dir
  mkdir -p "$INSTALL_DIR"
  LOG="$INSTALL_DIR/install.log"
  : >"$LOG"
  if [ -n "$SOURCE" ]; then
    CORE_DIR="$SOURCE"
    ok "using checkout $CORE_DIR"
  else
    CORE_DIR="$INSTALL_DIR/agentic-php-debug"
    fetch_repo "$CORE_REPO" "$CORE_DIR"
  fi

  info "npm install (pulls the pinned vscode-php-debug adapter from GitHub)…"
  npm_install "$CORE_DIR"
  info "npm run build…"
  run_in "$CORE_DIR" npm run build

  [ -f "$CORE_DIR/dist/index.js" ] || die "build did not produce dist/index.js"
  [ -f "$CORE_DIR/dist/adapter/phpDebug.js" ] \
    || die "build did not produce dist/adapter/phpDebug.js — $REF ($(git -C "$CORE_DIR" rev-parse --short HEAD 2>/dev/null || echo local)) predates the bundled adapter. Use a newer --ref, or --source <checkout>."
  ok "built server and bundled adapter ($(cat "$CORE_DIR/dist/adapter/VERSION" 2>/dev/null || echo 'adapter'))"
}

# Stable entry points that survive re-installs and pin the node binary, so GUI
# clients (Claude Desktop, Cursor) that do not load your shell profile still work.
write_shims() {
  mkdir -p "$INSTALL_DIR/bin"
  local name target
  # php-debug-mcp is the pre-rename name of the server shim, kept for existing client configs.
  for pair in "agentic-php-debug:dist/index.js" "php-debug-mcp:dist/index.js" "php-debug-plan:dist/plan/cli.js"; do
    name="${pair%%:*}"; target="${pair#*:}"
    cat >"$INSTALL_DIR/bin/$name" <<EOF
#!/bin/sh
# Generated by agentic-php-debug install.sh — re-run the installer to regenerate.
NODE="$NODE_BIN"
[ -x "\$NODE" ] || NODE=node
exec "\$NODE" "$CORE_DIR/$target" "\$@"
EOF
    chmod +x "$INSTALL_DIR/bin/$name"
  done
  SERVER_CMD="$INSTALL_DIR/bin/agentic-php-debug"
  ok "shims in $INSTALL_DIR/bin"

  local bindir="$HOME/.local/bin"
  case ":$PATH:" in
    *":$bindir:"*)
      ln -sf "$INSTALL_DIR/bin/agentic-php-debug" "$bindir/agentic-php-debug"
      ln -sf "$INSTALL_DIR/bin/php-debug-plan" "$bindir/php-debug-plan"
      # Re-point a pre-rename php-debug-mcp link; never create a new one.
      if [ -L "$bindir/php-debug-mcp" ]; then
        case "$(readlink "$bindir/php-debug-mcp")" in
          "$INSTALL_DIR"/*|"$LEGACY_DIR"/*) ln -sf "$INSTALL_DIR/bin/php-debug-mcp" "$bindir/php-debug-mcp" ;;
        esac
      fi
      ok "linked agentic-php-debug and php-debug-plan into $bindir" ;;
    *)
      info "to use the CLIs from a shell: export PATH=\"$INSTALL_DIR/bin:\$PATH\"" ;;
  esac
}

smoke_test() {
  step "Smoke test"
  local out
  if out="$(node -e '
    const { spawn } = require("child_process");
    const [server, cfg] = process.argv.slice(1);
    const p = spawn(process.execPath, [server, "--config", cfg, "--mode", "all"], { stdio: ["pipe", "pipe", "pipe"] });
    let buf = "", err = "";
    const send = (m) => p.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
    const fail = (why) => { console.log(why + (err ? "\n" + err.trim() : "")); p.kill(); process.exit(1); };
    const timer = setTimeout(() => fail("no answer within 15s"), 15000);
    p.stderr.on("data", (d) => (err += d));
    p.on("exit", (code) => fail("server exited with code " + code));
    p.stdout.on("data", (d) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0; ) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) { send({ method: "notifications/initialized" }); send({ id: 2, method: "tools/list" }); }
        if (m.id === 2) { clearTimeout(timer); p.removeAllListeners("exit"); p.kill(); console.log(m.result.tools.length); process.exit(0); }
      }
    });
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "install.sh", version: "0" } } });
  ' "$CORE_DIR/dist/index.js" "$GLOBAL_CONFIG" 2>&1)"; then
    ok "server answers over stdio MCP and lists $out tools"
  else
    die "the server did not start cleanly:
$out"
  fi
}

# --- configuration ----------------------------------------------------------

# write_config <file> [remote local] — never overwrites a config the user edited.
write_config() {
  local file="$1" map_remote="${2:-}" map_local="${3:-}"
  if [ -f "$file" ]; then
    ok "kept existing $file"
    return
  fi
  node -e '
    const [file, port, remote, local] = process.argv.slice(1);
    const cfg = { port: Number(port), stopOnEntry: false, pathMappings: {} };
    if (remote) cfg.pathMappings[remote] = local;
    require("fs").writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  ' "$file" "$XDEBUG_PORT" "$map_remote" "$map_local"
  ok "wrote $file"
}

configure() {
  step "Configuration"
  GLOBAL_CONFIG="$INSTALL_DIR/config.json"
  write_config "$GLOBAL_CONFIG"
  CONFIG="$GLOBAL_CONFIG"
  RUNS_DIR=
  if [ -n "$PROJECT" ]; then
    CONFIG="$PROJECT/.agentic-php-debug.json"
    if [ ! -f "$CONFIG" ] && [ -f "$PROJECT/.php-debug-mcp.json" ]; then
      CONFIG="$PROJECT/.php-debug-mcp.json"
      info "using the pre-rename $CONFIG — rename it to .agentic-php-debug.json when convenient"
    fi
    write_config "$CONFIG" "$REMOTE_ROOT" "$PROJECT"
    RUNS_DIR="$PROJECT/.php-debug-plan/runs"
    [ -z "$REMOTE_ROOT" ] || info "maps $REMOTE_ROOT (container) → $PROJECT (host)"
  fi
}

# --- MCP client registration ------------------------------------------------

# server_args <mode> — the argv after the command, one arg per line.
server_args() {
  printf '%s\n' --config "$CONFIG" --mode "$1"
  if [ "$1" != react ] && [ "$ALLOW_CMD" = 1 ]; then printf '%s\n' --allow-command-trigger; fi
  if [ "$1" != react ] && [ -n "$RUNS_DIR" ]; then printf '%s\n' --runs-dir "$RUNS_DIR"; fi
}

# entries — "name mode" lines for the chosen --mode.
entries() {
  case "$MODE" in
    split) printf '%s\n' "php-debug react" "php-debug-plan plan" ;;
    *)     printf '%s\n' "php-debug $MODE" ;;
  esac
}

wants_client() {
  case ",$CLIENTS," in
    *,none,*) return 1 ;;
    *,auto,*) has "$1" ;;
    *",$1,"*) has "$1" || { warn "--client $1 given but '$1' is not on PATH"; return 1; } ;;
    *) return 1 ;;
  esac
}

register_claude() {
  # Project installs go to Claude Code's "local" scope: per-user, per-project,
  # kept in ~/.claude.json — so no absolute home paths land in a committed .mcp.json.
  local scope=user where="$HOME"
  [ -z "$PROJECT" ] || { scope=local; where="$PROJECT"; }
  local name mode args
  while read -r name mode; do
    args=(); while IFS= read -r a; do args+=("$a"); done < <(server_args "$mode")
    (cd "$where" && claude mcp remove -s "$scope" "$name" </dev/null >/dev/null 2>&1) || true
    (cd "$where" && claude mcp add -s "$scope" "$name" -- "$SERVER_CMD" "${args[@]}" </dev/null >/dev/null)
    ok "Claude Code: $name ($mode mode, $scope scope)"
  done < <(entries)
}

register_codex() {
  [ -z "$PROJECT" ] || info "Codex has no per-project scope; its entry points at this project's config."
  local name mode args
  while read -r name mode; do
    args=(); while IFS= read -r a; do args+=("$a"); done < <(server_args "$mode")
    codex mcp remove "$name" </dev/null >/dev/null 2>&1 || true
    codex mcp add "$name" -- "$SERVER_CMD" "${args[@]}" </dev/null >/dev/null
    ok "Codex: $name ($mode mode)"
  done < <(entries)
}

register_clients() {
  step "Registering with MCP clients"
  local any=0
  if wants_client claude; then register_claude; any=1; fi
  if wants_client codex;  then register_codex;  any=1; fi
  [ "$any" = 1 ] || info "no CLI clients registered (--client $CLIENTS)"
  write_client_snippet
}

# For clients without a registration CLI (Claude Desktop, Cursor, Kiro, Windsurf).
write_client_snippet() {
  SNIPPET="$INSTALL_DIR/mcp.json"
  # stdin: "@name" starts a server, every following line is one of its args.
  local name mode
  while read -r name mode; do printf '@%s\n' "$name"; server_args "$mode"; done < <(entries) \
    | node -e '
      const [file, command] = process.argv.slice(1);
      const servers = {};
      let args;
      for (const line of require("fs").readFileSync(0, "utf8").split("\n").filter(Boolean)) {
        if (line.startsWith("@")) servers[line.slice(1)] = { command, args: (args = []) };
        else args.push(line);
      }
      require("fs").writeFileSync(file, JSON.stringify({ mcpServers: servers }, null, 2) + "\n");
    ' "$SNIPPET" "$SERVER_CMD"
  ok "config for other clients: $SNIPPET"
  info "paste its mcpServers into claude_desktop_config.json, ~/.cursor/mcp.json or .kiro/settings/mcp.json"
}

# --- skill ------------------------------------------------------------------

link_skill() {
  local src="$CORE_DIR/skills/php-debug-modes"
  [ -d "$src" ] || { warn "this ref has no skills/php-debug-modes — skipping the agent skill"; return; }
  step "Agent skill"
  local base
  if [ -n "$PROJECT" ]; then base="$PROJECT/.claude/skills"; else base="$HOME/.claude/skills"; fi
  local dest="$base/php-debug-modes"
  mkdir -p "$base"
  if [ -e "$dest" ] && [ ! -L "$dest" ]; then
    warn "$dest exists and is not a link — leaving it alone"
  else
    ln -sfn "$src" "$dest"
    ok "php-debug-modes → $dest"
  fi
}

# --- PHP + Xdebug -----------------------------------------------------------

php_ini() { php -r "echo ini_get('$1');" 2>/dev/null; }

check_xdebug() {
  step "PHP + Xdebug"
  if ! has php; then
    info "no 'php' on PATH. Fine if PHP runs in Docker/DDEV/a VM — see the Xdebug notes below."
    XDEBUG_STATE=nophp
    return
  fi
  ok "php $(php -r 'echo PHP_VERSION;')"

  local xv; xv="$(php -r 'echo phpversion("xdebug") ?: "";' 2>/dev/null)"
  if [ -z "$xv" ] && [ "$WITH_XDEBUG" = 1 ]; then
    install_xdebug
    xv="$(php -r 'echo phpversion("xdebug") ?: "";' 2>/dev/null)"
  fi
  if [ -z "$xv" ]; then
    warn "Xdebug is not loaded in the local PHP"
    XDEBUG_STATE=missing
    return
  fi
  case "$xv" in 2.*) warn "Xdebug $xv is too old — Xdebug 3 is required"; XDEBUG_STATE=old; return ;; esac
  ok "xdebug $xv"

  local mode swr cport
  mode="$(php_ini xdebug.mode)"; swr="$(php_ini xdebug.start_with_request)"; cport="$(php_ini xdebug.client_port)"
  case ",$mode," in
    *,debug,*) ok "xdebug.mode=$mode" ;;
    *)
      if [ "$WITH_XDEBUG" = 1 ] && write_xdebug_ini; then
        mode="$(php_ini xdebug.mode)"; swr="$(php_ini xdebug.start_with_request)"; cport="$(php_ini xdebug.client_port)"
        ok "xdebug.mode=$mode"
      else
        warn "xdebug.mode=$mode — must include 'debug'"
      fi ;;
  esac
  case "$swr" in
    yes|trigger) ok "xdebug.start_with_request=$swr" ;;
    *) warn "xdebug.start_with_request=${swr:-default} — use 'trigger' (plans send the trigger for you) or 'yes'" ;;
  esac
  [ "$cport" = "$XDEBUG_PORT" ] && ok "xdebug.client_port=$cport" \
    || warn "xdebug.client_port=$cport but the server listens on $XDEBUG_PORT"
  XDEBUG_STATE=ok
}

install_xdebug() {
  info "installing Xdebug…"
  case "$(uname -s)" in
    Darwin)
      if has pecl; then
        pecl install xdebug </dev/null >/dev/null 2>&1 && ok "pecl install xdebug" || warn "pecl install xdebug failed — run it yourself to see why"
      else
        warn "no 'pecl' — install PHP with Homebrew (brew install php) or add Xdebug to your PHP by hand"
      fi ;;
    *)
      # Package managers need root; say exactly what to run instead of sudo-ing.
      if has apt-get; then warn "run: sudo apt-get install php-xdebug   (then re-run this installer)"
      elif has dnf;   then warn "run: sudo dnf install php-pecl-xdebug3   (then re-run this installer)"
      elif has apk;   then warn "run: sudo apk add php\$(php -r 'echo PHP_MAJOR_VERSION.PHP_MINOR_VERSION;')-pecl-xdebug"
      else warn "install Xdebug 3 for your PHP: https://xdebug.org/docs/install"; fi ;;
  esac
  write_xdebug_ini || true
}

# Settings only — the zend_extension line is the package's/pecl's job, and a
# second one makes PHP warn "Cannot load Xdebug - it was already loaded".
write_xdebug_ini() {
  local scan; scan="$(php -r 'echo PHP_CONFIG_FILE_SCAN_DIR;' 2>/dev/null)"
  local ini="$scan/99-agentic-php-debug.ini"
  if [ -z "$scan" ] || [ ! -w "$scan" ]; then
    warn "cannot write to PHP's ini scan dir (${scan:-none}) — add the settings below by hand"
    return 1
  fi
  cat >"$ini" <<EOF
; Written by agentic-php-debug install.sh
xdebug.mode=debug
; "trigger": only requests/processes carrying XDEBUG_TRIGGER or XDEBUG_SESSION
; start a session. Debug plans send it for you; in a browser use ?XDEBUG_TRIGGER=1.
xdebug.start_with_request=trigger
xdebug.client_host=127.0.0.1
xdebug.client_port=$XDEBUG_PORT
EOF
  ok "wrote $ini"
  # Drop the pre-rename file so the settings are not loaded twice — only if we wrote it.
  local legacy="$scan/99-php-debug-mcp.ini"
  if [ -f "$legacy" ] && [ "$(head -n 1 "$legacy")" = "; Written by php-debug-mcp install.sh" ]; then
    rm -f "$legacy" && ok "removed the pre-rename $legacy"
  fi
}

# --- uninstall --------------------------------------------------------------

uninstall() {
  if has_legacy_install; then INSTALL_DIR="$LEGACY_DIR"; fi
  step "Uninstalling from $INSTALL_DIR"
  case "$INSTALL_DIR" in /|"$HOME"|"$HOME"/) die "refusing to remove $INSTALL_DIR" ;; esac
  if [ -d "$INSTALL_DIR" ] && [ ! -e "$INSTALL_DIR/bin/agentic-php-debug" ] && [ ! -e "$INSTALL_DIR/bin/php-debug-mcp" ] \
    && [ ! -d "$INSTALL_DIR/agentic-php-debug" ] && [ ! -d "$INSTALL_DIR/ts-php-debug-mcp" ]; then
    die "$INSTALL_DIR does not look like an agentic-php-debug install — not removing it"
  fi
  if [ "$YES" != 1 ]; then
    if [ -r /dev/tty ]; then
      printf '  Remove registrations, links and %s? [y/N] ' "$INSTALL_DIR"
      local reply; read -r reply </dev/tty || reply=
      case "$reply" in y|Y|yes) ;; *) die "aborted" ;; esac
    else
      die "no terminal to confirm on — re-run with --yes"
    fi
  fi
  local n
  for n in php-debug php-debug-plan; do
    if has claude; then
      claude mcp remove -s user "$n" >/dev/null 2>&1 && ok "Claude Code (user): removed $n" || true
      [ -z "$PROJECT" ] || { (cd "$PROJECT" && claude mcp remove -s local "$n" >/dev/null 2>&1) && ok "Claude Code (local): removed $n" || true; }
    fi
    # `codex mcp remove` exits 0 even when nothing matched, so ask first.
    if has codex && codex mcp get "$n" </dev/null >/dev/null 2>&1; then
      codex mcp remove "$n" </dev/null >/dev/null 2>&1 && ok "Codex: removed $n"
    fi
  done
  local link
  for link in "$HOME/.claude/skills/php-debug-modes" "${PROJECT:+$PROJECT/.claude/skills/php-debug-modes}" \
              "$HOME/.local/bin/agentic-php-debug" "$HOME/.local/bin/php-debug-mcp" "$HOME/.local/bin/php-debug-plan"; do
    [ -n "$link" ] && [ -L "$link" ] || continue
    case "$(readlink "$link")" in
      "$INSTALL_DIR"/*|"$LEGACY_DIR"/*|*/agentic-php-debug/*|*/ts-php-debug-mcp/*) rm -f "$link"; ok "removed $link" ;;
    esac
  done
  local scan ini; scan="$(php -r 'echo PHP_CONFIG_FILE_SCAN_DIR;' 2>/dev/null || true)"
  for ini in "$scan/99-agentic-php-debug.ini" "$scan/99-php-debug-mcp.ini"; do
    [ -z "$scan" ] || [ ! -f "$ini" ] || info "left $ini in place (Xdebug settings) — delete it if you no longer want them"
  done
  rm -rf "$INSTALL_DIR"
  ok "removed $INSTALL_DIR"
  # The link migrate_legacy_dir left behind.
  if [ -L "$LEGACY_DIR" ] && [ "$(readlink "$LEGACY_DIR")" = "$INSTALL_DIR" ]; then
    rm -f "$LEGACY_DIR"
    ok "removed $LEGACY_DIR"
  fi
  info "project files (.agentic-php-debug.json or .php-debug-mcp.json, .php-debug-plan/) are yours and were left alone"
}

# --- summary ----------------------------------------------------------------

summary() {
  step "Done"
  printf '  server     %s\n' "$SERVER_CMD"
  printf '  config     %s\n' "$CONFIG"
  printf '  other MCP  %s\n' "$SNIPPET"
  [ -z "$PROJECT" ] || printf '  project    %s\n' "$PROJECT"

  case "${XDEBUG_STATE:-}" in
    ok) ;;
    *)
      printf '\n  %sXdebug still needs setting up.%s Xdebug dials OUT to this server on port %s.\n' "$B" "$N" "$XDEBUG_PORT"
      cat <<EOF
  Local PHP (php.ini or a conf.d file):
      zend_extension=xdebug
      xdebug.mode=debug
      xdebug.start_with_request=trigger
      xdebug.client_port=$XDEBUG_PORT
  Docker:  same settings, plus  xdebug.client_host=host.docker.internal
           and re-run with  --project <dir> --remote-root /var/www/html
  DDEV:    ddev xdebug on   (then --remote-root /var/www/html)
EOF
      ;;
  esac

  printf '\n  %sTry it%s — in your PHP project ask the agent:\n' "$B" "$N"
  printf '      "Use php-debug to find out why <something> is wrong in <file>."\n'
  printf '  Plans without an agent:  php-debug-plan run my-bug.debugplan.json --config %s\n' "$CONFIG"
  [ "$WARNINGS" = 0 ] || printf '\n  %s%d warning(s) above.%s\n' "$Y" "$WARNINGS" "$N"
  printf '  Re-run this installer any time to update.\n'
}

# --- main -------------------------------------------------------------------

main() {
  parse_args "$@"
  if [ "$UNINSTALL" = 1 ]; then uninstall; return; fi
  detect_source
  check_prereqs
  install_core
  configure
  write_shims
  smoke_test
  register_clients
  link_skill
  check_xdebug
  summary
}

# Everything runs from here, so a truncated `curl | bash` download does nothing.
main "$@"
