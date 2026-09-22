#!/usr/bin/env node
/**
 * kong-ai-switch — point Claude Code at models served by Kong AI Gateway 2.0.
 *
 * Built for engineers who move between Konnect orgs: your own, a shared demo
 * org, and whichever customer you are with today. Each is a named
 * environment holding its region, data plane address and token, so switching
 * is `env use <name>` rather than re-exporting shell variables.
 */

import process from "node:process";
import { readFile, writeFile } from "node:fs/promises";
import { KongAiGatewayClient, KongApiError, KONNECT_REGIONS } from "../kong/client.js";
import { buildProfiles, gatewayOrigin } from "../kong/models.js";
import {
  readState,
  writeState,
  resolveProfile,
  environmentState,
  putEnvironmentState,
  dropEnvironmentState,
} from "../config/store.js";
import {
  readConfig,
  writeConfig,
  putEnvironment,
  removeEnvironment,
  setActive,
  listEnvironments,
  resolveEnvironment,
  toShareable,
  fromShareable,
  ConfigError,
  configPath,
} from "../config/environments.js";
import { resolveToken, setToken, deleteToken, BACKEND } from "../config/secrets.js";
import { switchTo, currentTarget, claudeSettingsPath } from "../config/claude.js";
import {
  listAgents,
  getAgent,
  applyToAgent,
  agentStatus,
  agentsForModel,
} from "../config/agents.js";

const USAGE = `kong-ai-switch — switch Claude Code between Kong AI Gateway models

Environments:
  kong-ai-switch env add <name> --region <r> [--proxy-url <url>] [--token <pat>]
  kong-ai-switch env list
  kong-ai-switch env use <name>
  kong-ai-switch env show [<name>]
  kong-ai-switch env set <name> [--region <r>] [--proxy-url <url>] [--token <pat>]
  kong-ai-switch env remove <name>
  kong-ai-switch env export <name> [--out <file>]     share without credentials
  kong-ai-switch env import <file> [--name <name>]

Models:
  kong-ai-switch discover --token <pat> [--region <r>]  find gateways from a token
  kong-ai-switch sync [--env <name>] [--gateway <id>]
  kong-ai-switch list [--env <name>] [--all] [--json]
  kong-ai-switch use <model> [--env <name>] [--agent <a,b>] [--token <t>]
  kong-ai-switch agents                                 which agents, and where they point
  kong-ai-switch status

Every model command takes --env to act on one environment without changing
the active one.

Environment variables (override the active environment):
  KONNECT_TOKEN       Konnect personal access token
  KONNECT_PROXY_URL   data plane address, e.g. http://localhost:8000
  KONG_AI_TOKEN       credential for models behind an AI Auth Strategy

Regions: ${Object.keys(KONNECT_REGIONS).join(", ")}, or a full control plane URL
`;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i += 1;
      }
    } else positional.push(arg);
  }
  return { command, flags, positional };
}

class UserError extends Error {}

/**
 * Emit a machine-readable result and stop.
 *
 * The SwiftUI app drives this CLI rather than reimplementing the Kong logic,
 * so every command it calls needs a stable JSON shape. Human output stays on
 * stdout as prose; --json replaces it entirely so a parser never has to strip
 * decoration. Errors use the same envelope with ok:false, which means the app
 * can surface a real message instead of a generic failure.
 */
function emitJson(payload) {
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}

/** Load config and pick the environment a model command should act on. */
async function activeEnvironment(flags) {
  const config = await readConfig();
  const env = resolveEnvironment(config, flags.env);
  return { config, env };
}

/**
 * Store a token in the best available place and report where it went.
 * Never claim keychain safety the platform did not actually provide.
 */
async function persistToken(name, token) {
  const backend = await setToken(name, token);
  return { backend, inFile: backend === BACKEND.FILE };
}

async function cmdEnvAdd(positional, flags) {
  const name = positional[0];
  if (!name) throw new UserError("Usage: kong-ai-switch env add <name> --region <region>");

  const config = await readConfig();
  if (config.environments[name] && !flags.force) {
    throw new UserError(`"${name}" already exists. Use "env set" to change it, or --force to replace.`);
  }

  const token = typeof flags.token === "string" ? flags.token : null;
  let stored = { backend: BACKEND.NONE, inFile: false };
  if (token) stored = await persistToken(name, token);

  const next = putEnvironment(config, {
    name,
    region: flags.region,
    proxyUrl: flags["proxy-url"],
    gateway: flags.gateway,
    description: typeof flags.description === "string" ? flags.description : undefined,
    // Only keep the token in the file when no keychain took it.
    token: token && stored.inFile ? token : null,
  });
  await writeConfig(next);

  process.stdout.write(`Added environment "${name}".\n`);
  process.stdout.write(`  region     ${next.environments[name].region}\n`);
  process.stdout.write(`  proxy URL  ${next.environments[name].proxyUrl ?? "(not set)"}\n`);
  if (token) {
    process.stdout.write(
      stored.backend === BACKEND.KEYCHAIN
        ? "  token      stored in the macOS Keychain\n"
        : `  token      stored in ${configPath()} (owner-only; no keychain available)\n`,
    );
  }
  if (next.active === name) process.stdout.write(`\n"${name}" is now the active environment.\n`);
  if (!next.environments[name].proxyUrl) {
    process.stdout.write(
      "\nNo proxy URL set. AI Gateway data planes are self-managed, so one is usually needed:\n" +
        `  kong-ai-switch env set ${name} --proxy-url http://localhost:8000\n`,
    );
  }
}

async function cmdEnvSet(positional, flags) {
  const name = positional[0];
  if (!name) throw new UserError("Usage: kong-ai-switch env set <name> [--region r] [--proxy-url u]");

  const config = await readConfig();
  if (!config.environments[name]) {
    throw new UserError(`No environment named "${name}". Create it with "env add".`);
  }

  const token = typeof flags.token === "string" ? flags.token : null;
  let stored = { backend: BACKEND.NONE, inFile: false };
  if (token) stored = await persistToken(name, token);

  const next = putEnvironment(config, {
    name,
    region: flags.region,
    proxyUrl: flags["proxy-url"],
    gateway: flags.gateway,
    description: typeof flags.description === "string" ? flags.description : undefined,
    token: token ? (stored.inFile ? token : null) : undefined,
  });
  await writeConfig(next);

  process.stdout.write(`Updated "${name}".\n`);
  const record = next.environments[name];
  process.stdout.write(`  region     ${record.region}\n`);
  process.stdout.write(`  proxy URL  ${record.proxyUrl ?? "(not set)"}\n`);
  if (token) {
    process.stdout.write(
      stored.backend === BACKEND.KEYCHAIN
        ? "  token      updated in the macOS Keychain\n"
        : `  token      stored in ${configPath()} (owner-only; no keychain available)\n`,
    );
  }
  process.stdout.write('\nRun "kong-ai-switch sync" to refresh models for this environment.\n');
}

async function cmdEnvList(flags = {}) {
  const config = await readConfig();
  const environments = listEnvironments(config);

  if (flags.json) {
    const state = await readState();
    const rows = [];
    for (const env of environments) {
      const { source } = await resolveToken(env);
      const entry = environmentState(state, env.name);
      rows.push({
        name: env.name,
        region: env.region,
        proxyUrl: env.proxyUrl ?? null,
        gateway: env.gateway ?? null,
        description: env.description ?? null,
        active: config.active === env.name,
        tokenSource: source,
        hasToken: source !== BACKEND.NONE,
        modelCount: entry.profiles.length,
        syncedAt: entry.syncedAt,
      });
    }
    emitJson({ ok: true, active: config.active, environments: rows });
    return;
  }

  if (environments.length === 0) {
    process.stdout.write(
      "No environments defined.\n\n" +
        "  kong-ai-switch env add mine --region us --proxy-url http://localhost:8000\n",
    );
    return;
  }

  const state = await readState();
  const rows = [];
  for (const env of environments) {
    const { source } = await resolveToken(env);
    const entry = environmentState(state, env.name);
    rows.push({
      marker: config.active === env.name ? "*" : " ",
      name: env.name,
      region: env.region,
      proxy: env.proxyUrl ?? "(not set)",
      token: describeTokenSource(source),
      models: entry.profiles.length ? String(entry.profiles.length) : "not synced",
    });
  }

  const width = (key, header) => Math.max(...rows.map((r) => String(r[key]).length), header.length);
  const wName = width("name", "ENVIRONMENT");
  const wRegion = width("region", "REGION");
  const wProxy = width("proxy", "PROXY URL");
  const wToken = width("token", "TOKEN");

  process.stdout.write(
    `  ${"ENVIRONMENT".padEnd(wName)}  ${"REGION".padEnd(wRegion)}  ${"PROXY URL".padEnd(wProxy)}  ${"TOKEN".padEnd(wToken)}  MODELS\n`,
  );
  for (const r of rows) {
    process.stdout.write(
      `${r.marker} ${r.name.padEnd(wName)}  ${r.region.padEnd(wRegion)}  ${r.proxy.padEnd(wProxy)}  ${r.token.padEnd(wToken)}  ${r.models}\n`,
    );
  }
  process.stdout.write(`\n* is the active environment. Config: ${configPath()}\n`);
}

function describeTokenSource(source) {
  switch (source) {
    case "KONNECT_TOKEN":
      return "env var";
    case BACKEND.KEYCHAIN:
      return "keychain";
    case BACKEND.FILE:
      return "config file";
    default:
      return "missing";
  }
}

async function cmdEnvUse(positional) {
  const name = positional[0];
  if (!name) throw new UserError("Usage: kong-ai-switch env use <name>");

  const config = await readConfig();
  const next = setActive(config, name);
  await writeConfig(next);

  const env = next.environments[name];
  process.stdout.write(`Active environment is now "${name}".\n`);
  process.stdout.write(`  region     ${env.region}\n`);
  process.stdout.write(`  proxy URL  ${env.proxyUrl ?? "(not set)"}\n`);

  const state = await readState();
  const entry = environmentState(state, name);
  process.stdout.write(
    entry.profiles.length
      ? `\n${entry.profiles.length} model(s) cached. Run "kong-ai-switch list" to see them.\n`
      : '\nNo models cached yet. Run "kong-ai-switch sync".\n',
  );
}

async function cmdEnvShow(positional, flags) {
  const { config, env } = await activeEnvironment({ env: positional[0] ?? flags.env });
  const { source } = await resolveToken(env);
  const state = await readState();
  const entry = environmentState(state, env.name);

  process.stdout.write(`${env.name}${config.active === env.name ? "  (active)" : ""}\n`);
  if (env.description) process.stdout.write(`  ${env.description}\n`);
  process.stdout.write(`  region       ${env.region}\n`);
  process.stdout.write(`  proxy URL    ${env.proxyUrl ?? "(not set)"}\n`);
  if (env.gateway) process.stdout.write(`  gateway      ${env.gateway}\n`);
  process.stdout.write(`  token        ${describeTokenSource(source)}\n`);
  process.stdout.write(`  models       ${entry.profiles.length || "not synced"}\n`);
  if (entry.syncedAt) process.stdout.write(`  last synced  ${entry.syncedAt}\n`);
}

async function cmdEnvRemove(positional, flags) {
  const name = positional[0];
  if (!name) throw new UserError("Usage: kong-ai-switch env remove <name>");

  const config = await readConfig();
  if (!config.environments[name]) throw new UserError(`No environment named "${name}".`);

  const next = removeEnvironment(config, name);
  await writeConfig(next);
  await deleteToken(name);

  const state = await readState();
  await writeState(dropEnvironmentState(state, name));

  process.stdout.write(`Removed "${name}" and its cached models.\n`);
  if (next.active) process.stdout.write(`Active environment is now "${next.active}".\n`);
  else process.stdout.write("No environments remain.\n");

  // Say this plainly: we removed local config, not anything in Kong.
  process.stdout.write("\nThis changed local configuration only. Nothing in Konnect was modified.\n");
  void flags;
}

async function cmdEnvExport(positional, flags) {
  const name = positional[0];
  if (!name) throw new UserError("Usage: kong-ai-switch env export <name> [--out file]");

  const config = await readConfig();
  const env = config.environments[name];
  if (!env) throw new UserError(`No environment named "${name}".`);

  const body = JSON.stringify(toShareable(env), null, 2) + "\n";
  const out = typeof flags.out === "string" ? flags.out : null;

  if (out) {
    await writeFile(out, body, { encoding: "utf8", mode: 0o644 });
    process.stdout.write(`Wrote ${out}.\n`);
    process.stdout.write("No credentials are included; the recipient supplies their own token.\n");
  } else {
    process.stdout.write(body);
  }
}

async function cmdEnvImport(positional, flags) {
  const file = positional[0];
  if (!file) throw new UserError("Usage: kong-ai-switch env import <file> [--name <name>]");

  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (cause) {
    throw new UserError(`Could not read ${file}: ${cause.message}`);
  }

  const incoming = fromShareable(raw, { name: typeof flags.name === "string" ? flags.name : undefined });
  const config = await readConfig();
  if (config.environments[incoming.name] && !flags.force) {
    throw new UserError(
      `"${incoming.name}" already exists. Pass --name to import under a different name, or --force to replace.`,
    );
  }

  const token = typeof flags.token === "string" ? flags.token : null;
  let stored = { backend: BACKEND.NONE, inFile: false };
  if (token) stored = await persistToken(incoming.name, token);

  const next = putEnvironment(config, {
    ...incoming,
    token: token && stored.inFile ? token : null,
  });
  await writeConfig(next);

  process.stdout.write(`Imported environment "${incoming.name}".\n`);
  process.stdout.write(`  region     ${incoming.region}\n`);
  process.stdout.write(`  proxy URL  ${incoming.proxyUrl ?? "(not set)"}\n`);

  if (!token) {
    process.stdout.write(
      "\nNo token yet. Add yours before syncing:\n" +
        `  kong-ai-switch env set ${incoming.name} --token kpat_...\n`,
    );
  }
}

/**
 * Probe Konnect with nothing but a token and report what is there.
 *
 * This exists so a client can ask "what do I have?" before an environment
 * exists. It tries each region until one answers, and reports each gateway's
 * `proxy_urls` when the operator published them, so a UI can prefill the data
 * plane address instead of demanding it up front.
 *
 * AI Gateway data planes are self-managed, so `proxy_urls` is often absent.
 * That is reported honestly as needsProxyUrl rather than guessed at.
 */
async function cmdDiscover(flags) {
  const token = flags.token ?? process.env.KONNECT_TOKEN;
  if (!token) {
    throw new UserError(
      "A Konnect token is required.\n" +
        "Generate one at https://cloud.konghq.com/global/account/tokens, then pass --token.",
    );
  }

  // Search the region the caller named, else every region: an SE rarely
  // knows offhand which one a customer's org lives in.
  const regions = flags.region ? [flags.region] : Object.keys(KONNECT_REGIONS);
  const found = [];
  const errors = [];

  for (const region of regions) {
    try {
      const client = new KongAiGatewayClient({ token, region });
      const gateways = await client.listGateways();
      for (const gateway of gateways) {
        const origin = gatewayOrigin(gateway);
        let modelCount = null;
        try {
          modelCount = (await client.listModels(gateway.id)).length;
        } catch {
          // A gateway we cannot read is still worth reporting.
        }
        found.push({
          id: gateway.id,
          name: gateway.name,
          displayName: gateway.display_name ?? gateway.name,
          region,
          deploymentType: gateway.deployment_type ?? null,
          proxyUrl: origin,
          needsProxyUrl: origin === null,
          modelCount,
        });
      }
    } catch (cause) {
      // 401 in one region just means the token is not for that region.
      if (!/\b401\b/.test(cause.message)) errors.push({ region, error: cause.message });
    }
  }

  if (flags.json) {
    emitJson({ ok: true, gateways: found, errors });
    return;
  }

  if (found.length === 0) {
    throw new UserError(
      "No AI Gateways found for that token in any region.\n" +
        "Check the token is current, or create a gateway with:\n" +
        "  curl -Ls https://get.konghq.com/ai | bash -s -- -k $KONNECT_TOKEN",
    );
  }

  process.stdout.write(`Found ${found.length} AI Gateway(s).\n\n`);
  for (const g of found) {
    process.stdout.write(`  ${g.displayName}\n`);
    process.stdout.write(`    region     ${g.region}\n`);
    process.stdout.write(`    proxy URL  ${g.proxyUrl ?? "(not published; you must supply it)"}\n`);
    if (g.modelCount !== null) process.stdout.write(`    models     ${g.modelCount}\n`);
  }
}

async function cmdSync(flags) {
  const { env } = await activeEnvironment(flags);
  const { token, source } = await resolveToken(env);

  if (!token) {
    throw new UserError(
      `No Konnect token for environment "${env.name}".\n` +
        "Generate one at https://cloud.konghq.com/global/account/tokens then:\n" +
        `  kong-ai-switch env set ${env.name} --token kpat_...`,
    );
  }

  const client = new KongAiGatewayClient({ token, region: env.region });
  process.stderr.write(`Syncing "${env.name}" from ${client.baseUrl} (token: ${describeTokenSource(source)}) ...\n`);

  let gateways = await client.listGateways();
  const gatewayFilter = flags.gateway ?? env.gateway;
  if (gatewayFilter) {
    gateways = gateways.filter((g) => g.id === gatewayFilter || g.name === gatewayFilter);
    if (gateways.length === 0) {
      throw new UserError(`No AI Gateway matched "${gatewayFilter}" in region ${env.region}.`);
    }
  }

  if (gateways.length === 0) {
    throw new UserError(
      `No AI Gateways found in region "${env.region}".\n` +
        "If the gateway is in another region, update the environment:\n" +
        `  kong-ai-switch env set ${env.name} --region eu\n` +
        "Or create one with:\n" +
        "  curl -Ls https://get.konghq.com/ai | bash -s -- -k $KONNECT_TOKEN",
    );
  }

  const origin = flags["proxy-url"] ?? process.env.KONNECT_PROXY_URL ?? env.proxyUrl ?? undefined;
  const profiles = [];
  const skipped = [];
  const summaries = [];

  for (const gateway of gateways) {
    let models;
    try {
      models = await client.listModels(gateway.id);
    } catch (cause) {
      // One unreadable gateway should not sink the whole sync.
      summaries.push(`  ${gateway.display_name ?? gateway.name}: could not read models (${cause.message})`);
      continue;
    }
    const built = buildProfiles(models, gateway, { origin });
    profiles.push(...built.profiles);
    skipped.push(...built.skipped);
    summaries.push(
      `  ${gateway.display_name ?? gateway.name}: ${built.profiles.length} usable, ${built.skipped.length} skipped`,
    );
  }

  const state = await readState();
  await writeState(
    putEnvironmentState(state, env.name, {
      syncedAt: new Date().toISOString(),
      region: env.region,
      gateways: gateways.map((g) => ({
        id: g.id,
        name: g.name,
        displayName: g.display_name ?? g.name,
        deploymentType: g.deployment_type ?? null,
        proxyUrls: g.proxy_urls ?? [],
      })),
      profiles,
      current: environmentState(state, env.name).current,
    }),
  );

  if (flags.json) {
    emitJson({
      ok: true,
      environment: env.name,
      gatewayCount: gateways.length,
      modelCount: profiles.length,
      skipped: skipped.map((s) => ({ name: s.name, reason: s.reason })),
    });
    return;
  }

  process.stdout.write(`Synced ${profiles.length} model(s) from ${gateways.length} gateway(s).\n`);
  for (const line of summaries) process.stdout.write(line + "\n");

  if (skipped.length > 0) {
    process.stdout.write("\nSkipped:\n");
    for (const s of skipped) process.stdout.write(`  ${s.name} — ${s.reason}\n`);
  }

  if (profiles.length === 0) {
    process.stdout.write(
      '\nNo switchable models. A model needs the "generate" capability, and the gateway needs a reachable proxy URL.\n',
    );
  }
}

async function cmdList(flags) {
  const { env } = await activeEnvironment(flags);
  const state = await readState();
  const entry = environmentState(state, env.name);

  if (flags.json) {
    const active = await currentTarget();
    emitJson({
      ok: true,
      environment: env.name,
      syncedAt: entry.syncedAt,
      profiles: entry.profiles.map((p) => ({
        ...p,
        active: Boolean(active && active.baseUrl === p.baseUrl && active.model === p.clientModelId),
      })),
    });
    return;
  }

  if (entry.profiles.length === 0) {
    process.stdout.write(`No models cached for "${env.name}". Run "kong-ai-switch sync" first.\n`);
    return;
  }

  const active = await currentTarget();

  // Usability is per agent: an openai-format model is unusable from Claude
  // Code but is exactly what Codex needs, so filter by the agent in question.
  const targetAgent = typeof flags.agent === "string" ? flags.agent.split(",")[0].trim() : "claude-code";
  let agentFormats;
  let agentName;
  try {
    const agent = getAgent(targetAgent);
    agentFormats = agent.formats;
    agentName = agent.name;
  } catch (cause) {
    throw new UserError(cause.message);
  }

  const usable = entry.profiles.filter((p) => agentFormats.includes(p.format));
  const incompatible = entry.profiles.filter((p) => !agentFormats.includes(p.format));
  const shown = flags.all ? entry.profiles : usable;

  if (shown.length === 0) {
    process.stdout.write("No models Claude Code can use.\n");
    if (incompatible.length > 0) {
      process.stdout.write(`${incompatible.length} model(s) serve another format. Use --all to see them.\n`);
    }
    return;
  }

  const rows = shown.map((p) => {
    const isActive = active && active.baseUrl === p.baseUrl && active.model === p.clientModelId;
    const upstream = p.targets.map((t) => t.model).filter(Boolean).join(", ");
    return {
      marker: isActive ? "*" : " ",
      name: p.name,
      format: p.format,
      upstream: upstream || "—",
      gateway: p.gatewayName,
    };
  });

  const width = (key, header) => Math.max(...rows.map((r) => String(r[key]).length), header.length);
  const wName = width("name", "MODEL");
  const wFormat = width("format", "FORMAT");
  const wUpstream = width("upstream", "UPSTREAM");

  process.stdout.write(`Environment: ${env.name}   Agent: ${agentName}\n\n`);
  process.stdout.write(
    `  ${"MODEL".padEnd(wName)}  ${"FORMAT".padEnd(wFormat)}  ${"UPSTREAM".padEnd(wUpstream)}  GATEWAY\n`,
  );
  for (const r of rows) {
    process.stdout.write(
      `${r.marker} ${r.name.padEnd(wName)}  ${r.format.padEnd(wFormat)}  ${String(r.upstream).padEnd(wUpstream)}  ${r.gateway}\n`,
    );
  }

  if (flags.verbose) {
    process.stdout.write("\nEndpoints:\n");
    for (const p of shown) {
      process.stdout.write(`  ${p.name}: ${p.endpoint}${p.requiresAuth ? "  (auth required)" : ""}\n`);
    }
  }

  if (!flags.all && incompatible.length > 0) {
    process.stdout.write(
      `\n${incompatible.length} model(s) hidden: ${agentName} cannot call them. Use --all for details.\n`,
    );
  } else if (flags.all && incompatible.length > 0) {
    process.stdout.write(`\nNot usable from ${agentName}:\n`);
    for (const p of incompatible) {
      process.stdout.write(
        `  ${p.name} — serves the "${p.format}" format; ${agentName} speaks ${agentFormats.join("/")}.\n`,
      );
    }
  }

  if (entry.syncedAt) process.stdout.write(`\nLast synced ${entry.syncedAt}\n`);
}

async function cmdUse(positional, flags) {
  const { env } = await activeEnvironment(flags);
  const state = await readState();
  const entry = environmentState(state, env.name);

  if (entry.profiles.length === 0) {
    throw new UserError(`No models cached for "${env.name}". Run "kong-ai-switch sync" first.`);
  }

  const { profile, error } = resolveProfile(entry.profiles, positional[0]);
  if (error) throw new UserError(error);

  // Which coding agents to point at this model. Default to Claude Code so
  // existing behaviour is unchanged; --agent may be repeated or comma-listed.
  const requestedAgents = flags.agent
    ? String(flags.agent).split(",").map((a) => a.trim()).filter(Boolean)
    : ["claude-code"];

  // Check every requested agent against the model's format before writing
  // anything, so a two-agent switch cannot half-apply.
  for (const agentId of requestedAgents) {
    let agent;
    try {
      agent = getAgent(agentId);
    } catch (cause) {
      throw new UserError(cause.message);
    }
    if (!agent.formats.includes(profile.format)) {
      throw new UserError(
        `${agent.name} cannot call "${profile.name}": it serves the "${profile.format}" format, ` +
          `and ${agent.name} speaks ${agent.formats.join("/")}.\n` +
          `Switching would point ${agent.name} at an endpoint that returns 404.\n` +
          `To use this model from ${agent.name}, set the AI Model's formats[].type in Kong ` +
          `(Kong still translates to whatever upstream provider it targets).`,
      );
    }
  }

  const token = flags.token ?? process.env.KONG_AI_TOKEN;
  if (profile.requiresAuth && !token) {
    throw new UserError(
      `"${profile.name}" is behind an AI Auth Strategy, so it needs a credential.\n` +
        "Pass --token <value> or set KONG_AI_TOKEN.",
    );
  }

  const applied = [];
  for (const agentId of requestedAgents) {
    const agent = getAgent(agentId);
    // Claude Desktop shares Claude Code's file; writing twice is wasted work.
    if (agent.sharesConfigWith && requestedAgents.includes(agent.sharesConfigWith)) continue;
    try {
      applied.push(await applyToAgent(agentId, profile, { token }));
    } catch (cause) {
      throw new UserError(cause.message);
    }
  }

  const result = applied.find((a) => a.agent === "claude-code") ?? applied[0];
  await writeState(putEnvironmentState(state, env.name, { ...entry, current: profile.id }));

  if (flags.json) {
    emitJson({
      ok: true,
      environment: env.name,
      model: profile.name,
      displayName: profile.displayName,
      baseUrl: profile.baseUrl,
      clientModelId: profile.clientModelId,
      gateway: profile.gatewayName,
      settingsFile: result.file,
      created: result.created,
      agents: applied,
    });
    return;
  }

  const names = applied.map((a) => getAgent(a.agent).name).join(", ");
  process.stdout.write(`Switched ${names} to "${profile.displayName}".\n`);
  process.stdout.write(`  environment  ${env.name}\n`);
  process.stdout.write(`  gateway      ${profile.gatewayName}\n`);
  process.stdout.write(`  base URL     ${profile.baseUrl}\n`);
  process.stdout.write(`  model        ${profile.clientModelId}\n`);
  if (profile.targets.length > 0) {
    const upstream = profile.targets.map((t) => `${t.model} via ${t.provider}`).join(", ");
    process.stdout.write(`  upstream     ${upstream}\n`);
  }
  process.stdout.write("\n");
  for (const a of applied) {
    process.stdout.write(`Wrote ${a.file}${a.created ? " (created)" : ""}.\n`);
  }
  process.stdout.write(`Restart ${names} for the change to take effect.\n`);
}

/** List the coding agents this tool can configure, and where each points. */
async function cmdAgents(flags = {}) {
  const rows = [];
  for (const agent of listAgents()) {
    const status = await agentStatus(agent.id);
    rows.push({
      id: agent.id,
      name: agent.name,
      formats: agent.formats,
      file: status.file,
      configured: status.configured,
      model: status.model ?? null,
      baseUrl: status.baseUrl ?? null,
      sharesConfigWith: agent.sharesConfigWith ?? null,
    });
  }

  if (flags.json) {
    emitJson({ ok: true, agents: rows });
    return;
  }

  const width = (key, header) => Math.max(...rows.map((r) => String(r[key]).length), header.length);
  const wId = width("id", "AGENT");
  const wName = width("name", "NAME");

  process.stdout.write(`  ${"AGENT".padEnd(wId)}  ${"NAME".padEnd(wName)}  POINTED AT\n`);
  for (const r of rows) {
    const target = r.configured ? (r.model ?? "configured") : "not configured";
    process.stdout.write(`  ${r.id.padEnd(wId)}  ${r.name.padEnd(wName)}  ${target}\n`);
  }
  process.stdout.write('\nSwitch one or more with: kong-ai-switch use <model> --agent codex\n');
}

async function cmdStatus(flags = {}) {
  const active = await currentTarget();

  // Find which environment this came from, since settings.json does not say.
  let origin = null;
  if (active) {
    const state = await readState();
    for (const [envName, entry] of Object.entries(state.environments ?? {})) {
      const match = (entry.profiles ?? []).find(
        (p) => p.baseUrl === active.baseUrl && p.clientModelId === active.model,
      );
      if (match) {
        origin = { environment: envName, gateway: match.gatewayName, model: match.name };
        break;
      }
    }
  }

  if (flags.json) {
    emitJson({
      ok: true,
      configured: Boolean(active),
      settingsFile: claudeSettingsPath(),
      baseUrl: active?.baseUrl ?? null,
      model: active?.model ?? null,
      hasToken: active?.hasToken ?? false,
      environment: origin?.environment ?? null,
      gateway: origin?.gateway ?? null,
    });
    return;
  }

  if (!active) {
    process.stdout.write(`Claude Code is not pointed at a gateway.\n(${claudeSettingsPath()})\n`);
    return;
  }

  process.stdout.write(`base URL  ${active.baseUrl ?? "(unset)"}\n`);
  process.stdout.write(`model     ${active.model ?? "(unset)"}\n`);
  process.stdout.write(`token     ${active.hasToken ? "set" : "not set"}\n`);
  if (origin) {
    process.stdout.write(`gateway   ${origin.gateway}\n`);
    process.stdout.write(`from      environment "${origin.environment}"\n`);
  } else if (active.baseUrl) {
    process.stdout.write("gateway   not a known Kong model (run sync to refresh)\n");
  }
}

async function cmdEnv(positional, flags) {
  const [sub, ...rest] = positional;
  switch (sub) {
    case "add":
      return cmdEnvAdd(rest, flags);
    case "set":
      return cmdEnvSet(rest, flags);
    case "list":
    case undefined:
      return cmdEnvList(flags);
    case "use":
      return cmdEnvUse(rest);
    case "show":
      return cmdEnvShow(rest, flags);
    case "remove":
    case "rm":
      return cmdEnvRemove(rest, flags);
    case "export":
      return cmdEnvExport(rest, flags);
    case "import":
      return cmdEnvImport(rest, flags);
    default:
      throw new UserError(
        `Unknown "env" subcommand "${sub}". Try: add, set, list, use, show, remove, export, import.`,
      );
  }
}

async function main() {
  const { command, flags, positional } = parseArgs(process.argv.slice(2));

  if (!command || command === "help" || flags.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  try {
    switch (command) {
      case "env":
        await cmdEnv(positional, flags);
        return 0;
      case "discover":
        await cmdDiscover(flags);
        return 0;
      case "sync":
        await cmdSync(flags);
        return 0;
      case "list":
        await cmdList(flags);
        return 0;
      case "use":
        await cmdUse(positional, flags);
        return 0;
      case "agents":
        await cmdAgents(flags);
        return 0;
      case "status":
        await cmdStatus(flags);
        return 0;
      default:
        process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
        return 2;
    }
  } catch (cause) {
    if (cause instanceof UserError || cause instanceof KongApiError || cause instanceof ConfigError) {
      // Same envelope as success, so a caller parses one shape either way.
      if (flags.json) emitJson({ ok: false, error: cause.message });
      else process.stderr.write(`${cause.message}\n`);
      return 1;
    }
    throw cause;
  }
}

main().then(
  (code) => process.exit(code),
  (cause) => {
    process.stderr.write(`Unexpected error: ${cause?.stack ?? cause}\n`);
    process.exit(1);
  },
);
