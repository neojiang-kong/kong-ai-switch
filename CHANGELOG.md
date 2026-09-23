# Changelog

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
