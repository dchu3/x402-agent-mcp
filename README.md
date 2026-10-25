# x402-agent-mcp

**Universal x402 agent MCP — discover and pay for any x402 endpoint on Base, Polygon, Arbitrum, Solana or Casper**

## What it does

An agent searches the directory, describes a service, then fetches its URL: the server pays the seller's 402 price with the operator's wallet and hands back the data. The agent never sees wallets, private keys or x402 protocol details — no API keys, no subscriptions, just a wallet.

## Quick start

```bash
git clone https://github.com/dchu3/x402-agent-mcp.git
cd x402-agent-mcp
npm install
npm run build
```

Point your MCP client config at the built server, passing the server's keys through `env` (only keys that exist in [.env.example](.env.example)):

```json
{
  "mcpServers": {
    "x402": {
      "command": "node",
      "args": ["/path/to/x402-agent-mcp/dist/index.js"],
      "env": {
        "X402_NETWORK_MODE": "mainnet",
        "SOLANA_PRIVATE_KEY": "<YOUR_SOLANA_PRIVATE_KEY>",
        "EVM_PRIVATE_KEY": "<YOUR_EVM_PRIVATE_KEY>",
        "CASPER_PRIVATE_KEY": "<YOUR_CASPER_PRIVATE_KEY>",
        "MAX_PAYMENT_PER_CALL": "0.50",
        "MAX_DAILY_SPEND": "10.00"
      }
    }
  }
}
```

Replace every `<PLACEHOLDER>` with your own value — never commit real key material. Only the chains you want to pay on need a key. The full annotated key set (RPC URLs with their public fallbacks, devnet mode, the optional cross-chain ceiling, the policy config) is [.env.example](.env.example); copy it to a `.env` your client loads, or inline the keys in the config block.

> **Before your first paid call:** there is no default network — with a payment key loaded and `X402_NETWORK_MODE` unset, every paid call is refused with `NETWORK_NOT_CONFIGURED` before anything is fetched or signed. Set `MAX_PAYMENT_PER_CALL` and `MAX_DAILY_SPEND` to what you can afford, and make your first paid calls with a throwaway key.

Paid routes and prices rotate — confirm the route and price on the seller's `GET /.well-known/x402` manifest before fetching.

## Tools

| Tool | Free/paid | Purpose |
|------|-----------|---------|
| `x402_search` | Free | Search the endpoint directory by keyword, category or chain — ranked live-first, zero network calls. |
| `x402_list_categories` | Free | List all endpoint categories with counts. |
| `x402_describe` | Free | Get one service's paths, prices and schema. |
| `x402_discover_url` | Free | Discover an x402 service by URL (well-known files) and add it to the directory. |
| `x402_health` | Free | Check a service is live and answering 402. |
| `x402_discover_urls` | Free | Batch-discover several services in parallel. |
| `x402_crawl_directory` | Free | Crawl x402scan.com for new services and add them to the directory. |
| `x402_check_payment` | Free | Evaluate a prospective payment: decision, reason codes, limits, network mode, budget headroom. Never pays. |
| `x402_probe_allowlist` | Free | Refresh the recorded 402 liveness probes for the pinned endpoint set. Never pays. |
| `x402_status` | Free | Show every budget rail — unit, caps, spent/remaining today, outstanding holds, ledger path, configured USD rate. Read-only. |
| `x402_inspect` | Free | Inspect a 402 challenge or single offer — exact amounts, asset verdict, policy and budget verdicts — without paying or fetching. |
| `x402_fetch` | Endpoint price | Fetch an x402 endpoint and pay the 402 price — the only paying tool. |

## Safety and network defaults

- The default payment policy is permissive — any x402 endpoint is payable up to the global caps — and every cap fails closed on a malformed value (it disables payments rather than widening them). Tighten via a config file pointed at by `POLICY_CONFIG_PATH`.
- Polygon and Arbitrum are opt-in (add them to the policy's `networks.allowed`); the Ethereum mainnet (`eip155:1`) is always refused.
- Payment receipts come from the seller and are not verified on-chain (`receipt_verified: false`).
- There is no default network: `X402_NETWORK_MODE` must be set explicitly (#59).

## Documentation

- [Policy engine](docs/policy.md) — decisions, reason codes, rule order, trust levels, the recipients and anomaly gates
- [Payments and budgets](docs/payments.md) — spend accounting, the ledger and reservations, the payment-intent boundary, trust in receipts
- [Networks and network mode](docs/networks.md) — the chain matrix, the no-default network mode, devnet, Casper, assets and USD pricing
- [Operations](docs/operations.md) — usage examples, directory refresh recipes, CI, the security scan, tech stack

## Disclaimer and licence

**This software is experimental and provided "as is", without warranty of any kind. Use at your own risk.** It initiates real cryptocurrency transactions that are irreversible. License: MIT.