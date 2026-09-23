# Changelog

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
