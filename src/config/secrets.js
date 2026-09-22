/**
 * Credential storage for environments.
 *
 * A Konnect personal access token is an organization-wide credential, so it
 * does not belong in a config file if the OS offers somewhere better. On
 * macOS that is the login Keychain, reached through `security`, which keeps
 * the value out of the repo, out of backups of dotfiles, and out of anything
 * that greps the home directory.
 *
 * Elsewhere, or when the keychain refuses, fall back to the config file with
 * owner-only permissions and tell the caller which backend was used, so the
 * CLI can say plainly where a token ended up rather than implying a
 * guarantee the platform did not give.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const SERVICE = "kong-ai-switch";
/** Keychain calls are local; a hung `security` should not wedge the CLI. */
const TIMEOUT_MS = 5_000;

export const BACKEND = {
  KEYCHAIN: "keychain",
  FILE: "file",
  NONE: "none",
};

/** Whether the macOS keychain is usable in this process. */
export async function keychainAvailable() {
  if (process.platform !== "darwin") return false;
  if (process.env.KONG_AI_SWITCH_NO_KEYCHAIN) return false;
  try {
    await run("security", ["-h"], { timeout: TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

function accountFor(envName) {
  return `konnect-pat:${envName}`;
}

/**
 * Store a token. Returns the backend that accepted it, so the caller can
 * report where it went; a file fallback is a meaningfully weaker promise
 * than the keychain and should not be described as the same thing.
 */
export async function setToken(envName, token, { keychain } = {}) {
  const useKeychain = keychain ?? (await keychainAvailable());
  if (!useKeychain) return BACKEND.FILE;

  try {
    // -U updates in place when the item already exists.
    await run(
      "security",
      [
        "add-generic-password",
        "-a", accountFor(envName),
        "-s", SERVICE,
        "-w", token,
        "-U",
        "-D", "kong-ai-switch Konnect token",
      ],
      { timeout: TIMEOUT_MS },
    );
    return BACKEND.KEYCHAIN;
  } catch {
    return BACKEND.FILE;
  }
}

/** Read a token from the keychain, or null when absent or unavailable. */
export async function getToken(envName, { keychain } = {}) {
  const useKeychain = keychain ?? (await keychainAvailable());
  if (!useKeychain) return null;

  try {
    const { stdout } = await run(
      "security",
      ["find-generic-password", "-a", accountFor(envName), "-s", SERVICE, "-w"],
      { timeout: TIMEOUT_MS },
    );
    const value = stdout.replace(/\n$/, "");
    return value === "" ? null : value;
  } catch {
    // Exit code 44 means "not found", which is ordinary, not an error.
    return null;
  }
}

/** Remove a token. Absent is success: the postcondition is what matters. */
export async function deleteToken(envName, { keychain } = {}) {
  const useKeychain = keychain ?? (await keychainAvailable());
  if (!useKeychain) return false;

  try {
    await run(
      "security",
      ["delete-generic-password", "-a", accountFor(envName), "-s", SERVICE],
      { timeout: TIMEOUT_MS },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the token for an environment, in precedence order:
 *   1. KONNECT_TOKEN, so CI and one-off overrides always win
 *   2. the OS keychain
 *   3. the environment record itself (file fallback)
 *
 * Returns both the value and where it came from, so `env list` can show an
 * SE which of their environments are actually ready to sync.
 */
export async function resolveToken(env, { keychain } = {}) {
  const fromEnv = process.env.KONNECT_TOKEN;
  if (fromEnv) return { token: fromEnv, source: "KONNECT_TOKEN" };

  const fromKeychain = await getToken(env.name, { keychain });
  if (fromKeychain) return { token: fromKeychain, source: BACKEND.KEYCHAIN };

  if (env.token) return { token: env.token, source: BACKEND.FILE };

  return { token: null, source: BACKEND.NONE };
}
