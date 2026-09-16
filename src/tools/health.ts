import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadDirectory } from "../directory.js";

export function registerHealthCheckTool(server: McpServer): void {
  server.tool(
    "x402_health",
    "Check if an x402 service is live and responding with 402 Payment Required. Verifies the service is operational before an agent pays for it.",
    {
      name: z.string().optional().describe("Service name from directory (e.g. 'svm402')"),
      url: z.string().optional().describe("Direct URL to probe (alternative to name)"),
    },
    async (args) => {
      let targetUrl: string;
      let serviceName: string;

      if (args.url) {
        targetUrl = args.url;
        serviceName = args.url;
      } else if (args.name) {
        const dir = loadDirectory();
        const entry = dir.endpoints.find(
          (e) => e.name.toLowerCase() === args.name!.toLowerCase()
        );
        if (!entry) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ error: `Service '${args.name}' not found in directory` }),
            }],
          };
        }
        targetUrl = entry.base_url;
        serviceName = entry.name;
      } else {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: "Provide either 'name' or 'url'" }),
          }],
        };
      }

      try {
        const startedAt = Date.now();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const resp = await fetch(targetUrl, { signal: controller.signal });
        clearTimeout(timeout);

        let x402Enabled = resp.status === 402;
        let probeUrl = targetUrl;
        let note = x402Enabled ? "root returned 402 Payment Required" : "";

        // Bounded fallback (no paying, no spend): PAYMENT-REQUIRED header or
        // /.well-known/x402 with payment fields (v1 flat fields or v2 accepts[]).
        if (!x402Enabled && resp.headers.get("payment-required")) {
          x402Enabled = true;
          note = "root returned PAYMENT-REQUIRED response header";
        } else if (!x402Enabled) {
          try {
            const wellKnownUrl = new URL("/.well-known/x402", targetUrl).toString();
            const wkController = new AbortController();
            const wkTimeout = setTimeout(() => wkController.abort(), 10000);
            const wkResp = await fetch(wellKnownUrl, { signal: wkController.signal });
            clearTimeout(wkTimeout);
            if (wkResp.ok) {
              const body: any = await wkResp.json().catch(() => null);
              const v1Fields = body && (body.x402_version !== undefined || body.payment_scheme || body.seller_wallet || (Array.isArray(body.endpoints) && body.endpoints.length > 0));
              const v2Accepts = body && Array.isArray(body.accepts) && body.accepts.length > 0;
              if (v1Fields || v2Accepts) {
                x402Enabled = true;
                probeUrl = wellKnownUrl;
                note = "/.well-known/x402 advertised payment fields";
              }
            }
          } catch {
            // well-known probe failed; verdict stands from root probe
          }
        }

        const result = {
          service: serviceName,
          url: targetUrl,
          live: true,
          status_code: resp.status,
          x402_enabled: x402Enabled,
          response_time_ms: Date.now() - startedAt,
          probe_url: probeUrl,
          note: note || undefined,
          checked_at: new Date().toISOString(),
        };

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              service: serviceName,
              url: targetUrl,
              live: false,
              error: err.message,
              checked_at: new Date().toISOString(),
            }),
          }],
        };
      }
    }
  );
}