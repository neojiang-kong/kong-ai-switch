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

/** Agents this tool can configure. */
export const AGENTS = {
  "claude-code": {
    id: "claude-code",
    name: "Claude Code",
    /** Kong model formats this agent can call. */
    formats: ["anthropic"],
    kind: "json-env",
    configPath: (home) => path.join(home, ".claude", "settings.json"),
    /** Keys this tool owns; everything else in the file is the user's. */
    ownedKeys: [
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_MODEL",
      "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT",
    ],
  },

  "claude-desktop": {
    id: "claude-desktop",
    name: "Claude Desktop",
    formats: ["anthropic"],
    kind: "json-env",
    // Claude Desktop reads the same settings file as Claude Code for env.
    configPath: (home) => path.join(home, ".claude", "settings.json"),
    ownedKeys: [
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_MODEL",
      "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT",
    ],
    /** Shares a file with Claude Code, so switching one switches both. */
    sharesConfigWith: "claude-code",
  },

  codex: {
    id: "codex",
    name: "Codex CLI",
    formats: ["openai"],
    kind: "codex-toml",
    configPath: (home) => path.join(home, ".codex", "config.toml"),
    ownedKeys: ["model_provider", "model", "model_providers.kong"],
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
// JSON env agents (Claude Code, Claude Desktop)
// ---------------------------------------------------------------------------

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
  const header = profile.auth?.preferred?.header;
  const usesCustomHeader =
    profile.auth?.preferred?.kind === "key-auth" &&
    header &&
    header.toLowerCase() !== "authorization";

  if (token && usesCustomHeader) {
    env.ANTHROPIC_CUSTOM_HEADERS = `${header}: ${token}`;
    // Claude Code still needs a non-empty token or it falls back to its own
    // credentials and bypasses the gateway entirely.
    env.ANTHROPIC_AUTH_TOKEN = env.ANTHROPIC_AUTH_TOKEN || "kong-ai-gateway";
  } else if (token) {
    env.ANTHROPIC_AUTH_TOKEN = token;
  } else if (!profile.requiresAuth) {
    env.ANTHROPIC_AUTH_TOKEN = env.ANTHROPIC_AUTH_TOKEN || "kong-ai-gateway";
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

/**
 * Rewrite Codex's config.toml, replacing only the block this tool owns.
 *
 * Codex config is hand-edited more often than Claude's, so the user's other
 * settings are preserved verbatim: the managed block is delimited by markers
 * and everything outside them is copied through untouched.
 */
function applyCodexToml(existing, profile, { token }) {
  const BEGIN = "# >>> kong-ai-switch (managed) >>>";
  const END = "# <<< kong-ai-switch (managed) <<<";

  const block = [
    BEGIN,
    `model_provider = "kong"`,
    `model = ${tomlString(profile.clientModelId)}`,
    "",
    "[model_providers.kong]",
    `name = "Kong AI Gateway"`,
    `base_url = ${tomlString(profile.baseUrl)}`,
    `wire_api = "chat"`,
    ...(token ? [`env_key = "KONG_AI_TOKEN"`] : []),
    END,
  ].join("\n");

  const text = existing ?? "";
  const beginAt = text.indexOf(BEGIN);
  const endAt = text.indexOf(END);

  if (beginAt !== -1 && endAt !== -1 && endAt > beginAt) {
    return text.slice(0, beginAt) + block + text.slice(endAt + END.length);
  }
  return text.trim() === "" ? block + "\n" : `${text.trimEnd()}\n\n${block}\n`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Point one agent at a model.
 * @returns {{agent: string, file: string, created: boolean}}
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
    const managed = text.includes("# >>> kong-ai-switch (managed) >>>");
    const baseUrl = text.match(/base_url\s*=\s*"([^"]+)"/)?.[1] ?? null;
    const model = text.match(/^model\s*=\s*"([^"]+)"/m)?.[1] ?? null;
    return {
      agent: agent.id,
      file,
      configured: managed,
      baseUrl,
      model,
      hasToken: text.includes("env_key"),
    };
  }

  return { agent: agent.id, file, configured: false };
}
