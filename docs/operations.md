# Operations — usage, directory refresh, CI and security

Running and maintaining an installation: daily usage examples, the endpoint directory and its refresh recipes, connecting agent clients, development and CI, the pre-push security scan, the roadmap and the tech stack.

## Connecting your agent client

#### Hermes Agent

```bash
hermes config set mcp_servers.x402.command "node"
hermes config set mcp_servers.x402.args '["/path/to/x402-agent-mcp/dist/index.js"]'
hermes config set mcp_servers.x402.enabled true

# Set env vars
python3 -c "
import yaml
with open('$HOME/.hermes/config.yaml') as f:
    config = yaml.safe_load(f)
config['mcp_servers']['x402']['env'] = {
    'SOLANA_PRIVATE_KEY': '<YOUR_SOLANA_PRIVATE_KEY>',
    'EVM_PRIVATE_KEY': '<YOUR_EVM_PRIVATE_KEY>',
}
with open('$HOME/.hermes/config.yaml', 'w') as f:
    yaml.dump(config, f, default_flow_style=False, allow_unicode=True)
"

hermes gateway restart
hermes mcp test x402
```

#### Claude Desktop

```json
{
  "mcpServers": {
    "x402": {
      "command": "node",
      "args": ["/path/to/x402-agent-mcp/dist/index.js"],
      "env": {
        "SOLANA_PRIVATE_KEY": "<YOUR_SOLANA_PRIVATE_KEY>",
        "EVM_PRIVATE_KEY": "<YOUR_EVM_PRIVATE_KEY>"
      }
    }
  }
}
```

## Usage Examples

### Search for endpoints

```
x402_search({ query: "news" })
x402_search({ category: "social" })
x402_search({ chain: "solana" })
x402_search({ include_unverified: true })   // also show rows OFF the liveness pin set (always live: false)
```

Results are ranked live-first: each row carries `live` and a `liveness` block (`status`, `probed_at`, `stale`), and the summary carries `live_total`.

### Refresh the liveness probes

```
x402_probe_allowlist({})   // probes the pin set (seed rows, or liveness.allowlist origins); never pays
```

Run it on your own schedule (cron), exactly like the directory crawler — search itself never probes.

### Discover a service by URL

```
x402_discover_url({ url: "https://svm402.com" })
```

### Batch discover multiple URLs

```
x402_discover_urls({ urls: ["https://svm402.com", "https://2s.io"] })
```

### Crawl x402scan for new services

```
x402_crawl_directory({ max_results: 20 })
```

### Check if a service is live

```
x402_health({ name: "svm402" })
x402_health({ url: "https://svm402.com" })
```

### Fetch an x402 endpoint

```
x402_fetch({ url: "https://svm402.com/v1/ping" })
```

Paid routes and prices rotate; the seller's `GET /.well-known/x402` manifest is the current machine-readable list of live routes and prices — confirm the route there first, then point `x402_fetch` at a path you just learned from that manifest rather than one copied from older docs:

```
x402_fetch({
  url: "https://2s.io/api/news/search?q=x402&limit=3",
  chain: "solana"
})
```

## Endpoint Directory

The `endpoints.json` file contains known x402 endpoints. It is **gitignored** — each installation builds its own directory.

- `endpoints.example.json` is shipped as a template (empty, with categories)
- On first run, the MCP loads the template and populates from there
- `x402_discover_url` auto-adds new services when discovered
- `x402_crawl_directory` scrapes x402scan.com for new services
- Only true x402 endpoints (no API keys) are included
- Set `X402_DIRECTORY_PATH` to point the directory elsewhere (consulted first by all reads/writes) — useful for tests and sandboxed installs so the live `endpoints.json` is never modified

To bootstrap a fresh install:
```bash
cp endpoints.example.json endpoints.json
# Then run x402_crawl_directory to populate
```

Directory entries carry a `source` field for provenance: `"seed"` marks the operator-curated baseline, `"discovery"` marks entries added by `x402_crawl_directory`. This is the baseline for the trust-level classification the policy engine consumes, and for the **liveness pin set**: with `liveness.allowlist` omitted (the default), only `"seed"` rows are pinned (ranked live-first in `x402_search` when freshly probed, and payable under rule 4.7); `"discovery"` rows are unverified until explicitly pinned. Entries also accumulate a `liveness` record written by `x402_probe_allowlist` (see [policy.md](policy.md) — *Endpoint liveness*).

## Automated Directory Refresh

The endpoint directory stays fresh by running `x402_crawl_directory` on a schedule. Here's how to set it up in popular agent frameworks:

### Hermes Agent (cron job)

Hermes supports scheduled cron jobs that can run the crawler automatically:

```bash
# Create a weekly cron job (every Monday at 03:00 UTC)
hermes cron create \
  --name "x402 Crawl Directory" \
  --schedule "0 3 * * 1" \
  --toolsets terminal \
  --deliver local \
  --prompt 'Run the x402-agent-mcp crawler to discover new endpoints from x402scan.com:

cd /path/to/x402-agent-mcp && echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"hermes-cron\",\"version\":\"1.0\"}}}
{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}
{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"x402_crawl_directory\",\"arguments\":{\"max_results\":20}}}" | timeout 120 node dist/index.js 2>/dev/null | tail -1

Parse the JSON response and report how many new services were added. If none found, say "No new x402 endpoints discovered this week."'
```

The `--deliver local` flag keeps the cron job silent (no chat messages) — it just updates `endpoints.json` in the background.

### Other Agents (crontab)

For agents without built-in scheduling, use system crontab:

```bash
# Add to crontab — runs every Monday at 03:00
crontab -e

# Add this line:
0 3 * * 1 cd /path/to/x402-agent-mcp && echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cron","version":"1.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"x402_crawl_directory","arguments":{"max_results":20}}}' | timeout 120 node dist/index.js >> /var/log/x402-crawl.log 2>&1
```

### Custom Scripts

The crawler can also be called programmatically:

```javascript
import { registerCrawlX402ScanTool } from "./tools/crawl-directory.js";
// Or call the MCP via stdio — see usage examples above
```

## Development

Prerequisites: Node ≥ 20 (declared in `engines`) and npm ≥ 9.

```bash
git clone https://github.com/dchu3/x402-agent-mcp.git
cd x402-agent-mcp
npm install
npm run build
npm test
```

### Test suite

`npm test` compiles `src/**` to `dist-test/` and runs the suite with
`scripts/run-tests.mjs`, which lists the `*.test.js` files explicitly. The
direct `node --test "dist-test/**/*.test.js"` (glob) form only expands from
Node ≥ 21, so on Node 20 it matches no files — the explicit list runs
identically on Node 20 and newer.

The suite is **hermetic by default**: tests talk only to loopback mock
sellers (exactly the hosts `X402_ALLOW_PRIVATE_HOSTS` lets through), write
every state file into a `mkdtemp` temp path (`X402_DIRECTORY_PATH`,
`PAYMENT_LOG_PATH`), touch no network beyond that loopback, and generate
any wallet key they sign with at runtime — thrown away with the temp
directory when the suite ends. Nothing in `npm test` reaches a public chain.

**Optional devnet smoke (never part of `npm test`).** The one way to watch
the payment flow settle for real without touching mainnet is devnet mode
against the x402 lab devnet ([networks.md](networks.md)) with a key that
holds no real value:

```bash
X402_NETWORK_MODE=devnet
SOLANA_PRIVATE_KEY=<THROWAWAY_DEVNET_KEY>       # generated, never a mainnet key
# SOLANA_DEVNET_RPC_URL=<DEVNET_RPC_URL>        # optional; the public SDK devnet RPC is the fallback
```

Add the devnet network to the policy's `networks.allowed`, then make one
small paid call, e.g. `x402_fetch({ url: "https://<DEVNET_ENDPOINT_URL>" })`
against the lab seller, and check the ledger: the row must carry the devnet
network id in `network`, spend must land in the devnet bucket, and the
fund-from-faucet wallet (`<DEVNET_TEST_WALLET>` if you name it anywhere)
must be the throwaway — never a key that holds value.

**No real addresses or keys in tests, fixtures, docs or examples.** Every
address-shaped value that is not already-documented public infra (the
devnet ids in networks.md) must be an angle-bracket placeholder, written
so a copy-paste can never carry value. The enforcement net is the
[pre-push security scan](#pre-push-security-scan) below — write tests and
docs as if that scan runs on every push, because it does.

### CI

`.github/workflows/ci.yml` builds and tests on Node 20 and 22, installs with
`npm ci --ignore-scripts` (no install-time lifecycle script is needed by the
suite, so install scripts never run in CI), validates the policy example, and
gates the production dependency tree with `npm audit --omit=dev
--audit-level=critical`. The current tree passes the gate; the remaining
findings are `high`-severity `zod < 4.6.6` advisories on the nested `zod@3.x`
copies owned by `@x402/core` / `@x402/evm`'s own dependency ranges. Fixing
those needs an `overrides` entry for `@x402/core` (bumping the Casper
leg's `@x402/core` from 2.15.0), which is a payment-transport change tracked
separately. Every `pull_request` and push to
`master` also runs the secret scan below over the full PR range.

### Pre-push security scan

`scripts/pre-push-security-scan.sh <base-ref> [<head-ref>]` blocks a push when
the diff introduces secret-shaped material (raw key material, GitHub/AWS token
shapes, PEM blocks, secret-shaped assignments, absolute home-dir paths,
`.env`-like files). The scan never reads or executes `.env` or any repo file —
operator-specific patterns arrive only as data:

```bash
# wallet patterns that must never appear in a pushed diff — one per line,
# in a file OUTSIDE the repository (placeholder shown)
X402_SCAN_WALLET_PATTERNS_FILE=/path/outside/repo/wallet-patterns.txt
# …or whitespace-separated in the environment (placeholders shown)
X402_KNOWN_WALLETS="<wallet-address-one> <wallet-address-two>"
```

The same values can be passed as arguments: `--patterns-file <path>` and a
repeatable `--known-wallet <pattern>`. Blocked real-name regexes come from
`$BLOCKED_NAME_PATTERNS` (environment only; the scan fails closed to an inert
placeholder when unset).

Install as a pre-push hook:

```bash
printf '#!/bin/sh\nbash scripts/pre-push-security-scan.sh origin/master HEAD\n' \
  > .git/hooks/pre-push
chmod +x .git/hooks/pre-push
```

## Roadmap

Explicitly deferred — tracked here so the boundary is visible, not forgotten:

- **Discovery freshness & trust levels** — the directory records provenance (`source: "seed"` / `source: "discovery"`) but does not track freshness or verification state. Enforcement of freshness, trust levels and per-service policy belongs to the **policy engine** (its trust-level model consumes exactly this metadata) and is deliberately not implemented ad hoc here.
- **Self-describing service manifests** — machine-readable service metadata is an ecosystem-wide direction: services must publish manifests before clients can consume them. Deferred to the ecosystem roadmap; `x402_discover_url` already consumes `/.well-known/ai-catalog.json` and `/.well-known/x402` where present.
- **Multi-instance budget durability** — enforcing one budget across several MCP processes needs an external spend store (see [payments.md](payments.md) — Limitations).
- **On-chain settlement-receipt verification** — independently verifying receipts needs a chain client per network (see [payments.md](payments.md) — Trust Model).
- **Persistent audit ledger for payments/intents** — durable, multi-instance audit trails (payment intents are process-local by design, like the budget counters); needs an external store and is deferred with the multi-instance budget work.

## Tech Stack

- [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [@x402/fetch](https://www.npmjs.com/package/@x402/fetch) — x402 payment handling
- [@x402/svm](https://www.npmjs.com/package/@x402/svm) — Solana x402 scheme
- [@x402/evm](https://www.npmjs.com/package/@x402/evm) — Base/EVM x402 scheme
- [@make-software/casper-x402](https://www.npmjs.com/package/@make-software/casper-x402) — Casper x402 scheme
- [viem](https://viem.sh) — EVM account signing
- [@solana/kit](https://github.com/solana-labs/solana-kit) — Solana SDK
- [casper-js-sdk](https://github.com/casper-ecosystem/casper-js-sdk) — Casper SDK


## Links

- [x402 Protocol](https://x402.org) — Payment standard
- [x402scan](https://x402scan.com) — Endpoint explorer
- [MCP Protocol](https://modelcontextprotocol.io) — Agent tool protocol
- [Casper x402 docs](https://docs.cspr.cloud) — Casper facilitator and integration docs