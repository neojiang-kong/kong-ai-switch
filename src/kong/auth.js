/**
 * AI Auth Strategies, and how a client satisfies them.
 *
 * Kong offers two inbound strategies, and they are not interchangeable from a
 * desktop tool's point of view:
 *
 *   key-auth        a long-lived key in a named header (default `apikey`).
 *                   Safe to store and write into a config file.
 *
 *   openid-connect  a bearer token from an identity provider, typically
 *                   minutes to an hour old. Storing one would write a value
 *                   that expires mid-session, so the client supplies it at
 *                   switch time and is told plainly that it expires.
 *
 * A model may reference several strategies and passes if it satisfies ANY of
 * them, so a model offering both lets the user choose the easier one.
 */

export const AUTH_KIND = {
  NONE: "none",
  KEY_AUTH: "key-auth",
  OIDC: "openid-connect",
};

/** Header a key-auth strategy expects, honouring config.key_names. */
export function keyAuthHeader(strategy) {
  const names = strategy?.config?.key_names;
  const first = Array.isArray(names) ? names.find((n) => typeof n === "string" && n) : null;
  return first ?? "apikey";
}

/**
 * Describe one strategy in the terms a client needs.
 * Unknown types are reported rather than guessed at.
 */
export function describeStrategy(strategy) {
  const type = String(strategy?.type ?? "").toLowerCase();
  const base = {
    name: strategy?.name ?? null,
    displayName: strategy?.display_name ?? strategy?.name ?? null,
    type,
  };

  if (type === AUTH_KIND.KEY_AUTH) {
    return {
      ...base,
      kind: AUTH_KIND.KEY_AUTH,
      header: keyAuthHeader(strategy),
      /** A key is long-lived, so it is worth storing. */
      storable: true,
      hint: `Send your key in the "${keyAuthHeader(strategy)}" header.`,
    };
  }

  if (type === AUTH_KIND.OIDC) {
    const issuer = strategy?.config?.issuer ?? null;
    const methods = Array.isArray(strategy?.config?.auth_methods)
      ? strategy.config.auth_methods
      : [];
    return {
      ...base,
      kind: AUTH_KIND.OIDC,
      issuer,
      authMethods: methods,
      header: "Authorization",
      // Access tokens expire; storing one would break mid-session.
      storable: false,
      hint: issuer
        ? `Bearer token from ${issuer}. It expires, so supply a fresh one.`
        : "Bearer token from your identity provider. It expires.",
    };
  }

  return { ...base, kind: type || "unknown", storable: false, hint: null };
}

/**
 * Summarise how a client can authenticate to a model.
 *
 * `preferred` is the strategy a desktop tool should offer first: key-auth
 * when available, because it is the one this tool can actually hold on the
 * user's behalf.
 */
export function describeModelAuth(model, strategiesByName = new Map()) {
  const names = model?.access?.auth_strategies;
  const referenced = Array.isArray(names) ? names.filter(Boolean) : [];

  if (referenced.length === 0) {
    return { required: false, kind: AUTH_KIND.NONE, strategies: [], preferred: null };
  }

  const strategies = referenced.map((name) => {
    const found = strategiesByName.get(name);
    // A referenced strategy we could not read is still worth naming.
    return found
      ? describeStrategy(found)
      : { name, displayName: name, type: null, kind: "unknown", storable: false, hint: null };
  });

  const preferred =
    strategies.find((s) => s.kind === AUTH_KIND.KEY_AUTH) ?? strategies[0] ?? null;

  return {
    required: true,
    kind: preferred?.kind ?? "unknown",
    strategies,
    preferred,
    /** True when the user has a choice, e.g. api-key or OIDC. */
    hasChoice: strategies.length > 1,
  };
}

/**
 * The header a credential must travel in for a given model.
 * Returns null when the model needs no credential.
 */
export function credentialHeader(auth) {
  if (!auth?.required) return null;
  return auth.preferred?.header ?? "Authorization";
}

/**
 * Pick one auth strategy when the user (or CLI flag) chooses explicitly.
 * Dual-strategy models default to key-auth; this honours a deliberate OIDC
 * choice so the credential lands in the right header.
 */
export function authWithKind(auth, kind) {
  if (!auth || !kind) return auth;
  const chosen = auth.strategies?.find((s) => s.kind === kind);
  if (!chosen) return auth;
  return { ...auth, preferred: chosen, kind: chosen.kind };
}
