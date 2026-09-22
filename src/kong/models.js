import { describeModelAuth } from "./auth.js";

/**
 * Translate Kong AI Gateway entities into switchable profiles.
 *
 * The central fact this module encodes: the identifier a CLI must send as its
 * model is the AI Model entity's `name`, not the upstream vendor model id.
 * Kong resolves the alias to `targets[].name` internally, so a client that
 * sends "claude-opus-4-8" to a gateway expecting "my-claude" gets a 404.
 */

/** Capability that means "text generation", the only one a coding CLI needs. */
const GENERATE = "generate";

/**
 * Client-facing endpoint suffix per format, for the `generate` capability.
 * Anthropic-format models expose Anthropic's native Messages API; everything
 * else is normalized to the OpenAI shape.
 *
 * This is the path AI Gateway *serves*. It is not what we put in
 * ANTHROPIC_BASE_URL: Claude Code appends `/v1/messages` to the base URL
 * itself, so the base URL must stop at the model's route path. The endpoint
 * computed here is for display and diagnostics.
 */
const GENERATE_PATH = {
  anthropic: "/v1/messages",
  openai: "/chat/completions",
  bedrock: "/chat/completions",
  cohere: "/chat/completions",
  gemini: "/chat/completions",
  huggingface: "/chat/completions",
};

/**
 * Build the data plane origin for a gateway.
 *
 * AI Gateway runs hybrid: the control plane is Konnect-managed but data plane
 * nodes are self-managed, running in the customer's own infrastructure behind
 * their own DNS and load balancers. Konnect therefore cannot always know the
 * client-facing URL.
 *
 * `proxy_urls` is a documented but OPTIONAL field ("Proxy URL associated with
 * reaching the data-planes connected to a control-plane"). When an operator
 * has declared it, it is authoritative. When absent, the caller must supply
 * the origin — there is nothing to discover.
 *
 * @param {object} gateway
 * @param {string} [override] A user-supplied origin, which wins when set.
 */
export function gatewayOrigin(gateway, override) {
  if (override) return String(override).trim().replace(/\/+$/, "");

  const candidates = Array.isArray(gateway?.proxy_urls) ? gateway.proxy_urls : [];
  if (candidates.length === 0) return null;

  const preferred =
    candidates.find((u) => String(u?.protocol).toLowerCase() === "https") ?? candidates[0];
  const protocol = String(preferred?.protocol ?? "https").toLowerCase();
  const host = preferred?.host;
  if (!host) return null;

  const port = Number(preferred?.port);
  const isDefaultPort =
    (protocol === "https" && port === 443) || (protocol === "http" && port === 80);
  return Number.isFinite(port) && !isDefaultPort
    ? `${protocol}://${host}:${port}`
    : `${protocol}://${host}`;
}

/** The base path a model is mounted on, from config.route.paths[0]. */
export function modelRoutePath(model) {
  const paths = model?.config?.route?.paths;
  const first = Array.isArray(paths) ? paths.find((p) => typeof p === "string" && p) : null;
  if (!first) return "";
  const trimmed = first.replace(/\/+$/, "");
  return trimmed === "" ? "" : trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function modelFormat(model) {
  const formats = Array.isArray(model?.formats) ? model.formats : [];
  const type = formats[0]?.type;
  return typeof type === "string" && type ? type.toLowerCase() : "openai";
}

/**
 * The identifier a client sends as its model.
 *
 * When config.route.model declares an alias, that alias is authoritative.
 * Otherwise Kong derives the selector from the AI Model's own name.
 */
export function clientModelId(model) {
  const rule = model?.config?.route?.model;
  const values = Array.isArray(rule?.values) ? rule.values.filter((v) => typeof v === "string" && v) : [];
  return values[0] ?? model?.name ?? null;
}

/** Where the alias must travel: request body, header, or path. */
export function modelSelector(model) {
  const rule = model?.config?.route?.model ?? {};
  if (rule.body_param) return { kind: "body", param: rule.body_param };
  if (rule.header_param) return { kind: "header", param: rule.header_param };
  if (rule.path_param) return { kind: "path", param: rule.path_param };
  return { kind: "body", param: "model" };
}

function capabilities(model) {
  return Array.isArray(model?.capabilities) ? model.capabilities : [];
}

/** Upstream vendor models behind a virtual AI Model, for display only. */
export function upstreamTargets(model) {
  const targets = Array.isArray(model?.targets) ? model.targets : [];
  return targets.map((t) => ({
    model: t?.name ?? null,
    provider: t?.provider ?? null,
    weight: Number.isFinite(Number(t?.weight)) ? Number(t.weight) : null,
  }));
}

/**
 * Whether Claude Code can actually reach this model.
 *
 * Claude Code sends Anthropic Messages requests to `${ANTHROPIC_BASE_URL}/v1/messages`.
 * That lands only if the model speaks the anthropic format. An openai-format
 * model is reachable by an OpenAI-compatible client but not by Claude Code,
 * so flag it rather than offering a switch that 404s.
 *
 * Note the upstream provider need not be Anthropic: Kong translates, so a
 * model with `formats[].type: anthropic` over an OpenAI target works fine.
 */
export function claudeCodeCompatibility(model) {
  const format = modelFormat(model);
  if (format !== "anthropic") {
    return {
      ok: false,
      reason:
        `serves the "${format}" format; Claude Code speaks the Anthropic Messages API. ` +
        `Set formats[].type to "anthropic" on this AI Model (Kong still translates to the upstream provider).`,
    };
  }
  return { ok: true, reason: null };
}

/**
 * Convert one AI Model into a switch profile.
 *
 * Returns null when the model cannot serve a coding CLI, with `skipped`
 * describing why, so the caller can explain the omission rather than
 * silently dropping it.
 *
 * @param {object} model
 * @param {object} gateway
 * @param {object} [options]
 * @param {string} [options.origin] Data plane origin when Konnect has none.
 */
export function toProfile(model, gateway, options = {}) {
  const strategiesByName = options.strategiesByName ?? new Map();
  const name = model?.name;
  if (!name) return { profile: null, skipped: { name: "(unnamed)", reason: "model has no name" } };

  if (model?.enabled === false) {
    return { profile: null, skipped: { name, reason: "disabled in Kong" } };
  }

  if (model?.type === "api") {
    return { profile: null, skipped: { name, reason: "batch/files API model, not a chat model" } };
  }

  const caps = capabilities(model);
  if (!caps.includes(GENERATE)) {
    const listed = caps.length ? caps.join(", ") : "none";
    return { profile: null, skipped: { name, reason: `no "generate" capability (has: ${listed})` } };
  }

  const origin = gatewayOrigin(gateway, options.origin);
  if (!origin) {
    return {
      profile: null,
      skipped: {
        name,
        reason:
          "no data plane URL. AI Gateway data planes are self-managed, so Konnect may not know " +
          "the proxy address. Pass --proxy-url, or set proxy_urls on the gateway in Konnect.",
      },
    };
  }

  const format = modelFormat(model);
  const routePath = modelRoutePath(model);
  const claudeCode = claudeCodeCompatibility(model);

  return {
    profile: {
      id: `${gateway.id}:${name}`,
      name,
      displayName: model.display_name || name,
      gatewayId: gateway.id,
      gatewayName: gateway.display_name || gateway.name || gateway.id,
      format,
      // Base URL a CLI points at. The CLI appends the endpoint suffix itself.
      baseUrl: origin + routePath,
      endpoint: origin + routePath + (GENERATE_PATH[format] ?? GENERATE_PATH.openai),
      clientModelId: clientModelId(model),
      selector: modelSelector(model),
      capabilities: caps,
      targets: upstreamTargets(model),
      policies: Array.isArray(model?.policies) ? model.policies : [],
      labels: model?.labels ?? {},
      requiresAuth: modelRequiresAuth(model),
      /** How a client authenticates: key-auth, OIDC, or nothing. */
      auth: describeModelAuth(model, strategiesByName),
      claudeCode,
    },
    skipped: null,
  };
}

/** Whether the model sits behind an AI Auth Strategy the client must satisfy. */
export function modelRequiresAuth(model) {
  const strategies = model?.access?.auth_strategies;
  return Array.isArray(strategies) && strategies.length > 0;
}

/**
 * Build the full profile list for a gateway.
 * @returns {{profiles: object[], skipped: {name: string, reason: string}[]}}
 */
export function buildProfiles(models, gateway, options = {}) {
  const profiles = [];
  const skipped = [];
  for (const model of models ?? []) {
    const result = toProfile(model, gateway, options);
    if (result.profile) profiles.push(result.profile);
    else if (result.skipped) skipped.push(result.skipped);
  }
  profiles.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return { profiles, skipped };
}
