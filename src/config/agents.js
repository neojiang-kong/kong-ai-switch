/**
 * Coding agents that can be pointed at a Kong AI Gateway.
 *
 * One gateway, many clients. Each agent reads a different file in a different
 * format, so an agent is described by where its config lives, what shape it
 * takes, and which Kong model formats it can actually talk to.
 *
 * That last part matters: Claude Code speaks the Anthropic Messages API and
 * Codex speaks OpenAI, so the same AI Model is not usable from both unless
 * the gateway exposes it in the matching format. Offering a switch that would
 * 404 is worse than not offering it, so each agent declares what it accepts.
 *
 * `switchable: false` agents are detected only. They appear in `agents` and
 * in the menu, and `use` refuses them. Detection lives on `install` and
 * looks for the product, never for a file this tool writes.
 */

import { execFile } from "node:child_process";
import { readFile, writeFile, rename, mkdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { authWithKind } from "../kong/auth.js";
import {
  ATTRIBUTION_HEADERS,
  CODEX_BRANCH_ENV,
  applyAttributionToEnv,
  attributionWrapperPath,
  buildAttributionWrapper,
  buildCodexAttributionWrapper,
  buildInactiveWrapper,
  managedHeaderNames,
  readAttribution,
  staticAttributionHeaders,
  usesAutoGit,
} from "./attribution.js";
import { detectAgentInstall } from "./install.js";

/** Local Claude Desktop 3P configLibrary root for this OS. */
export function claudeDesktopLibraryDir(home = homedir()) {
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Claude-3p", "configLibrary");
  }
  if (process.platform === "win32") {
    return path.join(home, "AppData", "Local", "Claude-3p", "configLibrary");
  }
  return path.join(home, ".config", "Claude-3p", "configLibrary");
}

/** Agents this tool can configure. */
export const AGENTS = {
  "claude-code": {
    id: "claude-code",
    name: "Claude Code",
    vendor: "anthropic",
    /** Kong model formats this agent can call. */
    formats: ["anthropic"],
    kind: "json-env",
    configPath: (home) => path.join(home, ".claude", "settings.json"),
    /** Keys this tool owns; everything else in the file is the user's. */
    ownedKeys: [
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_CUSTOM_HEADERS",
      "ANTHROPIC_MODEL",
      "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT",
      "CLAUDE_CODE_GATEWAY_HINT_HEADERS",
    ],
    switchable: true,
    /** `claude` on the usual bin paths, or the native installer at ~/.claude/local. Not settings.json. */
    install: {
      binaries: ["claude"],
      paths: (home) => [path.join(home, ".claude", "local")],
    },
  },

  "claude-desktop": {
    id: "claude-desktop",
    name: "Claude Desktop",
    vendor: "anthropic",
    formats: ["anthropic"],
    // Claude Desktop on 3P reads configLibrary, NOT ~/.claude/settings.json.
    // See https://claude.com/docs/third-party/claude-desktop/configuration
    kind: "claude-desktop-3p",
    configPath: (home) => claudeDesktopLibraryDir(home),
    /** Stable profile id we own inside configLibrary (must be a real UUID). */
    profileId: "6b6f6e67-6169-4e67-8a19-737769746368",
    profileName: "Kong AI Switch",
    ownedKeys: [
      "inferenceProvider",
      "inferenceGatewayBaseUrl",
      "inferenceGatewayApiKey",
      "inferenceGatewayAuthScheme",
      "inferenceCredentialKind",
      "inferenceGatewayOidc",
      "inferenceGatewayOidcAuthFlow",
      "inferenceCustomHeaders",
      "inferenceModels",
      "modelDiscoveryEnabled",
    ],
    switchable: true,
    /** Claude.app in /Applications or ~/Applications, confirmed by bundle id. Not configLibrary. */
    install: {
      apps: [{ name: "Claude.app", bundleId: "com.anthropic.claudefordesktop" }],
    },
  },

  codex: {
    id: "codex",
    name: "Codex CLI",
    vendor: "openai",
    formats: ["openai"],
    kind: "codex-toml",
    configPath: (home) => path.join(home, ".codex", "config.toml"),
    ownedKeys: ["model_provider", "model", "model_providers.kong"],
    switchable: true,
    /** The `codex` binary. The managed block in config.toml is not an install. */
    install: {
      binaries: ["codex"],
    },
  },

  /**
   * GitHub Copilot CLI (BYOK). Provider URL and key are env vars at launch,
   * so we write both ~/.copilot/settings.json (model) and a sourced env file.
   * Docs: https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models
   */
  "github-copilot": {
    id: "github-copilot",
    name: "GitHub Copilot",
    vendor: "github",
    formats: ["openai", "anthropic"],
    kind: "copilot",
    configPath: (home) => path.join(home, ".copilot", "settings.json"),
    envPath: (home) => path.join(home, ".copilot", "kong-ai-switch.env"),
    ownedKeys: ["model", "COPILOT_PROVIDER_BASE_URL", "COPILOT_MODEL"],
    switchable: true,
    /** The `copilot` CLI binary only. Not the VS Code extension, settings.json, or kong-ai-switch.env. */
    install: {
      binaries: ["copilot"],
    },
  },

  /**
   * Cursor Private Inference, the build Magpie wires to an external gateway.
   *
   * Magpie writes nothing under ~/.cursor: that directory is shared with the
   * regular editor, and the editor's OpenAI override would move both apps.
   * This build reads CURSOR_LOCAL_AGENT_BASE_URL and CURSOR_LOCAL_AGENT_API_KEY
   * instead. On macOS those are set with launchctl so a Dock launch sees them.
   * https://github.com/yetone/magpie/blob/main/internal/agent/cursorlocal.go
   *
   * Install detection does not treat stock Cursor as this product. There is
   * no stable public install path distinct from Cursor.app / `cursor` /
   * `cursor-agent`, and those do not read CURSOR_LOCAL_AGENT_*. `installed`
   * stays false for those paths until a private build publishes its own
   * binary or app name on `install.binaries` / `install.apps`.
   */
  cursor: {
    id: "cursor",
    name: "Cursor",
    vendor: "cursor",
    formats: ["openai", "anthropic"],
    kind: "cursor-local",
    configPath: (home) => path.join(home, ".kong-ai-switch", "cursor-local.env"),
    ownedKeys: ["CURSOR_LOCAL_AGENT_BASE_URL", "CURSOR_LOCAL_AGENT_API_KEY"],
    switchable: true,
    install: {
      binaries: [],
      apps: [],
      ignoreBinaries: ["cursor", "cursor-agent"],
      ignoreApps: ["Cursor.app"],
      note:
        "No stable public install path is distinct from stock Cursor. " +
        "/Applications/Cursor.app, ~/Applications/Cursor.app, the cursor command, and cursor-agent " +
        "are stock Cursor. They do not read CURSOR_LOCAL_AGENT_* and are not install signals. " +
        "installed stays false until a private build publishes its own binary or app.",
    },
  },

  /**
   * Nous Research Hermes Agent. Detected only — do not write ~/.hermes/config.yaml.
   * Protocol is OpenAI chat completions. HERMES_HOME can move the data dir;
   * the official installer default (~/.local/bin/hermes, ~/.hermes/hermes-agent,
   * or Hermes.app) is enough. ~/.hermes/ by itself is not an install.
   */
  hermes: {
    id: "hermes",
    name: "Hermes",
    vendor: "nous",
    formats: ["openai"],
    switchable: false,
    kind: "detected-only",
    configPath: (home) => path.join(home, ".hermes", "hermes-agent"),
    install: {
      binaries: ["hermes"],
      paths: (home) => [path.join(home, ".hermes", "hermes-agent")],
      pathKind: "dir",
      apps: [{ name: "Hermes.app" }],
    },
  },

  /**
   * OpenClaw, a host that can launch other CLIs. Detected only — one row,
   * which does not mean Claude, Codex, or any other agent is installed.
   * Do not write ~/.openclaw/openclaw.json and do not consult OPENCLAW_CONFIG_PATH.
   * The official installer puts the CLI and state under ~/.openclaw.
   */
  openclaw: {
    id: "openclaw",
    name: "OpenClaw",
    vendor: "openclaw",
    formats: ["openai"],
    switchable: false,
    kind: "detected-only",
    configPath: (home) => path.join(home, ".openclaw"),
    install: {
      binaries: ["openclaw"],
      paths: (home) => [path.join(home, ".openclaw")],
      pathKind: "dir",
    },
  },
};

export function listAgents() {
  return Object.values(AGENTS);
}

export function getAgent(id) {
  const agent = AGENTS[id];
  if (!agent) {
    throw new Error(
      `Unknown agent "${id}". Known agents: ${Object.keys(AGENTS).join(", ")}.`,
    );
  }
  return agent;
}

/** Agents `use` is allowed to rewrite. Detected-only rows are omitted. */
export function listSwitchableAgents() {
  return listAgents().filter((agent) => agent.switchable !== false);
}

/** Error for `use` / applyToAgent on a detected-only agent. No config is written. */
export function notSwitchableMessage(agent) {
  const name = typeof agent === "string" ? agent : agent.name;
  return `${name} is detected, not switchable yet.`;
}

/**
 * Whether the product is on this machine.
 * `options.stat` / `options.readFile` / `options.listDir` are injected in tests.
 * `options.home` is required by the lookup so a test never falls through to a real home.
 */
export function detectInstall(agentOrId, options) {
  const agent = typeof agentOrId === "string" ? getAgent(agentOrId) : agentOrId;
  return detectAgentInstall(agent, options);
}

/** One `agents --json` row. Existing fields stay; install fields are added. */
export function describeAgent(agent, status, install) {
  return {
    id: agent.id,
    name: agent.name,
    vendor: agent.vendor ?? null,
    formats: agent.formats,
    file: status.file,
    configured: Boolean(status.configured),
    model: status.model ?? null,
    baseUrl: status.baseUrl ?? null,
    sharesConfigWith: agent.sharesConfigWith ?? null,
    envFile: status.envFile ?? null,
    installed: Boolean(install?.installed),
    foundAt: install?.foundAt ?? null,
    switchable: agent.switchable !== false,
  };
}

/** Text table for `kong-ai-switch agents`. */
export function formatAgentsTable(rows) {
  const shown = rows.map((row) => ({
    id: row.id,
    name: row.name,
    install: row.installed ? "installed" : "not installed",
    point:
      row.switchable === false
        ? "not switchable"
        : row.configured
          ? (row.model ?? "configured")
          : "not configured",
  }));
  const width = (key, header) =>
    Math.max(header.length, ...shown.map((row) => String(row[key]).length));
  const wId = width("id", "AGENT");
  const wName = width("name", "NAME");
  const wInstall = width("install", "INSTALLED");
  let out = `  ${"AGENT".padEnd(wId)}  ${"NAME".padEnd(wName)}  ${"INSTALLED".padEnd(wInstall)}  POINTED AT\n`;
  for (const row of shown) {
    out += `  ${row.id.padEnd(wId)}  ${row.name.padEnd(wName)}  ${row.install.padEnd(wInstall)}  ${row.point}\n`;
  }
  out += "\nSwitch one or more with: kong-ai-switch use <model> --agent codex\n";
  return out;
}

/** Whether an agent can call a model served in the given Kong format. */
export function agentSupportsFormat(agentId, format) {
  return getAgent(agentId).formats.includes(String(format ?? "").toLowerCase());
}

/**
 * Which agents could use a given model, and why the others cannot.
 * Used to explain an omission rather than silently hiding a model.
 */
export function agentsForModel(format) {
  const supported = [];
  const unsupported = [];
  for (const agent of listSwitchableAgents()) {
    if (agent.formats.includes(String(format ?? "").toLowerCase())) supported.push(agent);
    else {
      unsupported.push({
        ...agent,
        reason:
          `${agent.name} speaks ${agent.formats.join("/")}, but this model serves "${format}". ` +
          `Set the AI Model's formats[].type accordingly in Kong.`,
      });
    }
  }
  return { supported, unsupported };
}

/** Atomic write, preserving the file's mode when it already exists. */
async function writeAtomic(file, body) {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });

  let mode;
  try {
    mode = (await stat(file)).mode & 0o777;
  } catch {
    mode = 0o600; // May hold a token.
  }

  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, body, { encoding: "utf8", mode });
  await rename(tmp, file);
  return file;
}

// ---------------------------------------------------------------------------
// Claude Desktop (3P configLibrary)
// ---------------------------------------------------------------------------

/**
 * Stable UUID for the profile kong-ai-switch maintains.
 * Must match AGENTS["claude-desktop"].profileId.
 * Must be a RFC 4122 UUID — Claude Desktop rejects unknown/invalid ids with
 * "Couldn't load configuration" / readConfig failed unknown config id.
 */
const CLAUDE_DESKTOP_PROFILE_ID = "6b6f6e67-6169-4e67-8a19-737769746368";
const CLAUDE_DESKTOP_PROFILE_NAME = "Kong AI Switch";

async function readClaudeDesktopMeta(libraryDir) {
  const metaFile = path.join(libraryDir, "_meta.json");
  try {
    const raw = await readFile(metaFile, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { meta: parsed, metaFile, existed: true };
    }
  } catch (cause) {
    if (cause?.code !== "ENOENT" && !(cause instanceof SyntaxError)) {
      throw new Error(`Could not read ${metaFile}: ${cause.message}`);
    }
  }
  return {
    meta: { appliedId: null, entries: [] },
    metaFile,
    existed: false,
  };
}

/**
 * Build the Claude Desktop 3P gateway profile for a Kong AI Model.
 *
 * Desktop does not read ANTHROPIC_* from ~/.claude/settings.json. It expects
 * inferenceProvider / inferenceGateway* keys in configLibrary/<uuid>.json.
 *
 * Credential rules (do not mix modes — that breaks Configure Third-Party Inference):
 * - `credentialMode: "static"` (default when a token is supplied) → static +
 *   `inferenceGatewayApiKey` (colleague / Desktop-exported shape).
 * - `credentialMode: "interactive"` → OIDC only; any token is ignored for the file.
 * - OIDC with no mode and no token → interactive (Desktop owns PKCE).
 * - key-auth / no-auth → static as before.
 *
 * Options:
 * - credentialMode: "static" | "interactive"
 * - modelDiscoveryEnabled (default false)
 * - trailingSlash (default false — strip trailing / on base URL)
 * - includeLabelOverride (default true when displayName ≠ model id)
 * - clientId, oidcScopes, oidcRedirectPort, oidcBearerTokenType,
 *   oidcAppendOfflineAccess, oidcAuthFlow — interactive OIDC nested fields
 */
export function buildClaudeDesktopProfile(profile, options = {}) {
  const {
    token,
    clientId,
    credentialMode: modeOpt,
    modelDiscoveryEnabled = false,
    trailingSlash = false,
    includeLabelOverride = true,
    oidcScopes,
    oidcRedirectPort,
    oidcBearerTokenType,
    oidcAppendOfflineAccess,
    oidcAuthFlow,
  } = options;

  let baseUrl = String(profile.baseUrl ?? "").replace(/\/+$/, "");
  if (trailingSlash && baseUrl) baseUrl = `${baseUrl}/`;

  const modelName = profile.clientModelId ?? profile.name;
  const model = { name: modelName };
  const label = profile.displayName ?? modelName;
  if (includeLabelOverride && label && label !== modelName) {
    model.labelOverride = label;
  }

  const next = {
    inferenceGatewayBaseUrl: baseUrl,
    modelDiscoveryEnabled: Boolean(modelDiscoveryEnabled),
    inferenceModels: [model],
    inferenceProvider: "gateway",
  };

  const preferred = profile.auth?.preferred;
  const kind = preferred?.kind;
  const header = preferred?.header ?? "Authorization";
  const issuer = preferred?.issuer ?? null;

  const explicitMode =
    modeOpt === "static" || modeOpt === "interactive" ? modeOpt : null;

  if (kind === "openid-connect" && issuer) {
    // Interactive wins when requested — never write API key alongside OIDC.
    const useInteractive =
      explicitMode === "interactive" || (explicitMode == null && !token);

    if (useInteractive) {
      next.inferenceCredentialKind = "interactive";
      next.inferenceGatewayOidcAuthFlow =
        oidcAuthFlow === "broker" ? "broker" : "browser";
      next.inferenceGatewayOidc = buildOidcBlock({
        issuer,
        token,
        clientId,
        oidcScopes,
        oidcRedirectPort,
        oidcBearerTokenType,
        oidcAppendOfflineAccess,
      });
      return next;
    }

    // Static JWT (default when a token is present, or mode === static).
    if (!token) {
      throw new Error(
        'Claude Desktop credential mode "static" needs a bearer token ' +
          "(pass --token, or use --desktop-credential-mode interactive).",
      );
    }
    next.inferenceCredentialKind = "static";
    next.inferenceGatewayApiKey = token;
    return next;
  }

  next.inferenceCredentialKind = "static";
  if (token) {
    const lower = header.toLowerCase();
    if (lower === "authorization") {
      next.inferenceGatewayApiKey = token;
    } else if (lower === "x-api-key") {
      next.inferenceGatewayApiKey = token;
      next.inferenceGatewayAuthScheme = "x-api-key";
    } else {
      // Kong key-auth default is `apikey`, which is neither scheme.
      next.inferenceGatewayApiKey = "kong-ai-gateway";
      next.inferenceCustomHeaders = { [header]: token };
    }
  } else if (!profile.requiresAuth) {
    next.inferenceGatewayApiKey = "kong-ai-gateway";
  }

  return next;
}

function buildOidcBlock({
  issuer,
  token,
  clientId,
  oidcScopes,
  oidcRedirectPort,
  oidcBearerTokenType,
  oidcAppendOfflineAccess,
}) {
  const scopes =
    (typeof oidcScopes === "string" && oidcScopes.trim()) ||
    process.env.KONG_AI_OIDC_SCOPES ||
    oidcScopesForIssuer(issuer);
  const port =
    Number(oidcRedirectPort) ||
    Number(process.env.KONG_AI_OIDC_REDIRECT_PORT) ||
    53180;
  const bearer =
    oidcBearerTokenType === "id_token" ? "id_token" : "access_token";
  const appendOffline =
    oidcAppendOfflineAccess === undefined
      ? true
      : Boolean(oidcAppendOfflineAccess);

  return {
    issuer,
    clientId: resolveOidcClientId({ issuer, token, clientId }),
    scopes,
    bearerTokenType: bearer,
    redirectPort: port,
    appendOfflineAccess: appendOffline,
  };
}

/** Entra / Keycloak need different default public-client ids and scopes. */
function isEntraIssuer(issuer) {
  return /login\.microsoftonline\.com|sts\.windows\.net/i.test(String(issuer ?? ""));
}

function oidcScopesForIssuer(issuer) {
  // appendOfflineAccess adds offline_access; keep the base scopes simple.
  // Entra often wants a resource scope — operators can override via env.
  if (process.env.KONG_AI_OIDC_SCOPES) return process.env.KONG_AI_OIDC_SCOPES;
  if (isEntraIssuer(issuer)) return "openid profile email offline_access";
  return "openid profile email";
}

/**
 * Public OIDC client id for Claude Desktop's loopback PKCE flow.
 *
 * Prefer an explicit override, then a claim from a just-issued token (`azp` /
 * `appid`), then Keycloak-style `claude-desktop`. Never invent Entra GUIDs.
 */
function resolveOidcClientId({ issuer, token, clientId }) {
  const explicit =
    clientId ||
    process.env.KONG_AI_OIDC_CLIENT_ID ||
    process.env.CLAUDE_DESKTOP_OIDC_CLIENT_ID;
  if (explicit) return String(explicit).trim();

  const fromJwt = clientIdFromJwt(token);
  if (fromJwt) return fromJwt;

  if (isEntraIssuer(issuer)) {
    // Hardcoding "claude-desktop" breaks Entra and can hang the 3P settings UI.
    throw new Error(
      "Claude Desktop OIDC against Microsoft Entra needs the Entra app (client) id. " +
        "Set KONG_AI_OIDC_CLIENT_ID to your public native app's Application (client) ID, " +
        "or pass --oidc-client-id.",
    );
  }
  return "claude-desktop";
}

function clientIdFromJwt(token) {
  if (!token || typeof token !== "string" || token.split(".").length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    const id = payload.azp || payload.appid || payload.client_id;
    // Prefer GUID-shaped Entra app ids; skip opaque Keycloak client names only
    // when we already have a better source — here any non-empty azp is fine.
    return typeof id === "string" && id.trim() ? id.trim() : null;
  } catch {
    return null;
  }
}

async function applyClaudeDesktop3p(agent, profile, options) {
  const { token, home, clientId, ...writerOpts } = options;
  const libraryDir = agent.configPath(home);
  await mkdir(libraryDir, { recursive: true });

  const profileId = agent.profileId ?? CLAUDE_DESKTOP_PROFILE_ID;
  const profileName = agent.profileName ?? CLAUDE_DESKTOP_PROFILE_NAME;
  if (!isUuid(profileId)) {
    throw new Error(
      `Claude Desktop profile id must be a UUID (got "${profileId}"). ` +
        `Invalid ids make Configure Third-Party Inference show "Couldn't load configuration".`,
    );
  }
  const profileFile = path.join(libraryDir, `${profileId}.json`);
  const body = buildClaudeDesktopProfile(profile, {
    token,
    clientId,
    ...writerOpts,
  });
  await writeAtomic(profileFile, JSON.stringify(body, null, 2) + "\n");

  // Drop the pre-0.2.3 invalid id so Claude Desktop's library list stays loadable.
  await removeLegacyInvalidProfile(libraryDir);

  const { meta, metaFile } = await readClaudeDesktopMeta(libraryDir);
  const entries = Array.isArray(meta.entries) ? [...meta.entries] : [];
  const withoutUs = entries.filter(
    (e) => e?.id !== profileId && e?.id !== LEGACY_INVALID_PROFILE_ID,
  );
  withoutUs.push({ id: profileId, name: profileName });
  const nextMeta = {
    appliedId: profileId,
    entries: withoutUs,
  };
  await writeAtomic(metaFile, JSON.stringify(nextMeta, null, 2) + "\n");

  return { agent: agent.id, file: profileFile, created: true, libraryDir };
}

/** Pre-0.2.3 id was not a UUID (14-char final segment) and breaks Desktop's 3P UI. */
const LEGACY_INVALID_PROFILE_ID = "6b6f6e67-6169-4e67-8000-73776974636801";

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    String(value ?? ""),
  );
}

async function removeLegacyInvalidProfile(libraryDir) {
  for (const name of [
    `${LEGACY_INVALID_PROFILE_ID}.json`,
    `${LEGACY_INVALID_PROFILE_ID}.json.invalid-uuid`,
  ]) {
    try {
      await unlink(path.join(libraryDir, name));
    } catch (cause) {
      if (cause?.code !== "ENOENT") throw cause;
    }
  }
}

async function statusClaudeDesktop3p(agent, { home }) {
  const libraryDir = agent.configPath(home);
  const profileId = agent.profileId ?? CLAUDE_DESKTOP_PROFILE_ID;
  const profileFile = path.join(libraryDir, `${profileId}.json`);
  const { meta } = await readClaudeDesktopMeta(libraryDir);
  const applied = meta.appliedId === profileId;

  let body = null;
  try {
    body = JSON.parse(await readFile(profileFile, "utf8"));
  } catch {
    return { agent: agent.id, file: profileFile, configured: false };
  }

  const model =
    Array.isArray(body.inferenceModels) && body.inferenceModels[0]
      ? body.inferenceModels[0].name
      : null;
  const baseUrl = body.inferenceGatewayBaseUrl ?? null;
  const hasToken = Boolean(
    body.inferenceGatewayApiKey ||
      body.inferenceCredentialKind === "interactive" ||
      (body.inferenceCustomHeaders && Object.keys(body.inferenceCustomHeaders).length),
  );

  return {
    agent: agent.id,
    file: profileFile,
    configured: Boolean(applied && (baseUrl || model)),
    baseUrl,
    model,
    hasToken,
  };
}


async function readJsonSettings(file) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (cause) {
    if (cause?.code === "ENOENT") return { settings: {}, existed: false };
    throw new Error(`Could not read ${file}: ${cause.message}`);
  }
  if (raw.trim() === "") return { settings: {}, existed: true };

  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return { settings: parsed, existed: true };
  } catch (cause) {
    throw new Error(
      `${file} is not valid JSON (${cause.message}). Fix or move the file, then retry.`,
    );
  }
}

function applyJsonEnv(settings, profile, { token }) {
  const next = structuredClone(settings ?? {});
  const env = { ...(next.env ?? {}) };

  env.ANTHROPIC_BASE_URL = profile.baseUrl;
  env.ANTHROPIC_MODEL = profile.clientModelId;
  // A Kong model name is not a Claude model id; without this the CLI refuses.
  env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT = "1";

  // Where the credential goes depends on the strategy, and getting this wrong
  // fails with a 401 that looks like a gateway problem.
  //
  //   key-auth        wants its own header, `apikey` by default. Claude Code
  //                   sends ANTHROPIC_AUTH_TOKEN as a bearer Authorization
  //                   header, which key-auth ignores, so the key must travel
  //                   via ANTHROPIC_CUSTOM_HEADERS instead.
  //   openid-connect  wants a bearer token, which ANTHROPIC_AUTH_TOKEN is.
  //
  // Always clear the channel the other strategy uses. Dual-strategy models
  // reject a stale Bearer even when a valid apikey is also present, and an
  // leftover apikey header after an OIDC switch is equally confusing.
  const header = claudeCredentialHeader(profile);
  const usesCustomHeader = Boolean(header);

  if (token && usesCustomHeader) {
    env.ANTHROPIC_CUSTOM_HEADERS = `${header}: ${token}`;
    // Placeholder only — never keep a previous OIDC bearer here, or Kong
    // evaluates openid-connect first and 401s despite a valid key.
    env.ANTHROPIC_AUTH_TOKEN = "kong-ai-gateway";
  } else if (token) {
    env.ANTHROPIC_AUTH_TOKEN = token;
    delete env.ANTHROPIC_CUSTOM_HEADERS;
  } else if (!profile.requiresAuth) {
    env.ANTHROPIC_AUTH_TOKEN = env.ANTHROPIC_AUTH_TOKEN || "kong-ai-gateway";
    delete env.ANTHROPIC_CUSTOM_HEADERS;
  }

  next.env = env;
  return next;
}

/** The custom header a key-auth credential travels in, or null for bearer auth. */
export function claudeCredentialHeader(profile) {
  const header = profile?.auth?.preferred?.header;
  const usesCustomHeader =
    profile?.auth?.preferred?.kind === "key-auth" &&
    header &&
    header.toLowerCase() !== "authorization";
  return usesCustomHeader ? header : null;
}

/**
 * Write (or neutralise) the git-attribution shell wrapper.
 * Only creates a file when one is needed; an existing file is replaced with an
 * inert stub so a `source` line in the user's rc file keeps working.
 */
async function writeAttributionWrapper(
  attribution,
  { home, staticBlock, environment, agentId = "claude-code" },
) {
  const file = attributionWrapperPath(home, agentId);
  if (usesAutoGit(attribution)) {
    const body =
      agentId === "codex"
        ? buildCodexAttributionWrapper(attribution, { environment, home })
        : buildAttributionWrapper(attribution, { staticBlock, environment, home });
    await writeAtomic(file, body);
    return { file, active: true };
  }
  try {
    await stat(file);
  } catch {
    return { file, active: false };
  }
  await writeAtomic(file, buildInactiveWrapper(agentId));
  return { file, active: false };
}

/**
 * Re-apply attribution to Claude Code's settings.json without switching model.
 *
 * `previous` is the attribution being replaced, so its extra headers are
 * removed; `credentialHeader` is protected from ever being treated as one.
 */
export async function applyClaudeAttribution({
  attribution,
  previous,
  credentialHeader,
  environment,
  home = homedir(),
} = {}) {
  const agent = getAgent("claude-code");
  const file = agent.configPath(home);
  const record = readAttribution(attribution);
  const { settings } = await readJsonSettings(file);
  const next = structuredClone(settings);
  const env = { ...(next.env ?? {}) };
  applyAttributionToEnv(env, record, {
    credentialHeader,
    previous: previous ? readAttribution(previous) : undefined,
  });
  next.env = env;
  await writeAtomic(file, JSON.stringify(next, null, 2) + "\n");
  const wrapper = await writeAttributionWrapper(record, {
    home,
    staticBlock: env.ANTHROPIC_CUSTOM_HEADERS ?? "",
    environment,
  });
  return { file, wrapperFile: wrapper.file, wrapperActive: wrapper.active };
}

/**
 * Re-apply attribution to Codex's managed provider block without switching
 * model. Returns `{ applied: false }` when Codex has no managed provider.
 */
export async function applyCodexAttribution({
  attribution,
  previous,
  credentialHeader,
  environment,
  home = homedir(),
} = {}) {
  const file = getAgent("codex").configPath(home);
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return { applied: false, file };
  }
  const record = readAttribution(attribution, "codex");
  const next = applyCodexAttributionToToml(text, record, {
    credentialHeader,
    previous: previous ? readAttribution(previous, "codex") : undefined,
  });
  if (next === null) return { applied: false, file };
  await writeAtomic(file, next);
  const wrapper = await writeAttributionWrapper(record, { home, environment, agentId: "codex" });
  return { applied: true, file, wrapperFile: wrapper.file, wrapperActive: wrapper.active };
}

// ---------------------------------------------------------------------------
// Codex TOML
// ---------------------------------------------------------------------------

/** Quote a TOML string, escaping what the format requires. */
function tomlString(value) {
  return `"${String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\u0000-\u001f\u007f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}"`;
}

/** A TOML key: bare when it can be, quoted otherwise (a `.` would nest). */
function tomlKey(name) {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : tomlString(name);
}

/**
 * Single-line inline table. Codex's header maps are always written inline:
 * a `[model_providers.kong.http_headers]` table would stay open and swallow
 * any bare keys that follow it.
 */
function tomlInlineTable(entries) {
  if (entries.length === 0) return "{}";
  return `{ ${entries.map(({ name, value }) => `${tomlKey(name)} = ${tomlString(value)}`).join(", ")} }`;
}

/**
 * Parse a one-line TOML inline table of string values, e.g.
 * `{ apikey = "k", "x.y" = 'v' }`, into `[{ name, value }]` in order.
 * Throws on anything else (dotted keys, nested tables, non-strings).
 */
export function parseTomlInlineStringTable(source) {
  const s = String(source ?? "").trim();
  let i = 0;
  const fail = () => {
    throw new Error(`Unsupported TOML inline table: ${s}`);
  };
  const skipSpace = () => {
    while (i < s.length && (s[i] === " " || s[i] === "\t")) i += 1;
  };
  const escapes = { '"': '"', "\\": "\\", n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" };
  const readString = () => {
    const quote = s[i];
    if (quote === "'") {
      const end = s.indexOf("'", i + 1);
      if (end === -1) fail();
      const value = s.slice(i + 1, end);
      i = end + 1;
      return value;
    }
    if (quote !== '"') fail();
    i += 1;
    let out = "";
    while (i < s.length && s[i] !== '"') {
      if (s[i] !== "\\") {
        out += s[i];
        i += 1;
        continue;
      }
      const code = s[i + 1];
      if (code === "u" || code === "U") {
        const len = code === "u" ? 4 : 8;
        const hex = s.slice(i + 2, i + 2 + len);
        if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) fail();
        out += String.fromCodePoint(parseInt(hex, 16));
        i += 2 + len;
        continue;
      }
      if (!(code in escapes)) fail();
      out += escapes[code];
      i += 2;
    }
    if (s[i] !== '"') fail();
    i += 1;
    return out;
  };
  const readKey = () => {
    if (s[i] === '"' || s[i] === "'") return readString();
    const bare = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
    if (!bare) fail();
    i += bare[0].length;
    return bare[0];
  };

  if (s[i] !== "{") fail();
  i += 1;
  const out = [];
  skipSpace();
  if (s[i] === "}") {
    i += 1;
  } else {
    for (;;) {
      skipSpace();
      const name = readKey();
      skipSpace();
      if (s[i] !== "=") fail();
      i += 1;
      skipSpace();
      out.push({ name, value: readString() });
      skipSpace();
      if (s[i] === ",") {
        i += 1;
        continue;
      }
      if (s[i] === "}") {
        i += 1;
        break;
      }
      fail();
    }
  }
  skipSpace();
  if (i < s.length && s[i] !== "#") fail();
  return out;
}

/** Comment inside the managed provider block naming the headers attribution owns. */
const CODEX_ATTRIBUTION_MARK = "# kong-ai-switch attribution headers:";

/**
 * Merge attribution into the managed `[model_providers.kong]` block.
 *
 * `http_headers` keeps every entry attribution does not own (the key-auth
 * credential, chiefly) first, then the static attribution headers.
 * `env_http_headers` is owned outright: it carries the git branch when
 * branch is "auto". Returns null when the file has no managed provider block.
 */
export function applyCodexAttributionToToml(text, attribution, { previous, credentialHeader } = {}) {
  const beginAt = text.indexOf(CODEX_PROVIDER_BEGIN);
  const endAt = text.indexOf(CODEX_PROVIDER_END);
  if (beginAt === -1 || endAt === -1 || endAt < beginAt) return null;

  const lines = text.slice(beginAt, endAt).split("\n");
  while (lines.length && lines.at(-1).trim() === "") lines.pop();

  let existing = [];
  let marked = [];
  const kept = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^http_headers\s*=/.test(trimmed)) {
      existing = parseTomlInlineStringTable(trimmed.replace(/^http_headers\s*=\s*/, ""));
    } else if (/^env_http_headers\s*=/.test(trimmed)) {
      // Owned outright; regenerated below.
    } else if (trimmed.startsWith(CODEX_ATTRIBUTION_MARK)) {
      marked = trimmed
        .slice(CODEX_ATTRIBUTION_MARK.length)
        .split(",")
        .map((n) => n.trim().toLowerCase())
        .filter(Boolean);
    } else {
      kept.push(line);
    }
  }

  const managed = managedHeaderNames(attribution, previous);
  for (const name of marked) managed.add(name);
  if (credentialHeader) managed.delete(String(credentialHeader).toLowerCase());

  const credential = existing.filter((h) => !managed.has(h.name.toLowerCase()));
  const keptNames = new Set(credential.map((h) => h.name.toLowerCase()));
  const added = staticAttributionHeaders(attribution).filter((h) => !keptNames.has(h.name.toLowerCase()));
  const envHeaders =
    attribution?.enabled && attribution.branchAuto
      ? [{ name: ATTRIBUTION_HEADERS.branch, value: CODEX_BRANCH_ENV }]
      : [];

  if (added.length || envHeaders.length) {
    kept.push(`${CODEX_ATTRIBUTION_MARK} ${[...added, ...envHeaders].map((h) => h.name).join(", ")}`);
  }
  const headers = [...credential, ...added];
  if (headers.length) kept.push(`http_headers = ${tomlInlineTable(headers)}`);
  if (envHeaders.length) kept.push(`env_http_headers = ${tomlInlineTable(envHeaders)}`);

  return `${text.slice(0, beginAt)}${kept.join("\n")}\n${text.slice(endAt)}`;
}

/** Whether the managed provider block carries a gateway credential. */
function codexHasCredential(scope) {
  if (/^\s*experimental_bearer_token\s*=/m.test(scope)) return true;
  const line = scope.match(/^\s*http_headers\s*=\s*(.*)$/m)?.[1];
  if (!line) return false;
  const marked = new Set(
    (scope.match(new RegExp(`^\\s*${CODEX_ATTRIBUTION_MARK}(.*)$`, "m"))?.[1] ?? "")
      .split(",")
      .map((n) => n.trim().toLowerCase())
      .filter(Boolean),
  );
  try {
    return parseTomlInlineStringTable(line).some((h) => !marked.has(h.name.toLowerCase()));
  } catch {
    return true;
  }
}

/** Markers for the root keys we own (must sit before any `[table]`). */
const CODEX_MANAGED_BEGIN = "# >>> kong-ai-switch (managed) >>>";
const CODEX_MANAGED_END = "# <<< kong-ai-switch (managed) <<<";
/** Markers for the provider table (always written at file end). */
const CODEX_PROVIDER_BEGIN = "# >>> kong-ai-switch (managed-provider) >>>";
const CODEX_PROVIDER_END = "# <<< kong-ai-switch (managed-provider) <<<";

/**
 * Strip every managed region we (or a prior revision) may have written.
 *
 * Handles the legacy single block (root keys + provider table together) and
 * the current two-part layout (root at top, provider at end).
 */
function stripCodexManaged(text) {
  let next = text ?? "";
  // Provider block first (distinct markers), then root / legacy single block.
  next = stripMarkedRegion(next, CODEX_PROVIDER_BEGIN, CODEX_PROVIDER_END);
  next = stripMarkedRegion(next, CODEX_MANAGED_BEGIN, CODEX_MANAGED_END);
  return next;
}

function stripMarkedRegion(text, begin, end) {
  const beginAt = text.indexOf(begin);
  const endAt = text.indexOf(end);
  if (beginAt === -1 || endAt === -1 || endAt < beginAt) return text;
  return text.slice(0, beginAt) + text.slice(endAt + end.length);
}

/**
 * Collect text inside every managed region (legacy single + two-part).
 * agentStatus must ignore neutralized custom providers outside these markers.
 */
function managedCodexScope(text) {
  const parts = [];
  for (const [begin, end] of [
    [CODEX_MANAGED_BEGIN, CODEX_MANAGED_END],
    [CODEX_PROVIDER_BEGIN, CODEX_PROVIDER_END],
  ]) {
    const beginAt = text.indexOf(begin);
    const endAt = text.indexOf(end);
    if (beginAt !== -1 && endAt !== -1 && endAt > beginAt) {
      parts.push(text.slice(beginAt, endAt + end.length));
    }
  }
  return parts.join("\n");
}

/**
 * Rewrite Codex's config.toml, replacing only the regions this tool owns.
 *
 * Safe TOML layout (critical):
 * 1. Root keys (`model_provider`, `model`) at file **start**, before any
 *    `[table]`. Appending them after `[projects."…"]` makes Codex ignore them
 *    and fall back to OpenAI / `wss://api.openai.com`.
 * 2. `[model_providers.kong]` at file **end**, after all user content.
 * 3. Key-auth uses an **inline** `http_headers = { … }` map — never a nested
 *    `[model_providers.kong.http_headers]` table. Nested tables leave that
 *    table "open", so following bare keys (e.g. `disable_response_storage`)
 *    are absorbed and Codex fails with a type error.
 *
 * Credentials live in the provider block so launching `codex` needs no shell
 * export. Key-auth: apikey in http_headers only. OIDC: experimental_bearer_token.
 */
function applyCodexToml(existing, profile, { token, attribution }) {
  const authLines = codexAuthLines(profile, token);

  const rootBlock = [
    CODEX_MANAGED_BEGIN,
    `model_provider = "kong"`,
    `model = ${tomlString(profile.clientModelId)}`,
    CODEX_MANAGED_END,
  ].join("\n");

  const providerBlock = [
    CODEX_PROVIDER_BEGIN,
    "[model_providers.kong]",
    `name = "Kong AI Gateway"`,
    `base_url = ${tomlString(profile.baseUrl)}`,
    // Codex 0.148+ rejects wire_api = "chat" (chat/completions removed).
    // Requires the gateway to expose the OpenAI Responses API (/responses).
    `wire_api = "responses"`,
    // Do not fall back to ~/.codex/auth.json OpenAI login for this provider.
    `requires_openai_auth = false`,
    // Kong AI Gateway speaks HTTPS /responses, not OpenAI's wss transport.
    `supports_websockets = false`,
    ...authLines,
    CODEX_PROVIDER_END,
  ].join("\n");

  let rest = stripCodexManaged(existing ?? "");
  rest = scrubCompetingCodexProviders(rest, profile.baseUrl).trim();
  const text = rest === "" ? `${rootBlock}\n\n${providerBlock}\n` : `${rootBlock}\n\n${rest}\n\n${providerBlock}\n`;
  if (!attribution?.enabled) return text;
  return applyCodexAttributionToToml(text, attribution, { credentialHeader: claudeCredentialHeader(profile) });
}

/**
 * Outside the managed block: drop competing `model_provider = …` lines,
 * strip OpenAI-only reasoning knobs that Kong/third-party gateways reject,
 * and neutralize other providers aimed at the same gateway (common leftover
 * from cc-switch / manual Codex setups using requires_openai_auth + auth.json).
 *
 * `model_reasoning_effort` makes Codex send `reasoning.effort` on /responses,
 * which many gateway model ids (e.g. a routed `openai` id) reject as
 * unsupported_parameter. Never write these into the managed root block.
 */
function scrubCompetingCodexProviders(section, baseUrl) {
  if (!section) return section;
  let next = section.replace(/^\s*model_provider\s*=.*\n?/gm, "");
  // OpenAI Responses-only prefs — leave them unset for Kong-pointed Codex.
  next = next.replace(/^\s*model_reasoning_effort\s*=.*\n?/gm, "");
  next = next.replace(/^\s*model_verbosity\s*=.*\n?/gm, "");
  const target = normalizeCodexBaseUrl(baseUrl);
  if (!target) return next;

  const parts = next.split(/(?=^\[model_providers\.[^\]]+\])/m);
  return parts
    .map((part) => {
      if (!/^\[model_providers\./.test(part)) return part;
      if (/^\[model_providers\.kong[\.\]]/.test(part)) return part;
      const urlMatch = part.match(/^\s*base_url\s*=\s*"([^"]*)"/m);
      if (!urlMatch || normalizeCodexBaseUrl(urlMatch[1]) !== target) return part;
      let rewritten = part.replace(
        /^\s*requires_openai_auth\s*=\s*true\s*$/m,
        "requires_openai_auth = false",
      );
      if (!/^\s*requires_openai_auth\s*=/m.test(rewritten)) {
        rewritten = rewritten.replace(
          /(\[model_providers\.[^\]]+\]\n)/,
          `$1requires_openai_auth = false\n`,
        );
      }
      rewritten = rewritten.replace(
        /^\s*base_url\s*=\s*"[^"]*"\s*$/m,
        `base_url = ${tomlString("http://127.0.0.1:9/disabled-by-kong-ai-switch")}`,
      );
      return rewritten;
    })
    .join("");
}

function normalizeCodexBaseUrl(url) {
  return String(url || "")
    .trim()
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** Auth lines for a Codex provider: no KONG_AI_TOKEN export required. */
function codexAuthLines(profile, token) {
  if (!token) return [];

  const kind = profile.auth?.preferred?.kind;
  const header = profile.auth?.preferred?.header;
  const usesCustomHeader =
    kind === "key-auth" && header && header.toLowerCase() !== "authorization";

  if (usesCustomHeader) {
    // Inline table keeps the provider table closed — a nested
    // `[model_providers.kong.http_headers]` would swallow following bare keys.
    // Do NOT send a placeholder Bearer: dual-auth gateways (OIDC + key-auth)
    // 401 on a junk Authorization header before key-auth runs.
    return [`http_headers = ${tomlInlineTable([{ name: header, value: token }])}`];
  }

  // OIDC / bearer-style strategies. Stored in config so the app switch is enough.
  return [`experimental_bearer_token = ${tomlString(token)}`];
}

// ---------------------------------------------------------------------------
// GitHub Copilot CLI (BYOK via env file + settings.json model)
// ---------------------------------------------------------------------------

/**
 * Build the env file Copilot CLI needs at launch.
 *
 * Copilot does not read provider URL/key from settings.json — only from the
 * process environment. Writing a sourced file is the durable equivalent of
 * what we do for Claude's settings.env.
 */
function applyCopilotEnv(profile, { token }) {
  const BEGIN = "# >>> kong-ai-switch (managed) >>>";
  const END = "# <<< kong-ai-switch (managed) <<<";
  const providerType = profile.format === "anthropic" ? "anthropic" : "openai";
  const lines = [
    BEGIN,
    `# Point GitHub Copilot CLI at Kong AI Gateway.`,
    `# Usage:  source ~/.copilot/kong-ai-switch.env && copilot`,
    `export COPILOT_PROVIDER_BASE_URL=${shellQuote(profile.baseUrl)}`,
    `export COPILOT_PROVIDER_TYPE=${shellQuote(providerType)}`,
    `export COPILOT_MODEL=${shellQuote(profile.clientModelId)}`,
  ];
  if (token) {
    // Prefer API key; Copilot also accepts a bearer for providers that need it.
    lines.push(`export COPILOT_PROVIDER_API_KEY=${shellQuote(token)}`);
  }
  lines.push(END);
  return lines.join("\n") + "\n";
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function applyCopilotSettings(settings, profile) {
  const next = structuredClone(settings ?? {});
  next.model = profile.clientModelId;
  return next;
}

// ---------------------------------------------------------------------------
// Cursor Private Inference (Magpie's cursor-local agent)
// ---------------------------------------------------------------------------

/** The two variables Cursor Private Inference reads. Regular Cursor ignores them. */
export const CURSOR_LOCAL_VARS = Object.freeze([
  "CURSOR_LOCAL_AGENT_BASE_URL",
  "CURSOR_LOCAL_AGENT_API_KEY",
]);

const execFileAsync = promisify(execFile);

/**
 * Set or clear the Cursor Private Inference variables in the macOS user session.
 *
 * `env` null unsets both. launchd forgets them at logout; the next switch
 * sets them again. Other platforms have no launchctl session to write.
 */
export async function setCursorUserEnv(env, { platform = process.platform, run = execFileAsync } = {}) {
  if (platform !== "darwin") return false;
  for (const key of CURSOR_LOCAL_VARS) {
    const args = env && Object.hasOwn(env, key) ? ["setenv", key, String(env[key])] : ["unsetenv", key];
    try {
      await run("launchctl", args);
    } catch (cause) {
      const action = args[0];
      throw new Error(
        `Could not ${action} ${key} with launchctl (${cause?.code ?? "error"}). ` +
          `Cursor Private Inference opened from the Dock will not see the new endpoint.`,
      );
    }
  }
  return true;
}

/** Env file body. The model line is ours, so status can show which Kong model was chosen. */
export function applyCursorLocalEnv(profile, { token } = {}) {
  const baseUrl = String(profile.baseUrl ?? "").replace(/\/+$/, "");
  const BEGIN = "# >>> kong-ai-switch (managed) >>>";
  const END = "# <<< kong-ai-switch (managed) <<<";
  return [
    BEGIN,
    "# Cursor Private Inference reads these two variables. Regular Cursor does not.",
    "# Magpie sets them the same way and does not edit ~/.cursor.",
    `export CURSOR_LOCAL_AGENT_BASE_URL=${shellQuote(baseUrl)}`,
    `export CURSOR_LOCAL_AGENT_API_KEY=${shellQuote(token || "kong-ai-gateway")}`,
    `# model=${profile.clientModelId ?? ""}`,
    END,
    "",
  ].join("\n");
}

function parseCursorLocalEnv(text) {
  const baseUrl = text.match(/^export CURSOR_LOCAL_AGENT_BASE_URL='([^']*)'/m)?.[1] ?? null;
  const hasToken = /^export CURSOR_LOCAL_AGENT_API_KEY='/m.test(text);
  const model = text.match(/^# model=(.*)$/m)?.[1] || null;
  return { baseUrl, hasToken, model };
}

function cursorLocalNotice({ userEnv, file }) {
  const lines = [
    "Cursor Private Inference reads CURSOR_LOCAL_AGENT_BASE_URL and CURSOR_LOCAL_AGENT_API_KEY.",
    "Quit that app completely (not only its window) and open it again.",
    "A base URL or API key in its Open configuration overrides these variables.",
  ];
  if (userEnv) {
    lines.push(
      "Set both for this macOS user session with launchctl. They clear at logout; the next switch sets them again.",
    );
  } else if (process.platform !== "darwin") {
    lines.push(`Source the file before a shell launch: set -a && source ${file} && set +a`);
  }
  return lines.join("\n");
}

async function applyCursorLocal(agent, profile, { token, home, userEnv }) {
  const file = agent.configPath(home);
  let existed = true;
  try {
    await stat(file);
  } catch {
    existed = false;
  }
  const key = token || "kong-ai-gateway";
  await writeAtomic(file, applyCursorLocalEnv(profile, { token: key }));

  const env = {
    CURSOR_LOCAL_AGENT_BASE_URL: String(profile.baseUrl ?? "").replace(/\/+$/, ""),
    CURSOR_LOCAL_AGENT_API_KEY: key,
  };
  // A scratch home (tests) must not call launchctl on the real user session.
  const enableUserEnv = userEnv !== undefined ? userEnv !== false : home === homedir();
  let userEnvApplied = false;
  if (enableUserEnv) {
    userEnvApplied =
      typeof userEnv === "function" ? Boolean(await userEnv(env)) : await setCursorUserEnv(env);
  }

  return {
    agent: agent.id,
    file,
    created: !existed,
    userEnv: userEnvApplied,
    notice: cursorLocalNotice({ userEnv: userEnvApplied, file }),
  };
}

async function statusCursorLocal(agent, { home }) {
  const file = agent.configPath(home);
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return { agent: agent.id, file, configured: false };
  }
  const parsed = parseCursorLocalEnv(text);
  return {
    agent: agent.id,
    file,
    configured: Boolean(parsed.baseUrl || parsed.model),
    baseUrl: parsed.baseUrl,
    model: parsed.model,
    hasToken: parsed.hasToken,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Point one agent at a model.
 * @returns {{agent: string, file: string, created: boolean, envFile?: string}}
 */
export async function applyToAgent(
  agentId,
  profile,
  {
    token,
    home = homedir(),
    authKind,
    clientId,
    credentialMode,
    modelDiscoveryEnabled,
    trailingSlash,
    includeLabelOverride,
    oidcScopes,
    oidcRedirectPort,
    oidcBearerTokenType,
    oidcAppendOfflineAccess,
    oidcAuthFlow,
    attribution,
    previousAttribution,
    environment,
    userEnv,
  } = {},
) {
  const agent = getAgent(agentId);
  if (agent.switchable === false) {
    throw new Error(notSwitchableMessage(agent));
  }
  const effective = authKind ? { ...profile, auth: authWithKind(profile.auth, authKind) } : profile;

  if (!agent.formats.includes(effective.format)) {
    throw new Error(
      `${agent.name} cannot call "${effective.name}": it serves the "${effective.format}" format, ` +
        `and ${agent.name} speaks ${agent.formats.join("/")}.`,
    );
  }

  const file = agent.configPath(home);

  if (agent.kind === "json-env") {
    const { settings, existed } = await readJsonSettings(file);
    const next = applyJsonEnv(settings, effective, { token });
    const record = readAttribution(attribution);
    applyAttributionToEnv(next.env, record, {
      credentialHeader: claudeCredentialHeader(effective),
      previous: previousAttribution ? readAttribution(previousAttribution) : undefined,
    });
    await writeAtomic(file, JSON.stringify(next, null, 2) + "\n");
    const wrapper = await writeAttributionWrapper(record, {
      home,
      staticBlock: next.env.ANTHROPIC_CUSTOM_HEADERS ?? "",
      environment,
    });
    return {
      agent: agent.id,
      file,
      created: !existed,
      attribution: {
        enabled: record.enabled,
        wrapperFile: wrapper.file,
        wrapperActive: wrapper.active,
      },
    };
  }

  if (agent.kind === "codex-toml") {
    let existing = null;
    let existed = true;
    try {
      existing = await readFile(file, "utf8");
    } catch (cause) {
      if (cause?.code !== "ENOENT") throw new Error(`Could not read ${file}: ${cause.message}`);
      existed = false;
    }
    const record = readAttribution(attribution, "codex");
    await writeAtomic(file, applyCodexToml(existing, effective, { token, attribution: record }));
    const wrapper = await writeAttributionWrapper(record, { home, environment, agentId: "codex" });
    return {
      agent: agent.id,
      file,
      created: !existed,
      attribution: {
        enabled: record.enabled,
        wrapperFile: wrapper.file,
        wrapperActive: wrapper.active,
      },
    };
  }

  if (agent.kind === "copilot") {
    const { settings, existed } = await readJsonSettings(file);
    const next = applyCopilotSettings(settings, effective);
    await writeAtomic(file, JSON.stringify(next, null, 2) + "\n");
    const envFile = agent.envPath(home);
    await writeAtomic(envFile, applyCopilotEnv(effective, { token }));
    return { agent: agent.id, file, envFile, created: !existed };
  }

  if (agent.kind === "cursor-local") {
    return applyCursorLocal(agent, effective, { token, home, userEnv });
  }

  if (agent.kind === "claude-desktop-3p") {
    return applyClaudeDesktop3p(agent, effective, {
      token,
      home,
      clientId,
      credentialMode,
      modelDiscoveryEnabled,
      trailingSlash,
      includeLabelOverride,
      oidcScopes,
      oidcRedirectPort,
      oidcBearerTokenType,
      oidcAppendOfflineAccess,
      oidcAuthFlow,
    });
  }

  throw new Error(`Agent "${agentId}" has no writer.`);
}

/** Read back which model an agent is currently pointed at. */
export async function agentStatus(agentId, { home = homedir() } = {}) {
  const agent = getAgent(agentId);
  const file = agent.configPath(home);

  if (agent.kind === "json-env") {
    const { settings, existed } = await readJsonSettings(file).catch(() => ({
      settings: {},
      existed: false,
    }));
    if (!existed) return { agent: agent.id, file, configured: false };
    const env = settings.env ?? {};
    return {
      agent: agent.id,
      file,
      configured: Boolean(env.ANTHROPIC_BASE_URL || env.ANTHROPIC_MODEL),
      baseUrl: env.ANTHROPIC_BASE_URL ?? null,
      model: env.ANTHROPIC_MODEL ?? null,
      hasToken: Boolean(env.ANTHROPIC_AUTH_TOKEN),
    };
  }

  if (agent.kind === "codex-toml") {
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return { agent: agent.id, file, configured: false };
    }
    // Only trust managed regions. Scanning the whole file picks up leftover
    // `[model_providers.custom] base_url = …` entries and blanks the radio.
    const scope = managedCodexScope(text);
    const configured = scope.includes(CODEX_MANAGED_BEGIN);
    const baseUrl = scope.match(/base_url\s*=\s*"([^"]+)"/)?.[1] ?? null;
    const model = scope.match(/^model\s*=\s*"([^"]+)"/m)?.[1] ?? null;
    return {
      agent: agent.id,
      file,
      configured,
      baseUrl,
      model,
      hasToken: codexHasCredential(scope) || /^\s*env_key\s*=/m.test(scope),
    };
  }

  if (agent.kind === "copilot") {
    const { settings, existed } = await readJsonSettings(file).catch(() => ({
      settings: {},
      existed: false,
    }));
    let baseUrl = null;
    let hasToken = false;
    try {
      const envText = await readFile(agent.envPath(home), "utf8");
      baseUrl = envText.match(/COPILOT_PROVIDER_BASE_URL='([^']*)'/)?.[1] ?? null;
      hasToken = /COPILOT_PROVIDER_API_KEY=/.test(envText);
    } catch {
      // Env file is optional until the first switch.
    }
    return {
      agent: agent.id,
      file,
      configured: Boolean(existed && (settings.model || baseUrl)),
      baseUrl,
      model: settings.model ?? null,
      hasToken,
      envFile: agent.envPath(home),
    };
  }

  if (agent.kind === "cursor-local") {
    return statusCursorLocal(agent, { home });
  }

  if (agent.kind === "claude-desktop-3p") {
    return statusClaudeDesktop3p(agent, { home });
  }

  return { agent: agent.id, file, configured: false };
}
