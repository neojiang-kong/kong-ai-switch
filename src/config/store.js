/**
 * Local state for kong-ai-switch, kept in ~/.kong-ai-switch/.
 *
 * Holds the model catalogue synced from Kong so `list` and `use` work
 * offline, plus which profile was last applied.
 *
 * Catalogues are stored per environment. An SE who syncs a customer org
 * should not lose the models already pulled for their own org, so each
 * environment keeps its own entry and switching between them is instant.
 *
 * Deliberately never stores the Konnect token: that lives in the OS keychain
 * or, failing that, the config file, so this cache cannot leak credentials
 * for a whole organization.
 */

import { readFile, writeFile, mkdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const STATE_VERSION = 2;

export function stateDir(home = homedir()) {
  return path.join(home, ".kong-ai-switch");
}

export function statePath(home = homedir()) {
  return path.join(stateDir(home), "state.json");
}

const EMPTY = Object.freeze({
  version: STATE_VERSION,
  environments: {},
});

/** A single environment's synced catalogue. */
const EMPTY_ENTRY = Object.freeze({
  syncedAt: null,
  region: null,
  gateways: [],
  profiles: [],
  current: null,
});

/**
 * Carry a v1 state file forward.
 *
 * v1 held one flat catalogue with no notion of environments. Rather than
 * discard a sync the user already paid for, file it under the environment
 * they are using now.
 */
function migrate(parsed, fallbackEnv = "default") {
  if (parsed?.version === STATE_VERSION && parsed.environments) return parsed;

  if (Array.isArray(parsed?.profiles)) {
    return {
      version: STATE_VERSION,
      environments: {
        [fallbackEnv]: {
          syncedAt: parsed.syncedAt ?? null,
          region: parsed.region ?? null,
          gateways: parsed.gateways ?? [],
          profiles: parsed.profiles ?? [],
          current: parsed.current ?? null,
        },
      },
    };
  }

  return { ...EMPTY, environments: {} };
}

export async function readState(file = statePath(), { migrateInto = "default" } = {}) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (cause) {
    if (cause?.code === "ENOENT") return { ...EMPTY, environments: {} };
    throw new Error(`Could not read ${file}: ${cause.message}`);
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...EMPTY, environments: {} };
    return migrate(parsed, migrateInto);
  } catch {
    // A corrupt cache is not worth failing over; it is rebuildable by `sync`.
    return { ...EMPTY, environments: {} };
  }
}

/** The catalogue for one environment, empty when never synced. */
export function environmentState(state, envName) {
  return { ...EMPTY_ENTRY, ...(state.environments?.[envName] ?? {}) };
}

/** Replace one environment's catalogue, leaving the others untouched. */
export function putEnvironmentState(state, envName, entry) {
  return {
    ...state,
    version: STATE_VERSION,
    environments: {
      ...(state.environments ?? {}),
      [envName]: { ...EMPTY_ENTRY, ...entry },
    },
  };
}

/** Drop a cached catalogue, used when an environment is deleted. */
export function dropEnvironmentState(state, envName) {
  const environments = { ...(state.environments ?? {}) };
  delete environments[envName];
  return { ...state, environments };
}

export async function writeState(state, file = statePath()) {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });

  let mode;
  try {
    mode = (await stat(file)).mode & 0o777;
  } catch {
    mode = 0o600;
  }

  const tmp = path.join(dir, `.state.json.${process.pid}.${Date.now()}.tmp`);
  const body = JSON.stringify({ ...state, version: STATE_VERSION }, null, 2) + "\n";
  await writeFile(tmp, body, { encoding: "utf8", mode });
  await rename(tmp, file);
  return file;
}

/**
 * Resolve a user-typed name to a single profile.
 *
 * Matching is deliberately strict about ambiguity: when a short name maps to
 * several gateways, report the conflict instead of guessing, since guessing
 * would silently point the CLI at the wrong gateway.
 */
export function resolveProfile(profiles, query) {
  if (!query) return { profile: null, error: "No model name given." };
  const needle = String(query).trim();
  const lower = needle.toLowerCase();

  const exactId = profiles.find((p) => p.id === needle);
  if (exactId) return { profile: exactId, error: null };

  const byName = profiles.filter((p) => p.name.toLowerCase() === lower);
  if (byName.length === 1) return { profile: byName[0], error: null };
  if (byName.length > 1) {
    const options = byName.map((p) => `  ${p.id}   (gateway: ${p.gatewayName})`).join("\n");
    return {
      profile: null,
      error: `"${needle}" exists on ${byName.length} gateways. Use the full id:\n${options}`,
    };
  }

  const partial = profiles.filter(
    (p) => p.name.toLowerCase().includes(lower) || p.displayName.toLowerCase().includes(lower),
  );
  if (partial.length === 1) return { profile: partial[0], error: null };
  if (partial.length > 1) {
    const options = partial.slice(0, 10).map((p) => `  ${p.name}`).join("\n");
    return { profile: null, error: `"${needle}" matches several models:\n${options}` };
  }

  return {
    profile: null,
    error: `No model named "${needle}". Run "kong-ai-switch list" to see what is available.`,
  };
}
