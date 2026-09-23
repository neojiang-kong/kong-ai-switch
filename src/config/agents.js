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
 */

import { readFile, writeFile, rename, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { authWithKind } from "../kong/auth.js";

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
    ],
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
    /** Stable profile id we own inside configLibrary. */
    profileId: "6b6f6e67-6169-4e67-8000-73776974636801",
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
    ],
  },

  codex: {
    id: "codex",
    name: "Codex CLI",
    vendor: "openai",
    formats: ["openai"],
    kind: "codex-toml",
    configPath: (home) => path.join(home, ".codex", "config.toml"),
    ownedKeys: ["model_provider", "model", "model_providers.kong"],
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
  for (const agent of listAgents()) {
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
 */
const CLAUDE_DESKTOP_PROFILE_ID = "6b6f6e67-6169-4e67-8000-73776974636801";
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
 */
export function buildClaudeDesktopProfile(profile, { token } = {}) {
  const baseUrl = String(profile.baseUrl ?? "").replace(/\/?$/, "/");
  const modelName = profile.clientModelId ?? profile.name;
  const next = {
    inferenceProvider: "gateway",
    inferenceGatewayBaseUrl: baseUrl,
    inferenceModels: [
      {
        name: modelName,
        labelOverride: profile.displayName ?? modelName,
      },
    ],
  };

  const preferred = profile.auth?.preferred;
  const kind = preferred?.kind;
  const header = preferred?.header ?? "Authorization";
  const issuer = preferred?.issuer ?? null;

  if (kind === "openid-connect" && issuer) {
    // Interactive PKCE — same loopback defaults as Claude Desktop / our app.
    next.inferenceCredentialKind = "interactive";
    next.inferenceGatewayOidcAuthFlow = "browser";
    next.inferenceGatewayOidc = {
      issuer,
      clientId: "claude-desktop",
      scopes: "openid profile email",
      bearerTokenType: "access_token",
      redirectPort: 53180,
      appendOfflineAccess: true,
    };
    // If the user just signed in and passed a token, also stash it as a
    // static fallback so the first request works before interactive refresh.
    if (token) {
      next.inferenceGatewayApiKey = token;
      next.inferenceGatewayAuthScheme = "bearer";
    }
    return next;
  }

  next.inferenceCredentialKind = "static";
  if (token) {
    const lower = header.toLowerCase();
    if (lower === "authorization") {
      next.inferenceGatewayApiKey = token;
      next.inferenceGatewayAuthScheme = "bearer";
    } else if (lower === "x-api-key") {
      next.inferenceGatewayApiKey = token;
      next.inferenceGatewayAuthScheme = "x-api-key";
    } else {
      // Kong key-auth default is `apikey`, which is neither scheme.
      next.inferenceGatewayApiKey = "kong-ai-gateway";
      next.inferenceGatewayAuthScheme = "bearer";
      next.inferenceCustomHeaders = { [header]: token };
    }
  } else if (!profile.requiresAuth) {
    next.inferenceGatewayApiKey = "kong-ai-gateway";
    next.inferenceGatewayAuthScheme = "bearer";
  }

  return next;
}

async function applyClaudeDesktop3p(agent, profile, { token, home }) {
  const libraryDir = agent.configPath(home);
  await mkdir(libraryDir, { recursive: true });

  const profileId = agent.profileId ?? CLAUDE_DESKTOP_PROFILE_ID;
  const profileName = agent.profileName ?? CLAUDE_DESKTOP_PROFILE_NAME;
  const profileFile = path.join(libraryDir, `${profileId}.json`);
  const body = buildClaudeDesktopProfile(profile, { token });
  await writeAtomic(profileFile, JSON.stringify(body, null, 2) + "\n");

  const { meta, metaFile } = await readClaudeDesktopMeta(libraryDir);
  const entries = Array.isArray(meta.entries) ? [...meta.entries] : [];
  const withoutUs = entries.filter((e) => e?.id !== profileId);
  withoutUs.push({ id: profileId, name: profileName });
  const nextMeta = {
    appliedId: profileId,
    entries: withoutUs,
  };
  await writeAtomic(metaFile, JSON.stringify(nextMeta, null, 2) + "\n");

  return { agent: agent.id, file: profileFile, created: true, libraryDir };
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
  const header = profile.auth?.preferred?.header;
  const usesCustomHeader =
    profile.auth?.preferred?.kind === "key-auth" &&
    header &&
    header.toLowerCase() !== "authorization";

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

// ---------------------------------------------------------------------------
// Codex TOML
// ---------------------------------------------------------------------------

/** Quote a TOML string, escaping what the format requires. */
function tomlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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
function applyCodexToml(existing, profile, { token }) {
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
  if (rest === "") return `${rootBlock}\n\n${providerBlock}\n`;
  return `${rootBlock}\n\n${rest}\n\n${providerBlock}\n`;
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
    return [`http_headers = { ${header} = ${tomlString(token)} }`];
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
// Public API
// ---------------------------------------------------------------------------

/**
 * Point one agent at a model.
 * @returns {{agent: string, file: string, created: boolean, envFile?: string}}
 */
export async function applyToAgent(agentId, profile, { token, home = homedir(), authKind } = {}) {
  const agent = getAgent(agentId);
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
    await writeAtomic(file, JSON.stringify(next, null, 2) + "\n");
    return { agent: agent.id, file, created: !existed };
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
    await writeAtomic(file, applyCodexToml(existing, effective, { token }));
    return { agent: agent.id, file, created: !existed };
  }

  if (agent.kind === "copilot") {
    const { settings, existed } = await readJsonSettings(file);
    const next = applyCopilotSettings(settings, effective);
    await writeAtomic(file, JSON.stringify(next, null, 2) + "\n");
    const envFile = agent.envPath(home);
    await writeAtomic(envFile, applyCopilotEnv(effective, { token }));
    return { agent: agent.id, file, envFile, created: !existed };
  }

  if (agent.kind === "claude-desktop-3p") {
    return applyClaudeDesktop3p(agent, effective, { token, home });
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
      hasToken: /experimental_bearer_token|http_headers|env_key/.test(scope),
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

  if (agent.kind === "claude-desktop-3p") {
    return statusClaudeDesktop3p(agent, { home });
  }

  return { agent: agent.id, file, configured: false };
}
