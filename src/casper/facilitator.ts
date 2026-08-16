import { CASPER_MAINNET_CAIP2, CASPER_NETWORKS, isCasperNetwork } from "./networks.js";

/**
 * Minimal HTTP client for an x402 Casper facilitator.
 *
 * The hosted facilitator lives at https://x402-facilitator.cspr.cloud and
 * exposes /verify, /settle and /supported. Point CASPER_FACILITATOR_URL at a
 * self-hosted deployment to override it.
 */

export const DEFAULT_CASPER_FACILITATOR_URL = "https://x402-facilitator.cspr.cloud";

export interface CasperSupportedKind {
  x402Version?: number;
  scheme: string;
  network: string;
  extra?: Record<string, unknown>;
}

export interface CasperVerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface CasperSettleResponse {
  success: boolean;
  errorReason?: string;
  transaction?: string;
  network?: string;
  payer?: string;
}

export interface CasperFacilitatorOptions {
  /** Base URL of the facilitator. Defaults to CASPER_FACILITATOR_URL or the hosted one. */
  url?: string;
  /** Optional API key sent as the Authorization header (cspr.cloud requires one). */
  apiKey?: string;
  /** Request timeout in milliseconds (default: 15000). */
  timeoutMs?: number;
  /** Injectable fetch — used by the tests. */
  fetchImpl?: typeof fetch;
}

export function getCasperFacilitatorUrl(): string {
  const url = process.env.CASPER_FACILITATOR_URL || DEFAULT_CASPER_FACILITATOR_URL;
  return url.replace(/\/$/, "");
}

export class CasperFacilitatorClient {
  private readonly url: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CasperFacilitatorOptions = {}) {
    this.url = (options.url || getCasperFacilitatorUrl()).replace(/\/$/, "");
    this.apiKey = options.apiKey ?? process.env.CASPER_FACILITATOR_API_KEY;
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get baseUrl(): string {
    return this.url;
  }

  /** GET /supported — the scheme/network pairs this facilitator settles. */
  async supported(): Promise<CasperSupportedKind[]> {
    const body = await this.request<any>("/supported", "GET");
    const kinds = body?.kinds || body?.supported || body;
    return Array.isArray(kinds) ? kinds : [];
  }

  /** POST /verify — check a payment payload against the requirements. */
  async verify(paymentPayload: unknown, paymentRequirements: unknown): Promise<CasperVerifyResponse> {
    return this.request<CasperVerifyResponse>("/verify", "POST", { paymentPayload, paymentRequirements });
  }

  /** POST /settle — broadcast the wCSPR transfer on Casper. */
  async settle(paymentPayload: unknown, paymentRequirements: unknown): Promise<CasperSettleResponse> {
    return this.request<CasperSettleResponse>("/settle", "POST", { paymentPayload, paymentRequirements });
  }

  /**
   * True when the facilitator advertises support for the given Casper network.
   * Falls back to the built-in network list when /supported is unreachable so a
   * facilitator outage never blocks a payment the client can still construct.
   */
  async supportsNetwork(network: string): Promise<boolean> {
    if (!isCasperNetwork(network)) return false;
    try {
      const kinds = await this.supported();
      if (kinds.length === 0) return CASPER_NETWORKS.includes(network as any);
      return kinds.some((k) => k.network === network && (!k.scheme || k.scheme === "exact"));
    } catch {
      return CASPER_NETWORKS.includes(network as any);
    }
  }

  private async request<T>(path: string, method: "GET" | "POST", body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.apiKey) headers["Authorization"] = this.apiKey;

    try {
      const resp = await this.fetchImpl(`${this.url}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await resp.text();
      let parsed: any;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = { raw: text };
      }

      if (!resp.ok) {
        const reason = parsed?.error || parsed?.message || parsed?.raw || resp.statusText;
        throw new Error(`Casper facilitator ${path} failed (${resp.status}): ${reason}`);
      }

      return parsed as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Default facilitator kinds, used when no facilitator is reachable. */
export function defaultCasperKinds(): CasperSupportedKind[] {
  return CASPER_NETWORKS.map((network) => ({
    x402Version: 2,
    scheme: "exact",
    network,
    extra: { asset: "wCSPR", decimals: 9 },
  }));
}

export const CASPER_DEFAULT_NETWORK = CASPER_MAINNET_CAIP2;
