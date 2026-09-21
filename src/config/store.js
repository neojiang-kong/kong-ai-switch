/**
 * Local state for kong-ai-switch, kept in ~/.kong-ai-switch/.
 *
 * Holds the model catalogue synced from Kong so `list` and `use` work
 * offline, plus which profile was last applied.
 *
 * Deliberately never stores the Konnect token: that comes from the
 * environment or the OS keychain, so a readable config file cannot leak
 * credentials for the whole organization.
 */

import { readFile, writeFile, mkdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const STATE_VERSION = 1;

export function stateDir(home = homedir()) {
  return path.join(home, ".kong-ai-switch");
}

export function statePath(home = homedir()) {
  return path.join(stateDir(home), "state.json");
}

const EMPTY = Object.freeze({
  version: STATE_VERSION,
  syncedAt: null,
  region: null,
  gateways: [],
  profiles: [],
  current: null,
});

export async function readState(file = statePath()) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (cause) {
    if (cause?.code === "ENOENT") return { ...EMPTY };
    throw new Error(`Could not read ${file}: ${cause.message}`);
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...EMPTY };
    return { ...EMPTY, ...parsed };
  } catch {
    // A corrupt cache is not worth failing over; it is rebuildable by `sync`.
    return { ...EMPTY };
  }
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
