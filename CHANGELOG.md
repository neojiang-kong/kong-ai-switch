# Changelog

## 0.2.9

### Features
- **Cost attribution for Codex.** Kong reports Agent session, Agent request kind, Repository, Source control provider, Commit, Agent ID, Parent agent and Agent type from Codex itself, so only **Branch** (`ai-cost-scm-branch`) and **Project** (`ai-cost-project`) need headers, plus any custom headers.
- Static values go into the managed `[model_providers.kong]` block of `~/.codex/config.toml` as an inline `http_headers` table, merged after the key-auth credential (never dropped). **Branch: Auto from git** uses `env_http_headers = { ai-cost-scm-branch = "KONG_AI_SCM_BRANCH" }` and writes `~/.kong-ai-switch/codex-attribution.sh`, a sourceable `codex()` wrapper that sets the variable from `git branch --show-current` per launch. Rc files are never edited. Disabling removes only attribution entries.
- The app's **Attribution…** button now appears for Codex too. The panel follows the selected agent: its own "Sent by … automatically" list and only the fields that agent needs headers for. The hint-headers toggle is Claude Code only.

### CLI
- `attribution set|show|clear` take `--agent claude-code|codex` (default `claude-code`). For Codex, `--scm-provider`, `--repository` and `--hint-headers` are refused with an explanation. `use --agent codex` applies the stored Codex attribution, and `set`/`clear` re-apply immediately when Codex already points at that environment.
- `--json` keeps its existing fields (for the chosen agent) and adds `agent` plus an `agents` map with every agent's attribution.

### Changes
- Attribution is stored per agent within each environment (`attribution.claudeCode`, `attribution.codex`). The 0.2.7/0.2.8 single record is read as Claude Code's and migrated on the next save; `env export`/`env import` carry both shapes.
- Claude Code attribution output and behaviour are unchanged.

## 0.2.8

### Changes
- **Attribution grouped by the tags Kong reports** for Claude Code. The app's Attribution… panel now has three groups: **Sent by Claude Code automatically** (Agent session, Agent ID, Parent agent, Agent request kind, Agent type, with the gateway hint headers toggle and a warning that request kind and agent type are not sent when it is off), **From the headers you add** (Source control provider, Repository, Branch, each with its `ai-cost-scm-*` header and the Auto from git options), and **Additional headers** (`ai-cost-project` and custom headers).
- `attribution show` prints the same three groups. `--json` gains a `tags` object (`autoSent`, `fromHeaders`, `additional`); existing fields are unchanged.
- README "Cost attribution for Claude Code" lists the tags you get.

## 0.2.7

### Features
- **Claude Code cost attribution** — Kong AI cost-management headers (`ai-cost-project`, `ai-cost-scm-provider`, `ai-cost-scm-repository`, `ai-cost-scm-branch`, plus any custom `Name: value` headers) and `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`, stored per environment in `~/.kong-ai-switch/config.json` (and carried by `env export`/`env import`).
- **Attribution… panel in the macOS app** (footer, when Claude Code is selected): enable toggle, gateway hint headers toggle, project, SCM provider picker, repository/branch as a fixed value or **Auto from git**, editable extra headers, and a live preview of the header block and the `~/.zshrc` source line.
- Static headers are merged into `~/.claude/settings.json` `env.ANTHROPIC_CUSTOM_HEADERS` after the key-auth credential header, which is never dropped. Disabling removes only attribution lines and `CLAUDE_CODE_GATEWAY_HINT_HEADERS` (now an owned key).
- **Auto from git** writes `~/.kong-ai-switch/claude-attribution.sh`, a sourceable `claude()` wrapper that computes repository (`owner/repo`, from https/ssh/scp/Azure DevOps remotes) and branch at launch. Shell rc files are never edited; the source line is shown in the app and CLI output.
- **Kong app icon** — `KongAISwitch.app` now shows the Kong logomark in Finder and Launchpad (`macapp/Resources/AppIcon.icns`, regenerated with `macapp/scripts/make-icon.sh`).

### CLI
- New `attribution set|show|clear` (`--project`, `--scm-provider`, `--repository <owner/repo>|auto`, `--branch <name>|auto`, repeatable `--header 'Name: value'`, `--remove-header`, `--clear-headers`, `--hint-headers`, `--enabled`, `--json`). `use --agent claude-code` applies the stored attribution, and `set`/`clear` re-apply immediately when Claude Code already points at that environment.
- Flags accept `--name=value` (allows empty values and values starting with `--`).
- Header names are validated as HTTP tokens; values are trimmed and must be a single line.

## 0.2.6

### Features
- **Konnect region selection in the macOS app** — the token step of environment setup has a **Region** picker (Auto-detect, US, EU, AU, ME, IN, SG). Auto-detect searches every region as before; picking one runs discovery against that region only. The confirm/edit step also has a Region picker, preselected from the discovered gateway or the existing environment, and the choice is saved with the environment.
- Setup panel now uses the same 380pt width as the rest of the menu bar panel.

## 0.2.5

### Features
- **Claude Desktop writer options in the macOS app** — footer **Desktop…** opens settings for credential mode (Static JWT / Interactive OIDC), model discovery, trailing slash, label override, and OIDC fields (client id, scopes, redirect port, bearer token type, offline access, auth flow). Credential sheet shows the same mode picker. Prefs persist in UserDefaults; every Desktop switch forwards matching CLI flags. Interactive mode never writes `inferenceGatewayApiKey`.

### CLI
- `use` accepts `--desktop-credential-mode`, `--desktop-model-discovery`, `--desktop-trailing-slash`, `--desktop-label-override`, and OIDC field flags (`--oidc-scopes`, `--oidc-redirect-port`, `--oidc-bearer-token-type`, `--oidc-append-offline-access`, `--oidc-auth-flow`).

## 0.2.4

### Fixes
- **Claude Desktop OIDC** with a signed-in token now writes a **static** gateway profile (`inferenceGatewayApiKey` + `modelDiscoveryEnabled: false`, no trailing slash) — the same shape as a working Desktop-exported config. Interactive OIDC is only written when no token is supplied. Mixing interactive + API key is still avoided.

## 0.2.3

### Fixes
- **Claude Desktop "Couldn't load configuration"** — the owned configLibrary profile id was not a valid UUID (14-character final segment). Claude Desktop logs `readConfig failed unknown config id` and the 3P settings page fails. Replaced with a real UUID and removes the legacy invalid entry on switch.

## 0.2.2

### Fixes
- **Claude Desktop 3P settings page** no longer breaks after a Kong AI Switch: interactive OIDC profiles no longer also write `inferenceGatewayApiKey` (mixed modes make Configure Third-Party Inference fail to load).
- Entra (Microsoft) OIDC uses the real Application (client) ID (`azp` / `--oidc-client-id` / `KONG_AI_OIDC_CLIENT_ID`), not the Keycloak-style `claude-desktop` string.

## 0.2.1

### Fixes
- **Claude Desktop** now writes `~/Library/Application Support/Claude-3p/configLibrary/` (third-party inference), not `~/.claude/settings.json`. Claude Code and Claude Desktop no longer share a file — select **Claude Desktop** in the app and switch again, then fully quit/reopen Claude Desktop.

## 0.2.0

### macOS app
- **Bundled CLI** inside `KongAISwitch.app` — download the zip, install Node.js 20+, and run. No manual CLI copy.
- Clearer setup errors when **Node.js** is missing vs when the CLI script is missing.
- Official **Kong electric-lime** logomark plus Claude / OpenAI / Anthropic / GitHub marks in the menu.
- **Sign in with browser** for OIDC (PKCE loopback, same pattern as Claude Desktop: `claude-desktop` → `http://127.0.0.1:53180/callback`).
- OIDC from the Key / Update flow uses **Switch** (one-shot token) instead of a disabled Save.
- Menu bar Kong mark sized for the status item; `.app` packaging fixes for resource + CLI layout.

### Distribution
- Pre-built `dist/KongAISwitch-macOS.zip` and GitHub Release assets.
- README screenshot of the menu panel.

### Hygiene
- Removed non-generic IdP / path fixtures from tests before sharing the repo publicly.

## 0.1.0

- Initial menu bar app + CLI for Kong AI Gateway model switching (Claude Code, Codex, Copilot).
- Environments, gateway picker, key-auth / OIDC credentials, Keychain storage for API keys.
