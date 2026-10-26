# Networks, chains and network mode

Which chains can pay, the explicit no-default `X402_NETWORK_MODE` rule, devnet, Casper, and the per-network asset table (the CAIP-2 matrix) with its exact USD pricing.

## Multi-Chain Support

| Chain | Env var | Payment |
|-------|---------|---------|
| Solana (mainnet) | `SOLANA_PRIVATE_KEY` | USDC via @x402/svm |
| Solana (devnet) | `SOLANA_PRIVATE_KEY` + `X402_NETWORK_MODE=devnet` | USDC via @x402/svm on the devnet RPC |
| Base | `EVM_PRIVATE_KEY` or `BASE_PRIVATE_KEY` | USDC via @x402/evm |
| Polygon | `EVM_PRIVATE_KEY` or `BASE_PRIVATE_KEY` | USDC via @x402/evm |
| Arbitrum | `EVM_PRIVATE_KEY` or `BASE_PRIVATE_KEY` | USDC via @x402/evm |
| Casper | `CASPER_PRIVATE_KEY` | wCSPR via @make-software/casper-x402 |

Chain is auto-detected from the 402 response's real CAIP-2 network id (`eip155:8453` ⇒ base, `eip155:137` ⇒ polygon, `eip155:42161` ⇒ arbitrum — an unrecognised `eip155:*` id keeps its verbatim identity and is denied by the default policy, never collapsed onto base). The Solana side is exact too: only the protocol's exact identifiers classify (`solana:5eykt4Us…`, the devnet id `solana:EtWTRAB…`, the testnet id, the V1 name, the bare mainnet genesis); a namespace whose name merely CONTAINS "solana" (e.g. `devnet;solana`) or an unknown `solana:*` genesis stays verbatim and is refused by policy. Override with the `chain` parameter (`base`/`polygon`/`arbitrum`/`solana`/`casper`). All EVM chains share the one `EVM_PRIVATE_KEY`; the Ethereum L1 (`eip155:1`) is always refused (see rule 3 in [policy.md](policy.md)). `BASE_RPC_URL` applies to Base only — EVM payments on Polygon/Arbitrum sign locally (EIP-3009) with no RPC dependency. Policy note: Polygon and Arbitrum are **opt-in** — add them to `networks.allowed` (and keep the facilitator settle-list `evm.facilitatorNetworks` covering their CAIP-2 ids) to make them payable; the default policy pays Base only among EVM chains.

## Network mode — explicit, no default

**`X402_NETWORK_MODE` is required before any paid call.** There is **no default**, by operator decision on record — the variable must be set explicitly.

| Value | Effect |
|-------|--------|
| `mainnet` | Pays mainnet networks only: Solana mainnet (`solana:5eykt4Us…`), non-testnet EVM chains, the Casper mainnet. A devnet or testnet network id is refused. |
| `devnet` | Pays the Solana devnet only (`solana:EtWTRAB…` — the x402 lab devnet, USDC `4zMMC9sr…` at the measured $0.001 ping). A mainnet or EVM offer is refused; the Casper testnet (`casper-test`) is the matching Casper network. |
| unset / invalid | With a payment key loaded, **every** `x402_fetch` refuses with `NETWORK_NOT_CONFIGURED` BEFORE the probe (zero network activity, zero payment headers). Free tools are immune: the directory, `x402_check_payment` and everything read-only keep working. |

**`mainnet` settles real, irreversible funds.** A mainnet payment is a live on-chain transaction you cannot claw back. Start on `devnet` with a throwaway key first (see the quick start just below) — devnet mode exists precisely so a key that holds no real value can exercise the whole payment flow, and **devnet spend has its own daily bucket** that never moves the mainnet totals.

Mechanics: the registration network is the MODE's exact CAIP-2 (a devnet wallet never signs a mainnet challenge, and vice versa); the Solana devnet runs `SOLANA_DEVNET_RPC_URL` (its documented public fallback is the SDK's devnet RPC; a mainnet RPC is never touched in devnet mode and vice versa); every result carries `network_mode` and the leg's exact `network`, and one stderr line at startup renders the mode, the RPC host (host only) and the asset table. The ledger rows carry `network`; **devnet spend has its own daily bucket** — a devnet payment never moves the mainnet daily totals or the mainnet reservations, and vice versa.

### Devnet quick start (throwaway key only)

Run a devnet-mode MCP against the x402 lab devnet (loopback-mapped in tests/sandboxes; use a THROWAWAY key — a mainnet-lab devnet key holds no value, and devnet mode exists precisely to keep it that way):

```bash
X402_NETWORK_MODE=devnet
SOLANA_PRIVATE_KEY=<throwaway-devnet-key-base58>
SOLANA_DEVNET_RPC_URL=<OPTIONAL — the public SDK devnet RPC is the fallback>
```

The default policy still gates every leg: add the devnet network to `networks.allowed` (e.g. `"solana"` — the mode boundary is what separates devnet from mainnet payments) and keep the devnet USDC symbol (`USDC`) in `tokens.allowed`. A devnet settlement writes a ledger row with `network: "solana:EtWTRAB…"` and accounts in the devnet bucket.

### Casper agreement

The mode and `CASPER_NETWORK` must agree or the leg refuses with `CHAIN_NOT_ALLOWED` before any binding, budget hold or signing (`mainnet` + `casper-test` ⇒ refuse; `devnet` + `casper` ⇒ refuse; an explicit mode with `CASPER_NETWORK` unset follows the mode: mainnet ⇒ `casper:casper`, devnet ⇒ `casper:casper-test`).

## Assets, Decimals and USD Pricing

An offer's asset is priced through a per-network asset table (`src/assets.ts`) BEFORE any pricing, binding or signing. USD conversion is exact integer arithmetic (`usdFromAtomic`); nothing is assumed:

| Network (CAIP-2) | Asset | Symbol | Decimals | USD |
|------------------|-------|--------|----------|-----|
| `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | USDC | 6 | pegged |
| `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (devnet) | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | USDC | 6 | pegged (measured 2026-10-24) |
| `eip155:8453` (Base) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | USDC | 6 | pegged |
| `eip155:137` (Polygon) | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` | USDC | 6 | pegged |
| `eip155:42161` (Arbitrum) | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | USDC | 6 | pegged |
| `casper:casper` / `casper:casper-test` | the wCSPR package hashes | wCSPR | 9 | **not pegged** — the Casper leg is mote-budgeted (unchanged) |

Operators extend the table via the policy config's `assets.extensions` (a list of `{network, asset, symbol, decimals, usdPeg?, usdRate?}` entries, validated fail-closed at load — an entry that prices nothing is rejected, and a valid extension's symbol/decimals override the shipped row for its asset). An `assets.extensions` entry can thus make a new asset payable: its symbol joins the `tokens.allowed` vocabulary and its decimals drive the exact USD conversion.

Three stable refusal codes ship with this layer:

- `ASSET_NOT_LISTED` — the offer's asset is not in the table for its network: refused before any pricing, binding or signing. No assumed unit, ever.
- `ASSET_NO_USD_RATE` — the asset IS listed but carries no USD leg (e.g. the wCSPR row): the USD-denominated caps need a value, so the offer is refused rather than never priced. (The Casper leg itself keeps its mote budgets — see D6-style precedent in the code.)
- `CONFIG_INVALID` (asset layer) — your extension list failed validation; fix it before any paid call.

Offer selection ranks offers by the table-priced USD (never the raw atomic string, never a fixed 6-decimal float — a 9-decimal offer worth more is not "bigger"). Money binding stays the exact atomic amount; the table only decides "can this be priced, and which offer is cheaper in USD".

### SDK spend controls, explicit

The SDK's implicit behavior (`DEFAULT_MAX_AMOUNT_PER_PAYMENT = '$1'` plus its own default-asset allowlist) is REPLACED at client construction by explicit controls driven by THIS project's caps: the top-level `maxAmountPerPayment` equals `MAX_PAYMENT_PER_CALL`'s value (the same source of truth the project gate reads), and every asset the table (plus your `assets.extensions`) lists gets an integer-atomic per-asset cap at the exact same cap equivalent. A request inside the project's caps can never again be refused BY the SDK's own $1 default or its asset universe. Two invariants are pinned by tests: the SDK's defaults are what the tests say they are, and the Casper leg's SDK spend controls stay DISABLED (`setSpendControls(false)`) because the Casper budget guard inside `src/casper/budget.ts` is the authority for that mote-denominated leg (its refusals read "Casper per-call budget exceeded", never an SDK string). Per-call caps fail closed as everywhere else: an invalid `MAX_PAYMENT_PER_CALL` refuses the call with `CONFIG_INVALID` rather than ever leaving the SDK layer uncapped.

### Casper

Casper endpoints advertise CAIP-2 networks `casper:casper` (mainnet) and `casper:casper-test` (testnet), and settle in **wCSPR**, a CEP-18 token with 9 decimals (motes). Amounts are handled as exact integer motes — a requirement with sub-mote precision is rejected rather than rounded.

| Env var | Default | Description |
|---------|---------|-------------|
| `CASPER_PRIVATE_KEY` | — | Hex secret key, PEM file path, or PEM contents |
| `CASPER_KEY_ALGORITHM` | ed25519 | `ed25519` or `secp256k1` |
| `CASPER_NETWORK` | auto | Force `casper:casper` or `casper:casper-test` when a server offers both |
| `CASPER_MAX_PAYMENT_PER_CALL` | disabled | Maximum per authorization in decimal wCSPR (e.g. `1.5`) |
| `CASPER_MAX_DAILY_SPEND` | disabled | Daily authorization budget in decimal wCSPR (e.g. `10`) |

Both budgets must be explicitly set and positive. **The mote budgets remain the ONLY spend binding for the Casper leg. The leg can now carry an EXPLICITLY CONFIGURED USD rate — `X402_RATE_WCSPR_USD`, or a priced wCSPR entry via `assets.extensions` — used ONLY for visibility (`x402_status` / `x402_inspect` listings) and for the optional cross-chain ceiling `MAX_DAILY_SPEND_TOTAL_USD`; it never converts the mote caps or replaces them, and an unpriced Casper rail is refused outright while a ceiling is active (`RAIL_DISABLED_NO_RATE`). Only the network-specific wCSPR package hashes from [Casper Wallet Core](https://github.com/make-software/casper-wallet-core/blob/master/src/domain/constants/casperNetwork.ts) are accepted. `scheme: "exact"` and x402 v2 are required. Forced-chain calls still probe payment requirements, and the SDK checks the actual requirements again before signing. Settlement is performed by the endpoint's facilitator; this client does not configure a separate facilitator.

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

