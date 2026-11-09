/**
 * Which coding agents are actually installed.
 *
 * Looks for the product itself — a binary or a .app — by stating explicit
 * paths. Never consults config files this tool writes (those appear after
 * the first switch and would be false positives), and never shells out to
 * `which`, `command -v`, a login shell, or `mdfind`.
 *
 * A menu bar app has a minimal PATH, so the usual install locations are
 * checked first, then version-manager shims (same idea as the Node lookup
 * in CLIDiscovery.nodeSearchPaths), then directories already on PATH.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

/** Drop a trailing slash so `/opt/homebrew/bin/` and `…/bin` are one directory. */
function normalizeDir(dir) {
  const trimmed = String(dir ?? "");
  if (trimmed.length > 1 && trimmed.endsWith(path.sep)) return trimmed.replace(/\/+$/, "");
  return trimmed;
}

async function defaultStat(file) {
  try {
    return await stat(file);
  } catch {
    return null;
  }
}

async function defaultReadFile(file) {
  return readFile(file);
}

async function defaultListDir(dir) {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Directories to search for an agent binary, in order.
 *
 * 1. Homebrew (Apple Silicon, then Intel) and ~/.local/bin
 * 2. nvm, fnm, Volta, and asdf shims
 * 3. directories already on PATH
 */
export async function binarySearchDirs(home, { pathEnv = "", listDir = defaultListDir } = {}) {
  const dirs = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".local", "bin"),
    path.join(home, ".nvm", "versions", "node", "current", "bin"),
  ];

  const nvmRoot = path.join(home, ".nvm", "versions", "node");
  const versions = [...(await listDir(nvmRoot))]
    .filter((name) => name && name !== "current")
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  for (const version of versions) {
    dirs.push(path.join(nvmRoot, version, "bin"));
  }

  dirs.push(
    path.join(home, ".fnm", "current", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".asdf", "shims"),
  );

  const seen = new Set(dirs.map(normalizeDir));
  for (const entry of String(pathEnv).split(path.delimiter)) {
    const dir = normalizeDir(entry);
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
  }
  return dirs;
}

/**
 * True when Info.plist's CFBundleIdentifier is `expected`.
 * XML plists are matched on that key. Binary plists (bplist) must contain
 * both the key and the identifier as strings. Anything else does not match.
 */
export function bundleIdMatches(contents, expected) {
  const buf = Buffer.isBuffer(contents)
    ? contents
    : Buffer.from(contents instanceof Uint8Array ? contents : String(contents ?? ""));
  const text = buf.toString("utf8");
  if (text.includes("<key>CFBundleIdentifier</key>") || text.includes("<key> CFBundleIdentifier </key>")) {
    const match = text.match(/<key>\s*CFBundleIdentifier\s*<\/key>\s*<string>\s*([^<]*?)\s*<\/string>/);
    return match?.[1] === expected;
  }
  if (buf.subarray(0, 6).toString("ascii") === "bplist") {
    const id = Buffer.from(String(expected));
    const key = Buffer.from("CFBundleIdentifier");
    return buf.includes(key) && buf.includes(id);
  }
  return false;
}

async function statKind(file, statImpl, kind) {
  const info = await statImpl(file);
  if (!info) return false;
  if (kind === "file") return Boolean(info.isFile?.());
  if (kind === "dir") return Boolean(info.isDirectory?.());
  return Boolean(info.isFile?.() || info.isDirectory?.());
}

/**
 * @param {object} agent agent entry from AGENTS
 * @returns {Promise<{installed: boolean, foundAt: string | null}>}
 */
export async function detectAgentInstall(agent, options = {}) {
  const {
    home,
    platform = process.platform,
    pathEnv = process.env.PATH ?? "",
    stat: statImpl = defaultStat,
    readFile: readImpl = defaultReadFile,
    listDir = defaultListDir,
  } = options;

  if (!home) {
    throw new Error("detectAgentInstall requires home so detection does not assume a machine.");
  }

  const install = agent.install ?? {};
  const ignoredBins = new Set(install.ignoreBinaries ?? []);
  const ignoredApps = new Set(install.ignoreApps ?? []);

  const dirs = await binarySearchDirs(home, { pathEnv, listDir });
  for (const name of install.binaries ?? []) {
    if (ignoredBins.has(name)) continue;
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      if (await statKind(candidate, statImpl, "file")) {
        return { installed: true, foundAt: candidate };
      }
    }
  }

  const extraKind = install.pathKind === "file" || install.pathKind === "dir" ? install.pathKind : "any";
  for (const candidate of install.paths?.(home) ?? []) {
    if (await statKind(candidate, statImpl, extraKind)) {
      return { installed: true, foundAt: candidate };
    }
  }

  if (platform === "darwin") {
    for (const app of install.apps ?? []) {
      if (!app?.name || ignoredApps.has(app.name)) continue;
      for (const root of ["/Applications", path.join(home, "Applications")]) {
        const bundle = path.join(root, app.name);
        if (!(await statKind(bundle, statImpl, "dir"))) continue;
        if (!app.bundleId) return { installed: true, foundAt: bundle };
        const plistPath = path.join(bundle, "Contents", "Info.plist");
        let contents;
        try {
          contents = await readImpl(plistPath);
        } catch {
          continue;
        }
        if (bundleIdMatches(contents, app.bundleId)) {
          return { installed: true, foundAt: bundle };
        }
      }
    }
  }

  return { installed: false, foundAt: null };
}
