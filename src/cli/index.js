#!/usr/bin/env node
/**
 * kong-ai-switch — point Claude Code at models served by Kong AI Gateway 2.0.
 *
 *   sync    pull the model catalogue from Konnect
 *   list    show what you can switch to
 *   use     switch Claude Code to a model
 *   status  show where the CLI currently points
 */

import process from "node:process";
import { KongAiGatewayClient, KongApiError, KONNECT_REGIONS } from "../kong/client.js";
import { buildProfiles } from "../kong/models.js";
import { readState, writeState, resolveProfile } from "../config/store.js";
import { switchTo, currentTarget, claudeSettingsPath } from "../config/claude.js";

const USAGE = `kong-ai-switch — switch Claude Code between Kong AI Gateway models

Usage:
  kong-ai-switch sync [--region <r>] [--gateway <id>] [--proxy-url <url>]
  kong-ai-switch list [--json] [--verbose] [--all]
  kong-ai-switch use <model> [--token <t>]
  kong-ai-switch status

Environment:
  KONNECT_TOKEN    Konnect personal access token (required for sync)
  KONNECT_REGION   us (default), eu, au, me, in, sg, or a full control plane URL
  KONNECT_PROXY_URL  data plane address, e.g. http://localhost:8000
  KONG_AI_TOKEN    credential sent to the gateway when a model requires auth

AI Gateway data planes are self-managed, so Konnect often does not know their
address. When a gateway publishes no proxy URL, supply one with --proxy-url.

Regions: ${Object.keys(KONNECT_REGIONS).join(", ")}
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

async function cmdSync(flags) {
  const token = process.env.KONNECT_TOKEN;
  if (!token) {
    throw new UserError(
      "KONNECT_TOKEN is not set.\n" +
        "Generate a token at https://cloud.konghq.com/global/account/tokens then:\n" +
        "  export KONNECT_TOKEN='kpat_...'",
    );
  }

  const region = flags.region ?? process.env.KONNECT_REGION ?? "us";
  const client = new KongAiGatewayClient({ token, region });

  process.stderr.write(`Syncing from ${client.baseUrl} ...\n`);
  let gateways = await client.listGateways();

  if (flags.gateway) {
    gateways = gateways.filter((g) => g.id === flags.gateway || g.name === flags.gateway);
    if (gateways.length === 0) {
      throw new UserError(`No AI Gateway matched "${flags.gateway}" in region ${region}.`);
    }
  }

  if (gateways.length === 0) {
    throw new UserError(
      `No AI Gateways found in region "${region}".\n` +
        "If your gateway is in another region, pass --region, or create one with:\n" +
        "  curl -Ls https://get.konghq.com/ai | bash -s -- -k $KONNECT_TOKEN",
    );
  }

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
    const origin = flags["proxy-url"] ?? process.env.KONNECT_PROXY_URL;
    const built = buildProfiles(models, gateway, { origin });
    profiles.push(...built.profiles);
    skipped.push(...built.skipped.map((s) => ({ ...s, gateway: gateway.display_name ?? gateway.name })));
    summaries.push(
      `  ${gateway.display_name ?? gateway.name}: ${built.profiles.length} usable, ${built.skipped.length} skipped`,
    );
  }

  const state = await readState();
  await writeState({
    ...state,
    syncedAt: new Date().toISOString(),
    region,
    gateways: gateways.map((g) => ({
      id: g.id,
      name: g.name,
      displayName: g.display_name ?? g.name,
      deploymentType: g.deployment_type ?? null,
      proxyUrls: g.proxy_urls ?? [],
    })),
    profiles,
  });

  process.stdout.write(`Synced ${profiles.length} model(s) from ${gateways.length} gateway(s).\n`);
  for (const line of summaries) process.stdout.write(line + "\n");

  if (skipped.length > 0) {
    process.stdout.write("\nSkipped:\n");
    for (const s of skipped) process.stdout.write(`  ${s.name} — ${s.reason}\n`);
  }

  if (profiles.length === 0) {
    process.stdout.write(
      "\nNo switchable models. A model needs the \"generate\" capability and an enabled gateway with a proxy URL.\n",
    );
  }
}

async function cmdList(flags) {
  const state = await readState();
  if (flags.json) {
    process.stdout.write(JSON.stringify(state.profiles, null, 2) + "\n");
    return;
  }

  if (state.profiles.length === 0) {
    process.stdout.write('No models cached. Run "kong-ai-switch sync" first.\n');
    return;
  }

  const active = await currentTarget();
  const usable = state.profiles.filter((p) => p.claudeCode?.ok !== false);
  const incompatible = state.profiles.filter((p) => p.claudeCode?.ok === false);
  const shown = flags.all ? state.profiles : usable;

  if (shown.length === 0) {
    process.stdout.write("No models Claude Code can use.\n");
    if (incompatible.length > 0) {
      process.stdout.write(`${incompatible.length} model(s) exist but serve another format. Use --all to see them.\n`);
    }
    return;
  }

  const rows = shown.map((p) => {
    const isActive =
      active && active.baseUrl === p.baseUrl && active.model === p.clientModelId;
    const upstream = p.targets.map((t) => t.model).filter(Boolean).join(", ");
    return {
      marker: isActive ? "*" : " ",
      name: p.name,
      format: p.format,
      upstream: upstream || "—",
      gateway: p.gatewayName,
    };
  });

  const width = (key) => Math.max(...rows.map((r) => String(r[key]).length), key.length);
  const wName = width("name");
  const wFormat = width("format");
  const wUpstream = width("upstream");

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
      `\n${incompatible.length} model(s) hidden: Claude Code cannot call them. Use --all for details.\n`,
    );
  } else if (flags.all && incompatible.length > 0) {
    process.stdout.write("\nNot usable from Claude Code:\n");
    for (const p of incompatible) {
      process.stdout.write(`  ${p.name} — ${p.claudeCode.reason}\n`);
    }
  }

  if (state.syncedAt) process.stdout.write(`\nLast synced ${state.syncedAt}\n`);
}

async function cmdUse(positional, flags) {
  const state = await readState();
  if (state.profiles.length === 0) {
    throw new UserError('No models cached. Run "kong-ai-switch sync" first.');
  }

  const { profile, error } = resolveProfile(state.profiles, positional[0]);
  if (error) throw new UserError(error);

  if (profile.claudeCode?.ok === false) {
    throw new UserError(
      `Claude Code cannot call "${profile.name}": it ${profile.claudeCode.reason}\n` +
        "Switching would point Claude Code at an endpoint that returns 404.",
    );
  }

  const token = flags.token ?? process.env.KONG_AI_TOKEN;
  if (profile.requiresAuth && !token) {
    throw new UserError(
      `"${profile.name}" is behind an AI Auth Strategy, so it needs a credential.\n` +
        "Pass --token <value> or set KONG_AI_TOKEN.",
    );
  }

  const result = await switchTo(profile, { token });
  await writeState({ ...state, current: profile.id });

  process.stdout.write(`Switched Claude Code to "${profile.displayName}".\n`);
  process.stdout.write(`  gateway   ${profile.gatewayName}\n`);
  process.stdout.write(`  base URL  ${profile.baseUrl}\n`);
  process.stdout.write(`  model     ${profile.clientModelId}\n`);
  if (profile.targets.length > 0) {
    const upstream = profile.targets.map((t) => `${t.model} via ${t.provider}`).join(", ");
    process.stdout.write(`  upstream  ${upstream}\n`);
  }
  process.stdout.write(`\nWrote ${result.file}${result.created ? " (created)" : ""}.\n`);
  process.stdout.write("Restart Claude Code for the change to take effect.\n");
}

async function cmdStatus() {
  const active = await currentTarget();
  if (!active) {
    process.stdout.write(`Claude Code is not pointed at a gateway.\n(${claudeSettingsPath()})\n`);
    return;
  }

  const state = await readState();
  const match = state.profiles.find(
    (p) => p.baseUrl === active.baseUrl && p.clientModelId === active.model,
  );

  process.stdout.write(`base URL  ${active.baseUrl ?? "(unset)"}\n`);
  process.stdout.write(`model     ${active.model ?? "(unset)"}\n`);
  process.stdout.write(`token     ${active.hasToken ? "set" : "not set"}\n`);
  if (match) {
    process.stdout.write(`gateway   ${match.gatewayName}\n`);
  } else if (active.baseUrl) {
    process.stdout.write("gateway   not a known Kong model (run sync to refresh)\n");
  }
}

class UserError extends Error {}

async function main() {
  const { command, flags, positional } = parseArgs(process.argv.slice(2));

  if (!command || command === "help" || flags.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  try {
    switch (command) {
      case "sync":
        await cmdSync(flags);
        return 0;
      case "list":
        await cmdList(flags);
        return 0;
      case "use":
        await cmdUse(positional, flags);
        return 0;
      case "status":
        await cmdStatus();
        return 0;
      default:
        process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
        return 2;
    }
  } catch (cause) {
    if (cause instanceof UserError || cause instanceof KongApiError) {
      process.stderr.write(`${cause.message}\n`);
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
