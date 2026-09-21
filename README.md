# x402-agent-mcp

**Universal x402 MCP for AI agents — discover and pay for any x402 endpoint on Base, Solana or Casper.**

Agents discover services, pay per call, and consume data — all autonomously. No API keys, no subscriptions, no signup. Just a wallet.

## What It Does

```
Agent: "I need news data"
  → x402_search("news") → finds 2s.io
  → x402_describe("2s.io") → gets endpoint schema + price
  → x402_fetch("https://2s.io/api/news/search?q=x402&limit=3") → pays $0.003 USDC → gets results
```

The agent never sees wallets, private keys, or x402 protocol details. Just search, discover, fetch.

## Tools (8)

| Tool | Cost | Description |
|------|------|-------------|
| `x402_search` | Free | Search x402 endpoints by keyword, category, or chain |
| `x402_list_categories` | Free | List all endpoint categories with counts |
| `x402_describe` | Free | Get detailed info for a specific service (paths, prices, schema) |
| `x402_discover_url` | Free | Discover any x402 service by URL via well-known files + auto-add to directory |
| `x402_health` | Free | Check if a service is live and responding with 402 |
| `x402_discover_urls` | Free | Batch discover multiple x402 services in parallel |
| `x402_crawl_directory` | Free | Crawl x402scan.com to discover new x402 services and auto-add to directory |
| `x402_fetch` | Endpoint price | Fetch any x402 endpoint — handles 402 payment on Base, Solana or Casper |

## Multi-Chain Support

| Chain | Env var | Payment |
|-------|---------|---------|
| Solana | `SOLANA_PRIVATE_KEY` | USDC via @x402/svm |
| Base | `EVM_PRIVATE_KEY` or `BASE_PRIVATE_KEY` | USDC via @x402/evm |
| Casper | `CASPER_PRIVATE_KEY` | wCSPR via @make-software/casper-x402 |

Chain is auto-detected from the 402 response. Override with `chain` parameter.

### Casper

Casper endpoints advertise CAIP-2 networks `casper:casper` (mainnet) and `casper:casper-test` (testnet), and settle in **wCSPR**, a CEP-18 token with 9 decimals (motes). Amounts are handled as exact integer motes — a requirement with sub-mote precision is rejected rather than rounded.

| Env var | Default | Description |
|---------|---------|-------------|
| `CASPER_PRIVATE_KEY` | — | Hex secret key, PEM file path, or PEM contents |
| `CASPER_KEY_ALGORITHM` | ed25519 | `ed25519` or `secp256k1` |
| `CASPER_NETWORK` | auto | Force `casper:casper` or `casper:casper-test` when a server offers both |
| `CASPER_MAX_PAYMENT_PER_CALL` | disabled | Maximum per authorization in decimal wCSPR (e.g. `1.5`) |
| `CASPER_MAX_DAILY_SPEND` | disabled | Daily authorization budget in decimal wCSPR (e.g. `10`) |

Both budgets must be explicitly set and positive. No USD conversion is performed. Only the network-specific wCSPR package hashes from [Casper Wallet Core](https://github.com/make-software/casper-wallet-core/blob/master/src/domain/constants/casperNetwork.ts) are accepted. `scheme: "exact"` and x402 v2 are required. Forced-chain calls still probe payment requirements, and the SDK checks the actual requirements again before signing. Settlement is performed by the endpoint's facilitator; this client does not configure a separate facilitator.

```
x402_fetch({ url: "https://some-casper-endpoint.example/api", chain: "casper" })
```

### Enabling the Casper leg

Before live paid Casper calls work, four prerequisites must be in place:

| Prerequisite | How to satisfy it |
|--------------|-------------------|
| Funded account key | Create a key with [Casper Wallet](https://www.casperwallet.io/) or [cspr.live](https://cspr.live) and export the hex secret key or PEM. On testnet, request free CSPR from the [Casper testnet faucet](https://testnet.cspr.live/tools/faucet). On mainnet you need real CSPR from an exchange or the staking ecosystem. |
| wCSPR balance | Endpoints settle in wCSPR (CEP-18), not raw CSPR. On mainnet you may need to wrap CSPR to wCSPR via a supported contract interaction first; on testnet the faucet plus a testnet wCSPR mint may apply. The exact wrap/mint flow varies — confirm it with the endpoint operator. |
| Target endpoint | This client ships no Casper endpoint list, and the x402 directory currently lists none. You need the endpoint URL from the operator — ask the endpoint operator or the Casper team. |
| Mote budgets | Both `CASPER_MAX_PAYMENT_PER_CALL` and `CASPER_MAX_DAILY_SPEND` must be set and positive, or **all** paid Casper requests fail closed. This is deliberate safety design, not a bug. |

Worked testnet `.env` (faucet-funded, small budgets — values are decimal wCSPR, converted to integer motes under the hood):

```bash
CASPER_PRIVATE_KEY=<hex-key-or-pem-path>
CASPER_NETWORK=casper:casper-test
CASPER_MAX_PAYMENT_PER_CALL=1
CASPER_MAX_DAILY_SPEND=5
```

Smoke test your first call:

```
x402_fetch({ url: "https://your-casper-endpoint.example/api", chain: "casper" })
```

Check the payment ledger for an entry with `currency: "wCSPR"` and an exact `amount_motes` string. Before the env vars are set, paid Casper calls return a `NOT_CONFIGURED`-style error; after, they sign and settle. An unset budget means no Casper signing happens at all.

**Why fail-closed:** if the key or either budget is unset, no Casper payment is ever signed — there is no silent fallback. Ambiguous failures retain their budget reservation (authorized, not settled), and spend stays bounded in native motes without any USD-conversion assumptions.

## Spending Limits & Payment Logging

| Env var | Default | Description |
|---------|---------|-------------|
| `MAX_PAYMENT_PER_CALL` | 0.50 | Reject any single call above this amount (USDC) |
| `MAX_DAILY_SPEND` | 10.00 | Reject after cumulative daily spend exceeded (USDC) |
| `PAYMENT_LOG_PATH` | ./x402-payments.jsonl | Path to payment log file (gitignored) |
| `X402_DIRECTORY_PATH` | ./endpoints.json | Path to the endpoint directory file (gitignored); set to isolate tests/sandboxes from the live directory |

Payments share one `x402-payments.jsonl` ledger with timestamp, URL, chain, amount, tx hash, and status. USDC entries use `amount_usdc`; Casper entries use `currency: "wCSPR"` and an exact `amount_motes` string. Base/Solana counters are tracked by chain and summed for the existing USD daily limit. Casper has an independent mote counter.

Casper reserves budget synchronously before signing to prevent concurrent overspending. Failed or ambiguous requests retain that reservation; it represents authorized spend, not confirmed settlement. Only one authorization is permitted per fetch. A server-provided settlement receipt is not independently verified on-chain. Payment response bodies/headers are size-bounded and Casper redirects are refused.

Counters are process-local and reset at UTC midnight or process restart. They are not a durable, multi-instance wallet limit.

### Limitations — read before relying on these budgets

- **Per-process counters.** Daily spend lives in the memory of one MCP process (rehydrated once from the ledger on the first budget check). It is never a wallet-level limit.
- **Multiple instances = separate budgets.** Running two MCP processes gives each its own counter, so the real daily spend can reach N × `MAX_DAILY_SPEND`. Durable multi-instance enforcement requires an external store and is on the roadmap; until then, run one instance per budget scope.
- **The USDC daily cap can be overshot by in-flight concurrency.** The guard checks `MAX_DAILY_SPEND` before paying and records spend only after settlement; the await points between the check and the log inside a paid fetch mean several in-flight requests can pass the same check. The synchronous check-then-log span itself is exact (locked by the concurrent-consumption test in `src/payment-utils.rehydrate.test.ts`), but cross-await atomicity must not be assumed.
- **Casper is the fail-closed equivalent class.** Casper reserves budget synchronously *before* signing, so concurrent Casper calls cannot overspend, and an unset or invalid budget disables Casper payments entirely. Verified by `src/casper/budget.test.ts`: "daily reservations prevent concurrent callers overspending", "checks changed requirements at signing and blocks retries", "unset either Casper budget disables signing", "invalid, zero and negative budgets disable payment", and "rolls only the Casper counter at UTC day change".

## Trust Model

**Settlement receipts are server-attested, not independently verified.** When a paid fetch settles, the seller's `PAYMENT-RESPONSE` header is decoded and surfaced as `payment_receipt` in the tool output. That receipt comes from the endpoint operator's server: it is an attestation, not proof. Every paid-fetch output therefore also carries `receipt_verified: false` and `receipt_note: "server-provided, not independently verified on-chain"` so the agent never mistakes an attestation for an on-chain fact. A malformed or hostile receipt is surfaced as-is (or absent) rather than treated as payment confirmation.

Independent on-chain verification is roadmap work — it requires a chain client per network (Base, Solana, Casper) to confirm the settlement transaction. Until then, treat `receipt_verified: false` as the ground truth: if a payment's settlement matters to you, verify the `tx_hash` / receipt yourself on the relevant chain explorer.

The other trust boundaries are explicit: the discovery fetcher refuses private/loopback/link-local addresses before any request and never follows redirects (see `x402_discover_url`), payment paths refuse redirects and size-bound all response bodies and payment headers, and the directory is written atomically with corrupt-file quarantine rather than silent overwrite.

## Quick Start

### 1. Install

```bash
git clone https://github.com/dchu3/x402-agent-mcp.git
cd x402-agent-mcp
npm install
npm run build
```

### 2. Configure

```bash
# .env
SOLANA_PRIVATE_KEY=your-base58-solana-key
EVM_PRIVATE_KEY=your-hex-base-key
CASPER_PRIVATE_KEY=your-hex-casper-key-or-pem-path
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=your-key
BASE_RPC_URL=https://mainnet.base.org
MAX_PAYMENT_PER_CALL=0.50
MAX_DAILY_SPEND=10.00
```

You only need the key for chains you want to pay on. Solana-only? Just set `SOLANA_PRIVATE_KEY`.

### 3. Connect to Your Agent

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
    'SOLANA_PRIVATE_KEY': 'your-base58-key',
    'EVM_PRIVATE_KEY': 'your-hex-key',
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
        "SOLANA_PRIVATE_KEY": "your-base58-key",
        "EVM_PRIVATE_KEY": "your-hex-key"
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
```

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
x402_fetch({
  url: "https://svm402.com/analyze",
  method: "POST",
  body: '{"address": "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"}'
})
```

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

## Disclaimer

**This software is experimental and provided "as is", without warranty of any kind. Use at your own risk.**

This software initiates real cryptocurrency transactions that are irreversible.

## Tech Stack

- [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [@x402/fetch](https://www.npmjs.com/package/@x402/fetch) — x402 payment handling
- [@x402/svm](https://www.npmjs.com/package/@x402/svm) — Solana x402 scheme
- [@x402/evm](https://www.npmjs.com/package/@x402/evm) — Base/EVM x402 scheme
- [@make-software/casper-x402](https://www.npmjs.com/package/@make-software/casper-x402) — Casper x402 scheme
- [viem](https://viem.sh) — EVM account signing
- [@solana/kit](https://github.com/solana-labs/solana-kit) — Solana SDK
- [casper-js-sdk](https://github.com/casper-ecosystem/casper-js-sdk) — Casper SDK

## License

MIT

## Links

- [x402 Protocol](https://x402.org) — Payment standard
- [x402scan](https://x402scan.com) — Endpoint explorer
- [MCP Protocol](https://modelcontextprotocol.io) — Agent tool protocol
- [Casper x402 docs](https://docs.cspr.cloud) — Casper facilitator and integration docs