// Validate policy.example.json against the REAL config loader — proves the
// example parses clean and behaves exactly as documented in the README.
// Run: node scripts/validate-policy-example.mjs   (from the repo root)
import { mkdtempSync, copyFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const dir = mkdtempSync(join(tmpdir(), "policy-example-check-"));
const target = join(dir, "policy.json");
copyFileSync("policy.example.json", target);

process.env.POLICY_CONFIG_PATH = target;
process.env.POLICY_TRUSTED_HOSTS = "directory-host.example"; // fixture: env allowlist makes this TRUSTED (trusted: allow, $1.00)
const { getPolicyEngine, buildPolicyContext } = await import("../dist/policy/config.js");
const engine = getPolicyEngine();

const evalUrl = (url, chain, token, amount, budget = { dailySpentUsd: 0, perServiceSpentUsd: 0 }) =>
  engine.evaluate(buildPolicyContext(url, chain, token, amount), budget);

// 1) TRUSTED (env-allowlisted fixture host) on an allowed chain → ALLOW at the trusted cap
const ok = evalUrl("https://directory-host.example/api", "solana", "USDC", 0.20, { dailySpentUsd: 0, perServiceSpentUsd: 0 });
console.log("trusted-host request:   ", ok.decision, (ok.reasons ?? []).map(r => r.code).join(",") || "(no reasons)");

// 2) unknown host → DENY UNKNOWN_SERVICE (example sets services.unknown: deny)
const deny = evalUrl("https://some-random-host.example/api", "solana", "USDC", 0.10);
console.log("unknown-host request:  ", deny.decision, (deny.reasons ?? []).map(r => r.code).join(","));

// 3) casper + wCSPR now in the example allowlist → ALLOW (multi-chain example)
const chain = evalUrl("https://directory-host.example/api", "casper", "wCSPR", 0.10);
console.log("casper request:        ", chain.decision, (chain.reasons ?? []).map(r => r.code).join(",") || "(no reasons)");

// 4) over the trusted per-request cap ($1.00) → DENY REQUEST_LIMIT_EXCEEDED
const cap = evalUrl("https://directory-host.example/api", "solana", "USDC", 1.50);
console.log("over-cap request:      ", cap.decision, (cap.reasons ?? []).map(r => r.code).join(","));

rmSync(dir, { recursive: true, force: true });
const pass = ok.decision === "ALLOW" && deny.decision === "DENY" && chain.decision === "ALLOW" && cap.decision === "DENY"
  && (deny.reasons ?? []).some(r => r.code === "UNKNOWN_SERVICE")
  && (cap.reasons ?? []).some(r => r.code === "REQUEST_LIMIT_EXCEEDED");
console.log(pass ? "\nEXAMPLE VALIDATES CLEAN + behaves as documented" : "\nMISMATCH vs documentation");
process.exit(pass ? 0 : 1);