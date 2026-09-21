/**
 * Apply a Kong AI Gateway profile to Claude Code's settings.
 *
 * Claude Code reads ~/.claude/settings.json and honours an `env` block.
 * Switching means rewriting three keys there and leaving everything else
 * exactly as the user left it.
 *
 * Two rules govern every write:
 *   1. Only keys this tool owns are touched. Unknown fields survive untouched.
 *   2. The file is replaced atomically, so an interrupted write cannot leave
 *      a user with an unparseable settings file and a broken CLI.
 */

import { readFile, writeFile, rename, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Keys this tool owns. Anything else in `env` is the user's and is preserved.
 *
 * The last key is not cosmetic: a Kong AI Model name like "my-claude" is not
 * a model id Claude Code recognises, and without this flag it refuses to
 * start. Kong's own Claude Code guide sets it for the same reason.
 */
export const OWNED_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT",
];

export function claudeSettingsPath(home = homedir()) {
  return path.join(home, ".claude", "settings.json");
}

export async function readSettings(file = claudeSettingsPath()) {
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
    // Refuse to overwrite a file we cannot understand; the user may have
    // hand-edited it and clobbering it would lose their work.
    throw new Error(
      `${file} is not valid JSON (${cause.message}). Fix or move the file, then retry.`,
    );
  }
}

/**
 * Compute the settings object for a profile without writing anything.
 * Exported so callers can show a diff before committing.
 */
export function applyProfile(settings, profile, { token } = {}) {
  const next = structuredClone(settings ?? {});
  const env = { ...(next.env ?? {}) };

  env.ANTHROPIC_BASE_URL = profile.baseUrl;
  env.ANTHROPIC_MODEL = profile.clientModelId;
  // Kong model names are not Claude Code model ids; without this the CLI
  // refuses to start against an unrecognised model.
  env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT = "1";

  if (token) {
    env.ANTHROPIC_AUTH_TOKEN = token;
  } else if (!profile.requiresAuth) {
    // A gateway with no auth strategy still needs a non-empty token, or the
    // CLI falls back to its own credentials and bypasses the gateway.
    env.ANTHROPIC_AUTH_TOKEN = env.ANTHROPIC_AUTH_TOKEN || "kong-ai-gateway";
  }

  next.env = env;
  return next;
}

/** Write settings atomically: temp file in the same directory, then rename. */
export async function writeSettings(settings, file = claudeSettingsPath()) {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });

  let mode;
  try {
    mode = (await stat(file)).mode & 0o777;
  } catch {
    mode = 0o600; // Holds a token: default to owner-only.
  }

  const tmp = path.join(dir, `.settings.json.${process.pid}.${Date.now()}.tmp`);
  const body = JSON.stringify(settings, null, 2) + "\n";
  await writeFile(tmp, body, { encoding: "utf8", mode });
  await rename(tmp, file);
  return file;
}

/** Read, apply, and write in one step. Returns what changed. */
export async function switchTo(profile, { token, file = claudeSettingsPath() } = {}) {
  const { settings, existed } = await readSettings(file);
  const before = settings.env ?? {};
  const next = applyProfile(settings, profile, { token });
  await writeSettings(next, file);

  const changes = OWNED_ENV_KEYS.filter((key) => before[key] !== next.env[key]).map((key) => ({
    key,
    from: before[key],
    to: next.env[key],
  }));

  return { file, created: !existed, changes };
}

/** Read back which profile the CLI is currently pointed at. */
export async function currentTarget(file = claudeSettingsPath()) {
  const { settings, existed } = await readSettings(file);
  if (!existed) return null;
  const env = settings.env ?? {};
  if (!env.ANTHROPIC_BASE_URL && !env.ANTHROPIC_MODEL) return null;
  return {
    baseUrl: env.ANTHROPIC_BASE_URL ?? null,
    model: env.ANTHROPIC_MODEL ?? null,
    hasToken: Boolean(env.ANTHROPIC_AUTH_TOKEN),
  };
}
