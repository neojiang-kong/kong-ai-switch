/**
 * Named environments.
 *
 * An SE works across their own Konnect org, a shared demo org, and whichever
 * customer they are with this week. Each has a different region, data plane
 * address and token. Re-exporting shell variables to move between them is
 * both tedious and easy to get wrong in front of a customer, so an
 * environment is a named record that can be defined once and selected by name.
 *
 * Environments live in ~/.kong-ai-switch/config.json. Synced model
 * catalogues live per-environment in state.json, so switching environments
 * does not discard the models already pulled for the others.
 */

import { readFile, writeFile, mkdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { KONNECT_REGIONS } from "../kong/client.js";

const CONFIG_VERSION = 1;

/** Names become keys in files and on the command line: keep them boring. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function configPath(home = homedir()) {
  return path.join(home, ".kong-ai-switch", "config.json");
}

const EMPTY = Object.freeze({
  version: CONFIG_VERSION,
  active: null,
  environments: {},
});

export class ConfigError extends Error {}

export function validateName(name) {
  if (!name || !String(name).trim()) throw new ConfigError("An environment name is required.");
  const value = String(name).trim();
  if (!NAME_PATTERN.test(value)) {
    throw new ConfigError(
      `"${value}" is not a usable environment name. Use letters, digits, dot, dash or underscore ` +
        `(up to 64 characters), starting with a letter or digit.`,
    );
  }
  return value;
}

/**
 * Validate a region key or control plane URL up front, so a typo is caught
 * when the environment is defined rather than at the next sync.
 */
export function validateRegion(region) {
  const value = String(region ?? "us").trim();
  if (/^https?:\/\//i.test(value)) return value.replace(/\/+$/, "");
  if (!KONNECT_REGIONS[value.toLowerCase()]) {
    throw new ConfigError(
      `Unknown region "${value}". Known regions: ${Object.keys(KONNECT_REGIONS).join(", ")}. ` +
        `You can also give a full control plane URL.`,
    );
  }
  return value.toLowerCase();
}

export function validateProxyUrl(url) {
  if (url === undefined || url === null || url === "") return null;
  const value = String(url).trim();
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(
      `"${value}" is not a valid URL. Give the data plane address, e.g. http://localhost:8000`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError(`The proxy URL must be http or https, not "${parsed.protocol}".`);
  }
  return value.replace(/\/+$/, "");
}

export async function readConfig(file = configPath()) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (cause) {
    if (cause?.code === "ENOENT") return { ...EMPTY, environments: {} };
    throw new ConfigError(`Could not read ${file}: ${cause.message}`);
  }

  if (raw.trim() === "") return { ...EMPTY, environments: {} };

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return {
      version: CONFIG_VERSION,
      active: typeof parsed.active === "string" ? parsed.active : null,
      environments:
        parsed.environments && typeof parsed.environments === "object" ? parsed.environments : {},
    };
  } catch (cause) {
    // A hand-edited config is the user's work; refuse rather than clobber it.
    throw new ConfigError(
      `${file} is not valid JSON (${cause.message}). Fix or move the file, then retry.`,
    );
  }
}

export async function writeConfig(config, file = configPath()) {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });

  let mode;
  try {
    mode = (await stat(file)).mode & 0o777;
  } catch {
    mode = 0o600; // May hold a token on platforms without a keychain.
  }

  const tmp = path.join(dir, `.config.json.${process.pid}.${Date.now()}.tmp`);
  const body = JSON.stringify({ ...config, version: CONFIG_VERSION }, null, 2) + "\n";
  await writeFile(tmp, body, { encoding: "utf8", mode });
  await rename(tmp, file);
  return file;
}

/**
 * Create or replace an environment.
 * The token is handled by the caller via the secret store and is only kept
 * here when no keychain accepted it.
 */
export function putEnvironment(config, { name, region, proxyUrl, gateway, token, description, organizationName }) {
  const safeName = validateName(name);
  const next = { ...config, environments: { ...config.environments } };

  const existing = next.environments[safeName] ?? {};
  const record = {
    name: safeName,
    region: validateRegion(region ?? existing.region ?? "us"),
    proxyUrl: proxyUrl === undefined ? (existing.proxyUrl ?? null) : validateProxyUrl(proxyUrl),
    gateway: gateway === undefined ? (existing.gateway ?? null) : (gateway || null),
    description:
      description === undefined ? (existing.description ?? null) : (description || null),
    organizationName:
      organizationName === undefined
        ? (existing.organizationName ?? null)
        : (organizationName || null),
    createdAt: existing.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Only persist a token here when it could not go to the keychain.
  if (token !== undefined) {
    if (token === null) delete record.token;
    else record.token = token;
  } else if (existing.token) {
    record.token = existing.token;
  }

  next.environments[safeName] = record;
  if (!next.active) next.active = safeName;
  return next;
}

export function removeEnvironment(config, name) {
  const safeName = validateName(name);
  if (!config.environments[safeName]) {
    throw new ConfigError(`No environment named "${safeName}".`);
  }
  const environments = { ...config.environments };
  delete environments[safeName];

  let active = config.active;
  if (active === safeName) {
    // Pick a deterministic successor rather than leaving a dangling pointer.
    const remaining = Object.keys(environments).sort();
    active = remaining[0] ?? null;
  }
  return { ...config, environments, active };
}

export function setActive(config, name) {
  const safeName = validateName(name);
  if (!config.environments[safeName]) {
    throw new ConfigError(
      `No environment named "${safeName}". Run "kong-ai-switch env list" to see what is defined.`,
    );
  }
  return { ...config, active: safeName };
}

export function listEnvironments(config) {
  return Object.values(config.environments ?? {}).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve which environment a command should act on.
 * An explicit --env always wins over the active one, so an SE can run a
 * single command against a customer org without changing their default.
 */
export function resolveEnvironment(config, requested) {
  const environments = config.environments ?? {};
  const names = Object.keys(environments);

  if (requested) {
    const safeName = validateName(requested);
    const found = environments[safeName];
    if (!found) {
      const known = names.length ? names.sort().join(", ") : "none defined";
      throw new ConfigError(`No environment named "${safeName}". Defined: ${known}.`);
    }
    return found;
  }

  if (config.active && environments[config.active]) return environments[config.active];

  if (names.length === 1) return environments[names[0]];

  if (names.length === 0) {
    throw new ConfigError(
      "No environments defined yet. Create one with:\n" +
        "  kong-ai-switch env add <name> --region us --proxy-url http://localhost:8000",
    );
  }

  throw new ConfigError(
    `No active environment. Choose one with "kong-ai-switch env use <name>", or pass --env. ` +
      `Defined: ${names.sort().join(", ")}.`,
  );
}

/**
 * Shape an environment for sharing.
 * Credentials are dropped, not blanked, so an exported file cannot leak a
 * token even if someone commits it. The recipient supplies their own.
 */
export function toShareable(env) {
  return {
    kind: "kong-ai-switch/environment",
    version: CONFIG_VERSION,
    name: env.name,
    region: env.region,
    proxyUrl: env.proxyUrl ?? null,
    gateway: env.gateway ?? null,
    description: env.description ?? null,
  };
}

/** Parse a shared environment file, rejecting anything unrecognisable. */
export function fromShareable(raw, { name } = {}) {
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (cause) {
    throw new ConfigError(`That file is not valid JSON (${cause.message}).`);
  }

  if (!parsed || typeof parsed !== "object" || parsed.kind !== "kong-ai-switch/environment") {
    throw new ConfigError(
      "That file is not a kong-ai-switch environment export. Expected a JSON object with " +
        '"kind": "kong-ai-switch/environment".',
    );
  }

  return {
    name: validateName(name ?? parsed.name),
    region: validateRegion(parsed.region),
    proxyUrl: validateProxyUrl(parsed.proxyUrl ?? null),
    gateway: parsed.gateway || null,
    description: parsed.description || null,
  };
}
