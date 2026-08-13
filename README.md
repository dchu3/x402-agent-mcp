# x402-agent-mcp

**Universal x402 MCP for AI agents — discover and pay for any x402 endpoint on Base or Solana.**

Agents discover services, pay per call in USDC, and consume data — all autonomously. No API keys, no subscriptions, no signup. Just a wallet.

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
| `x402_fetch` | Endpoint price | Fetch any x402 endpoint — handles 402 payment on Base or Solana |

## Multi-Chain Support

| Chain | Env var | Payment |
|-------|---------|---------|
| Solana | `SOLANA_PRIVATE_KEY` | USDC via @x402/svm |
| Base | `EVM_PRIVATE_KEY` or `BASE_PRIVATE_KEY` | USDC via @x402/evm |

Chain is auto-detected from the 402 response. Override with `chain` parameter.

## Spending Limits & Payment Logging

| Env var | Default | Description |
|---------|---------|-------------|
| `MAX_PAYMENT_PER_CALL` | 0.50 | Reject any single call above this amount (USDC) |
| `MAX_DAILY_SPEND` | 10.00 | Reject after cumulative daily spend exceeded (USDC) |
| `PAYMENT_LOG_PATH` | ./x402-payments.jsonl | Path to payment log file (gitignored) |

Payments are logged to `x402-payments.jsonl` with timestamp, URL, chain, amount, tx hash, and status. Daily spend resets at UTC midnight.

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

To bootstrap a fresh install:
```bash
cp endpoints.example.json endpoints.json
# Then run x402_crawl_directory to populate
```

## Disclaimer

**This software is experimental and provided "as is", without warranty of any kind. Use at your own risk.**

This software initiates real cryptocurrency transactions that are irreversible.

## Tech Stack

- [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [@x402/fetch](https://www.npmjs.com/package/@x402/fetch) — x402 payment handling
- [@x402/svm](https://www.npmjs.com/package/@x402/svm) — Solana x402 scheme
- [@x402/evm](https://www.npmjs.com/package/@x402/evm) — Base/EVM x402 scheme
- [viem](https://viem.sh) — EVM account signing
- [@solana/kit](https://github.com/solana-labs/solana-kit) — Solana SDK

## License

MIT

## Links

- [x402 Protocol](https://x402.org) — Payment standard
- [x402scan](https://x402scan.com) — Endpoint explorer
- [MCP Protocol](https://modelcontextprotocol.io) — Agent tool protocol