/**
 * Kong AI Gateway 2.0 — Konnect control plane client.
 *
 * Model discovery rests on exactly two endpoints:
 *
 *   GET /v1/ai-gateways
 *       -> each gateway carries proxy_urls[] {host, port, protocol},
 *          which is the data plane origin a CLI sends LLM traffic to.
 *
 *   GET /v1/ai-gateways/{gatewayId}/models
 *       -> the AI Model entities. An AI Model's `name` is what a client
 *          passes as the model identifier; the upstream vendor model id
 *          lives in targets[].name and is never seen by the client.
 *
 * Spec: Konnect AI Gateway API, OAS 3.0, version 2.0.3.
 */

export const KONNECT_REGIONS = {
  us: "https://us.api.konghq.com/v1",
  eu: "https://eu.api.konghq.com/v1",
  au: "https://au.api.konghq.com/v1",
  me: "https://me.api.konghq.com/v1",
  in: "https://in.api.konghq.com/v1",
  sg: "https://sg.api.konghq.com/v1",
};

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_PAGE_SIZE = 100;
/** Hard stop on pagination so a malformed cursor cannot spin forever. */
const MAX_PAGES = 100;

export class KongApiError extends Error {
  constructor(message, { status, url, body } = {}) {
    super(message);
    this.name = "KongApiError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/**
 * Resolve a region key or an explicit base URL into a control plane base URL.
 * Accepting a full URL keeps self-managed and non-public deployments usable.
 */
export function resolveBaseUrl(regionOrUrl) {
  if (!regionOrUrl) return KONNECT_REGIONS.us;
  const value = String(regionOrUrl).trim();
  if (/^https?:\/\//i.test(value)) return value.replace(/\/+$/, "");
  const region = KONNECT_REGIONS[value.toLowerCase()];
  if (!region) {
    throw new KongApiError(
      `Unknown Konnect region "${value}". Known regions: ${Object.keys(KONNECT_REGIONS).join(", ")}. ` +
        `You can also pass a full control plane URL.`,
    );
  }
  return region;
}

export class KongAiGatewayClient {
  /**
   * @param {object} options
   * @param {string} options.token   Konnect personal access token (kpat_...).
   * @param {string} [options.region] Region key or full control plane URL.
   * @param {number} [options.timeoutMs]
   * @param {typeof fetch} [options.fetch] Injectable for tests.
   */
  constructor({ token, region, timeoutMs = DEFAULT_TIMEOUT_MS, fetch: fetchImpl } = {}) {
    if (!token || !String(token).trim()) {
      throw new KongApiError(
        "A Konnect personal access token is required. Generate one at " +
          "https://cloud.konghq.com/global/account/tokens and set KONNECT_TOKEN.",
      );
    }
    this.token = String(token).trim();
    this.baseUrl = resolveBaseUrl(region);
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl ?? globalThis.fetch;
  }

  async request(path, { searchParams } = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(searchParams ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json, application/problem+json",
        },
        signal: controller.signal,
      });
    } catch (cause) {
      if (cause?.name === "AbortError") {
        throw new KongApiError(`Request to ${url.pathname} timed out after ${this.timeoutMs}ms.`, {
          url: url.toString(),
        });
      }
      throw new KongApiError(`Could not reach Konnect at ${url.origin}: ${cause?.message ?? cause}`, {
        url: url.toString(),
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) throw await describeFailure(response, url);
    return response.json();
  }

  /**
   * Walk a paginated collection. The AI Gateway API uses page[number] for
   * gateways and an opaque page[after] cursor for models, so support both.
   */
  async paginate(path, { cursor = false } = {}) {
    const items = [];
    let pageNumber = 1;
    let after;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const searchParams = { "page[size]": DEFAULT_PAGE_SIZE };
      if (cursor) {
        if (after) searchParams["page[after]"] = after;
      } else {
        searchParams["page[number]"] = pageNumber;
      }

      const body = await this.request(path, { searchParams });
      const data = Array.isArray(body?.data) ? body.data : [];
      items.push(...data);

      if (cursor) {
        after = body?.meta?.page?.next ?? body?.meta?.page?.after ?? body?.meta?.next;
        // Treat a repeated or absent cursor as the end of the collection.
        if (!after || data.length === 0) break;
      } else {
        const meta = body?.meta?.page ?? {};
        const total = Number(meta.total ?? items.length);
        if (data.length === 0 || items.length >= total) break;
        pageNumber += 1;
      }
    }

    return items;
  }

  /** List every AI Gateway in the organization. */
  async listGateways() {
    return this.paginate("/ai-gateways");
  }

  async getGateway(gatewayId) {
    return this.request(`/ai-gateways/${encodeURIComponent(gatewayId)}`);
  }

  /** List the AI Models registered on a gateway. */
  async listModels(gatewayId) {
    return this.paginate(`/ai-gateways/${encodeURIComponent(gatewayId)}/models`, { cursor: true });
  }

  /**
   * List AI Auth Strategies, so a client knows how to authenticate.
   * A model references these by name in access.auth_strategies.
   */
  async listAuthStrategies(gatewayId) {
    return this.paginate(`/ai-gateways/${encodeURIComponent(gatewayId)}/auth-strategies`, {
      cursor: true,
    });
  }

  /** List AI Model Providers, used to show which vendor backs each model. */
  async listModelProviders(gatewayId) {
    return this.paginate(`/ai-gateways/${encodeURIComponent(gatewayId)}/model-providers`, {
      cursor: true,
    });
  }
}

/**
 * Resolve the Konnect organization that issued a personal access token.
 *
 * Identity lives on the global API (`/v3/organizations/me`), not the regional
 * AI Gateway control plane. Used to label environments by org name rather than
 * by whichever gateway happened to be picked during setup.
 */
export async function fetchOrganization(token, { timeoutMs = DEFAULT_TIMEOUT_MS, fetch: fetchImpl } = {}) {
  if (!token || !String(token).trim()) return null;
  const fetchFn = fetchImpl ?? globalThis.fetch;
  const url = "https://global.api.konghq.com/v3/organizations/me";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${String(token).trim()}`,
        Accept: "application/json, application/problem+json",
      },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = await response.json();
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) return null;
    return { id: body.id ?? null, name };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Turn an org or gateway display name into a safe environment id. */
export function slugifyEnvironmentName(value) {
  const cleaned = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return cleaned || "default";
}

/**
 * Turn an HTTP failure into a message that says what to do about it.
 * Konnect returns RFC 7807 problem documents, so prefer their detail text.
 */
async function describeFailure(response, url) {
  let body;
  try {
    body = await response.text();
  } catch {
    body = "";
  }

  let detail = "";
  try {
    const parsed = JSON.parse(body);
    detail = parsed?.detail || parsed?.title || parsed?.message || "";
  } catch {
    detail = body.slice(0, 300);
  }

  const hints = {
    401: "The Konnect token was rejected. Check KONNECT_TOKEN is a current kpat_... value.",
    403: "The token is valid but lacks access to this AI Gateway. Check its roles in Konnect.",
    404: "Not found. Check the gateway id, and that the token is for the right region.",
    429: "Konnect rate limited this request. Retry shortly.",
  };
  const hint = hints[response.status] ?? "";
  const parts = [`Konnect returned ${response.status} for ${url.pathname}.`, detail, hint].filter(Boolean);

  return new KongApiError(parts.join(" "), {
    status: response.status,
    url: url.toString(),
    body,
  });
}
