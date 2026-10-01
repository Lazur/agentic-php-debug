# Installing PHP Debug MCP

Five minutes from nothing to an agent that can set breakpoints in your running PHP.

```bash
curl -fsSL https://raw.githubusercontent.com/Lazur/php-debug-mcp/main/install.sh | bash
```

This clones and builds the server into `~/.php-debug-mcp`, registers it with Claude Code and
Codex if they are installed, links the `php-debug-modes` agent skill, and checks your PHP for
Xdebug. It runs a smoke test before it registers anything. Re-run the same command to update.

Want to read it first? `curl -fsSLO …/install.sh && less install.sh && bash install.sh`.

## What you need

| | Why | Check |
|---|---|---|
| **Node.js 20+** | runs the server and the bundled DAP adapter | `node -v` |
| **git** | the installer clones the repo | `git --version` |
| **PHP with Xdebug 3** — locally, or in Docker / DDEV / a VM | the thing being debugged | `php -v` shows `with Xdebug v3…` |

Nothing else. The DAP adapter (`vscode-php-debug`) is bundled at build time, so you do not
clone or build it yourself.

## Pick your setup

**Claude Code or Codex, PHP on this machine:**

```bash
curl -fsSL …/install.sh | bash -s -- --xdebug
```

`--xdebug` installs Xdebug with `pecl` on macOS/Homebrew and writes the settings below. On Linux it
prints the one `apt`/`dnf`/`apk` command to run instead, because it will not `sudo` for you.

**A project in Docker (or DDEV, Lando, a VM):**

```bash
curl -fsSL …/install.sh | bash -s -- --project ~/code/my-app --remote-root /var/www/html
```

`--project` writes `my-app/.php-debug-mcp.json` with the path mapping container → host, registers
the server for that project only (Claude Code *local* scope, so no personal paths end up in a
committed `.mcp.json`), links the skill into `my-app/.claude/skills/`, and stores plan runs in
`my-app/.php-debug-plan/runs/`.

**VS Code with Copilot agent mode** (you watch the debugger while the agent drives it):

```bash
curl -fsSL …/install.sh | bash -s -- --vscode --project ~/code/my-app
```

This builds and installs the *Agentic Debug* extension and copies the `DebugAgent` and
`DebugPlanner` custom agents into `my-app/.github/agents/`. It needs the `code` command
(VS Code: *Shell Command: Install 'code' command in PATH*).

**Claude Desktop, Cursor, Kiro, Windsurf, or any other MCP client:** run the installer, then copy
the `mcpServers` block from `~/.php-debug-mcp/mcp.json` into that client's config file:

| Client | Config file |
|---|---|
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` |
| Kiro | `.kiro/settings/mcp.json` |

The entry calls `~/.php-debug-mcp/bin/php-debug-mcp`. That shim pins the `node` binary found at
install time, so GUI apps that do not load your shell profile (nvm, fnm, Volta) still start it.

### Installer options

| Option | Default | Effect |
|---|---|---|
| `--project DIR` | none | Per-project config, registration, skill and agent files |
| `--remote-root PATH` | none | Map a container path onto `--project` (Docker/VM) |
| `--port N` | `9003` | Xdebug port the server listens on |
| `--client LIST` | `auto` | `claude`, `codex`, both, or `none`. `auto` = whichever is on `PATH` |
| `--mode MODE` | `all` | `all` = one server with every tool; `split` = `php-debug` (ReAct) + `php-debug-plan` (plan); `react` or `plan` = only that one |
| `--allow-command-trigger` | off | Let debug plans start processes (`"trigger": {"kind": "command"}`). Without it, plans can only use HTTP triggers |
| `--vscode` | off | Build and install the VS Code extension |
| `--xdebug` | off | Install/configure Xdebug for the local `php` |
| `--dir DIR` | `~/.php-debug-mcp` | Install root (or set `PHP_DEBUG_MCP_HOME`) |
| `--ref REF` | `main` | Branch or tag |
| `--source DIR` | none | Build an existing checkout instead of cloning (the default when you run `./install.sh` from a clone) |
| `--uninstall [--yes]` | | Remove everything the installer added |

## Xdebug

**Xdebug connects to the debugger, not the other way round.** The server *listens* on port 9003,
and PHP *dials out* to it when a request starts. Almost every "it never stops" problem comes down to
this.

Local PHP: add this to `php.ini` or a `conf.d/` file. `--xdebug` does it for you.

```ini
zend_extension=xdebug          ; skip this line if pecl or your package already added it
xdebug.mode=debug
xdebug.start_with_request=trigger
xdebug.client_port=9003
```

`trigger` means only requests that ask for a session start one. Debug plans send the trigger
themselves (`XDEBUG_SESSION` cookie, `XDEBUG_TRIGGER` env var). For a request you make by hand, add
`?XDEBUG_TRIGGER=1` or use a browser extension such as Xdebug Helper. `yes` also works, but then
every `php` command, including `composer`, tries to connect and slows down when nothing is listening.

Docker: use the same settings, plus the address of the host as seen from the container:

```ini
xdebug.client_host=host.docker.internal
```

On Linux Docker, add `extra_hosts: ["host.docker.internal:host-gateway"]` to the service.

DDEV: run `ddev xdebug on`. Use `--remote-root /var/www/html`.

## Check that it works

```bash
claude mcp get php-debug            # Status: ✔ Connected
```

Then, in your PHP project, ask the agent something it cannot answer from the source alone:

> Use php-debug to find out why `$total` is wrong in `src/Cart.php` when I load `/cart`.

The agent calls `debug_launch`, sets a breakpoint, and waits. Load the page; the agent then reads
the live variables.

You can run a debug plan with no agent at all:

```bash
~/.php-debug-mcp/bin/php-debug-plan run my-bug.debugplan.json --config ~/.php-debug-mcp/config.json
```

## Update and uninstall

```bash
curl -fsSL …/install.sh | bash                    # update: same command, same flags
curl -fsSL …/install.sh | bash -s -- --uninstall  # remove (asks first; add --yes in CI)
```

Uninstall removes the MCP registrations, skill links, shims, the VS Code extension and
`~/.php-debug-mcp`. It leaves project files (`.php-debug-mcp.json`, `.php-debug-plan/`,
`.github/agents/`) and any Xdebug ini file in place.

## Manual install

What the script does, by hand:

```bash
git clone https://github.com/Lazur/php-debug-mcp.git ts-php-debug-mcp   # dir name matters for the VS Code extension
cd ts-php-debug-mcp && npm ci && npm run build
echo '{ "port": 9003, "pathMappings": {} }' > ~/php-debug.json
claude mcp add -s user php-debug -- node "$PWD/dist/index.js" --config ~/php-debug.json --mode all
ln -s "$PWD/skills/php-debug-modes" ~/.claude/skills/php-debug-modes
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `debug_launch`: *Port 9003 … is already in use* | Something else holds 9003: VS Code's *Listen for Xdebug*, a second `php-debug` server, PhpStorm | `lsof -nP -iTCP:9003 -sTCP:LISTEN`. Stop that process, or use `--port 9013` together with `xdebug.client_port=9013` |
| Xdebug never connects | No trigger sent, wrong `client_host` in Docker, or the port is not the same on both sides | `php -i \| grep xdebug.client` on the PHP side. Docker needs `host.docker.internal` |
| Breakpoint shows as verified but never hits | Path mapping is wrong, or the breakpoint is on a line that does not run (a comment, a closing brace) | Check `pathMappings` in `.php-debug-mcp.json`. Put breakpoints on statements |
| GUI client: *spawn node ENOENT* | The client does not have your shell's `PATH` | Use the `~/.php-debug-mcp/bin/php-debug-mcp` shim, not `node`. Re-run the installer after you change Node versions |
| Installer: *predates the bundled adapter* | The ref is older than the bundled-adapter build | Use a newer `--ref`, or `--source` with a current checkout |

More: `skills/php-debug-modes/references/troubleshooting.md` covers every run outcome and error code.
The build log of the last install is at `~/.php-debug-mcp/install.log`.
