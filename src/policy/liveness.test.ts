import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { isStale, entryOrigin, pinnedEntryFor, urlOnAllowlist, livenessVerdict, pathMatches } from './liveness.js';
import type { LivenessConfig } from './types.js';
import type { LivenessDirectoryRow } from './liveness.js';

// Issue #34 — the PURE liveness verdict module. Every clock is injected
// (nowMs): no Date.now() in this file, no I/O, no env.

const NOW = Date.parse('2026-09-25T12:00:00.000Z');
const FRESH_ISO = '2026-09-25T11:30:00.000Z';  // 30 min before NOW
const STALE_ISO = '2026-09-25T10:59:59.000Z';  // 1h 1s before NOW (one second past the max age)
const EDGE_ISO = '2026-09-25T11:00:00.000Z';   // exactly 3600 s before NOW

function cfg(overrides: Partial<LivenessConfig> = {}): LivenessConfig {
  return { require_fresh_402: true, max_age_seconds: 3600, ...overrides };
}

function freshLive(): { probed_at: string; status: 'live_402' } {
  return { probed_at: FRESH_ISO, status: 'live_402' };
}

describe('isStale — the injected-clock staleness check', () => {
  it('a probe INSIDE the max age is fresh; one past it is stale', () => {
    assert.equal(isStale({ probed_at: FRESH_ISO }, 3600, NOW), false);
    assert.equal(isStale({ probed_at: STALE_ISO }, 3600, NOW), true, 'older than max_age_seconds ⇒ stale');
  });

  it('exactly AT the max age boundary is not stale (strict >)', () => {
    assert.equal(isStale({ probed_at: EDGE_ISO }, 3600, NOW), false, 'age == max_age_seconds is still fresh');
  });

  it('a missing or unparseable probed_at is ALWAYS stale (fail closed)', () => {
    assert.equal(isStale(undefined, 3600, NOW), true, 'no record at all ⇒ stale');
    assert.equal(isStale({}, 3600, NOW), true, 'missing probed_at ⇒ stale');
    assert.equal(isStale({ probed_at: '' }, 3600, NOW), true, 'empty probed_at ⇒ stale');
    assert.equal(isStale({ probed_at: 'not-a-date' }, 3600, NOW), true, 'garbage ⇒ stale');
  });
});

describe('entryOrigin — origin normalisation', () => {
  it('normalises case, default ports and trailing paths; rejects non-http(s) and garbage', () => {
    assert.equal(entryOrigin('https://EXAMPLE.com/path?q=1'), 'https://example.com');
    assert.equal(entryOrigin('https://example.com:443/'), 'https://example.com', 'default https port normalised away');
    assert.equal(entryOrigin('http://example.com:8080'), 'http://example.com:8080', 'a non-default port is kept (and distinguishes origins)');
    assert.equal(entryOrigin('https://example.com/'), entryOrigin('https://example.com'), 'trailing slash irrelevant');
    assert.equal(entryOrigin('ftp://example.com'), undefined, 'an ftp URL is not a liveness origin');
    assert.equal(entryOrigin('not a url'), undefined);
    assert.equal(entryOrigin(''), undefined);
  });
});

describe('pinnedEntryFor — the pin set (L2)', () => {
  const seedRow: LivenessDirectoryRow = { base_url: 'https://seeded.example', source: 'seed' };
  const discoveryRow: LivenessDirectoryRow = { base_url: 'https://crawl.example', source: 'discovery' };
  const bareRow: LivenessDirectoryRow = { base_url: 'https://bare.example' };

  it('allowlist ABSENT ⇒ only source:"seed" rows are pinned (the operator-curated baseline)', () => {
    const pinned = pinnedEntryFor(cfg(), [seedRow, discoveryRow, bareRow]);
    assert.deepEqual(pinned, [{ origin: 'https://seeded.example' }]);
  });

  it('allowlist [] ⇒ the pin set is EMPTY (no endpoint is live)', () => {
    assert.deepEqual(pinnedEntryFor(cfg({ allowlist: [] }), [seedRow]), []);
  });

  it('explicit allowlist ⇒ origin-matched rows pinned WITH their paths constraint; config-only base_urls contribute NOTHING', () => {
    const pinned = pinnedEntryFor(
      cfg({ allowlist: [{ base_url: 'https://crawl.example', paths: ['/api'] }, { base_url: 'https://ghost.example' }] }),
      [seedRow, discoveryRow],
    );
    assert.deepEqual(pinned, [{ origin: 'https://crawl.example', paths: ['/api'] }], 'the unreachable ghost.example row pins nothing (fail-closed wart: the catalog never grows)');
  });

  it('explicit pinning is origin-aware and source-agnostic (a discovery row CAN be pinned explicitly)', () => {
    const pinned = pinnedEntryFor(cfg({ allowlist: [{ base_url: 'https://CRAWL.example:443/' }] }), [discoveryRow]);
    assert.deepEqual(pinned, [{ origin: 'https://crawl.example' }]);
  });

  it('unparseable config/base_url entries never pin anything', () => {
    const malformed: LivenessDirectoryRow = { base_url: 'not-a-url', source: 'seed' };
    assert.deepEqual(pinnedEntryFor(cfg(), [malformed]), [], 'a seed row with a malformed base_url has no origin to pin');
    assert.deepEqual(pinnedEntryFor(cfg({ allowlist: [{ base_url: ':::' }] }), [seedRow]), []);
  });
});

describe('urlOnAllowlist — origin + optional path membership', () => {
  it('a pinned origin without paths admits any path on that origin', () => {
    const pinned = [{ origin: 'https://svc.example' }];
    assert.equal(urlOnAllowlist('https://svc.example/api/x', pinned), true);
    assert.equal(urlOnAllowlist('https://svc.example/', pinned), true);
    assert.equal(urlOnAllowlist('https://other.example/api', pinned), false);
  });

  it('a paths constraint requires exact pathname membership', () => {
    const pinned = [{ origin: 'https://svc.example', paths: ['/api', '/v2/score'] }];
    assert.equal(urlOnAllowlist('https://svc.example/api', pinned), true);
    assert.equal(urlOnAllowlist('https://svc.example/v2/score', pinned), true);
    assert.equal(urlOnAllowlist('https://svc.example/other', pinned), false, 'an unlisted path is OFF the pin');
    assert.equal(urlOnAllowlist('https://svc.example/api/', pinned), false, 'pathname membership is exact (trailing slash differs)');
    assert.equal(urlOnAllowlist('https://svc.example/api?x=1', pinned), true, 'query strings never affect pathname membership');
  });

  it('an unparseable target URL is pinned by nothing (fail closed)', () => {
    assert.equal(urlOnAllowlist('not a url', [{ origin: 'https://svc.example' }]), false);
  });
});

// ---------------------------------------------------------------------------
// Issue #36 — trailing-* path wildcards in the allowlist. Exact literals keep
// exact equality; a single trailing `*` is a prefix wildcard. The predicate is
// unit-tested directly and through urlOnAllowlist; the exact-membership
// assertions above stay untouched and green.
// ---------------------------------------------------------------------------

describe('pathMatches — exact literals + one trailing-* prefix wildcard (#36)', () => {
  it('exact literals keep exact equality (no prefix semantics)', () => {
    assert.equal(pathMatches('/api', '/api'), true);
    assert.equal(pathMatches('/api', '/api/'), false, 'trailing slash differs');
    assert.equal(pathMatches('/api', '/apix'), false);
    assert.equal(pathMatches('/api', '/other'), false);
  });

  it('"/price/*" matches every parametrized instance under the prefix', () => {
    assert.equal(pathMatches('/price/*', '/price/x'), true);
    assert.equal(pathMatches('/price/*', '/price/DezXAZ2zLbtbrqTvwsWZX2VyZLt4PQWE89Lz35Nn1f3e'), true, 'a real address-shaped pathname matches');
    assert.equal(pathMatches('/price/*', '/price/x/y'), true, 'deeper segments under the prefix match too');
  });

  it('"/price/*" does NOT match the bare prefix or the bare collection route', () => {
    assert.equal(pathMatches('/price/*', '/price'), false);
    assert.equal(pathMatches('/price/*', '/price/'), false, 'prefix + "/" is the collection route, not a parametrized instance');
    assert.equal(pathMatches('/price/*', '/pricex/y'), false);
  });

  it('"/*" matches every path under the origin; interior stars are NOT wildcards', () => {
    assert.equal(pathMatches('/*', '/anything'), true);
    assert.equal(pathMatches('/*', '/a/deeper/path'), true);
    assert.equal(pathMatches('/a/*/b', '/a/x/b'), false, 'an interior * is not a wildcard — exact equality applies (the validator rejects the form)');
    assert.equal(pathMatches('/a/*/b', '/a/*/b'), true);
  });
});

describe('urlOnAllowlist with a wildcard pin (#36) — parametrized routes admitted, still fail-closed', () => {
  const pinned = [{ origin: 'https://svc.example', paths: ['/price/*'] }];

  it('a configured wildcard admits matching parametrized paths on the pinned origin', () => {
    assert.equal(urlOnAllowlist('https://svc.example/price/x402-probe', pinned), true);
    assert.equal(urlOnAllowlist('https://svc.example/price/DezXAZ1234', pinned), true);
  });

  it('the wildcard admits nothing else: bare prefix, prefix+"/", unlisted paths stay denied', () => {
    assert.equal(urlOnAllowlist('https://svc.example/price', pinned), false);
    assert.equal(urlOnAllowlist('https://svc.example/price/', pinned), false, 'trailing slash differs — the collection route is not pinned');
    assert.equal(urlOnAllowlist('https://svc.example/other', pinned), false);
  });

  it('query strings never affect wildcard pathname membership; origin and literal pins unchanged', () => {
    assert.equal(urlOnAllowlist('https://svc.example/price/abc?x=1', pinned), true, 'query strings ignored');
    assert.equal(urlOnAllowlist('https://other.example/price/abc', pinned), false, 'origin mismatch is still denied');
    assert.equal(
      urlOnAllowlist('https://svc.example/price/abc', [{ origin: 'https://svc.example', paths: ['/api'] }]),
      false,
      'a literal paths pin does not widen to prefix semantics',
    );
    assert.equal(urlOnAllowlist('https://svc.example/price/abc', [{ origin: 'https://svc.example' }]), true, 'a paths-less pin still admits every path');
  });
});

describe('livenessVerdict — L2 + L3 verbatim', () => {
  const url = 'https://svc.example/api';
  const seedEntry: LivenessDirectoryRow = { base_url: 'https://svc.example', source: 'seed' };

  it('require_fresh_402 FALSE ⇒ ok unconditionally, with the metadata still truthful', () => {
    const verdict = livenessVerdict({
      url,
      entry: { ...seedEntry, liveness: { probed_at: STALE_ISO, status: 'error' } },
      cfg: cfg({ require_fresh_402: false }),
      nowMs: NOW,
    });
    assert.equal(verdict.ok, true, 'the off-switch allows even a stale error record');
    assert.equal(verdict.status, 'error');
    assert.equal(verdict.stale, true, 'staleness is still reported honestly');
    assert.equal(verdict.on_allowlist, true);
    assert.equal(verdict.reason, undefined);
  });

  it('seed mode: a pinned (seed) row with a FRESH live_402 record is ok', () => {
    const verdict = livenessVerdict({ url, entry: { ...seedEntry, liveness: freshLive() }, cfg: cfg(), nowMs: NOW });
    assert.deepEqual(verdict, { ok: true, status: 'live_402', stale: false, on_allowlist: true });
  });

  it('seed mode: an UNPINNED catalog row (no source / discovery) is not ok — catalog membership is not proof of liveness', () => {
    for (const entry of [
      { base_url: 'https://svc.example', liveness: freshLive() },
      { base_url: 'https://svc.example', source: 'discovery', liveness: freshLive() },
    ]) {
      const verdict = livenessVerdict({ url, entry, cfg: cfg(), nowMs: NOW });
      assert.equal(verdict.ok, false, `entry ${JSON.stringify(entry.source)} must be refused even with a fresh live record`);
      assert.equal(verdict.on_allowlist, false);
      assert.match(verdict.reason ?? '', /catalog membership is not proof of liveness/);
    }
  });

  it('seed mode: a pinned row with a MISSING / STALE / no_402 / error record is not ok', () => {
    const cases: Array<[string, LivenessDirectoryRow, RegExp, { stale: boolean; status: string }]> = [
      ['never probed', seedEntry, /never been probed/, { stale: true, status: 'never_probed' }],
      ['stale live_402', { ...seedEntry, liveness: { probed_at: STALE_ISO, status: 'live_402' } }, /max_age_seconds/, { stale: true, status: 'live_402' }],
      ['no_402', { ...seedEntry, liveness: { probed_at: FRESH_ISO, status: 'no_402' } }, /did not answer a payment challenge/, { stale: false, status: 'no_402' }],
      ['error', { ...seedEntry, liveness: { probed_at: FRESH_ISO, status: 'error' } }, /failed its latest probe/, { stale: false, status: 'error' }],
    ];
    for (const [label, entry, message, expected] of cases) {
      const verdict = livenessVerdict({ url, entry, cfg: cfg(), nowMs: NOW });
      assert.equal(verdict.ok, false, `${label} must be refused`);
      assert.equal(verdict.status, expected.status, label);
      assert.equal(verdict.stale, expected.stale, label);
      assert.equal(verdict.on_allowlist, true, `${label}: the row IS pinned — it is the record that fails`);
      assert.match(verdict.reason ?? '', message, label);
    }
  });

  it('seed mode: a NON-catalog host is INERT (ok) — no catalog claim to falsify (L3)', () => {
    const verdict = livenessVerdict({ url: 'https://stranger.example/api', entry: undefined, cfg: cfg(), nowMs: NOW });
    assert.deepEqual(verdict, { ok: true, status: 'never_probed', stale: true, on_allowlist: false });
  });

  it('explicit allowlist: a listed origin pays only while its record is a fresh live_402 — independent of source', () => {
    const discoveryEntry: LivenessDirectoryRow = { base_url: 'https://svc.example', source: 'discovery' };
    const config = cfg({ allowlist: [{ base_url: 'https://svc.example' }] });
    const ok = livenessVerdict({ url, entry: { ...discoveryEntry, liveness: freshLive() }, cfg: config, nowMs: NOW });
    assert.equal(ok.ok, true, 'an explicitly pinned discovery row is live when fresh');
    const staleOne = livenessVerdict({ url, entry: { ...discoveryEntry, liveness: { probed_at: STALE_ISO, status: 'live_402' } }, cfg: config, nowMs: NOW });
    assert.equal(staleOne.ok, false);
    assert.equal(staleOne.stale, true);
  });

  it('explicit allowlist with paths pins only the listed paths', () => {
    const config = cfg({ allowlist: [{ base_url: 'https://svc.example', paths: ['/api'] }] });
    const entry = { ...seedEntry, liveness: freshLive() };
    assert.equal(livenessVerdict({ url: 'https://svc.example/api', entry, cfg: config, nowMs: NOW }).ok, true);
    const offPath = livenessVerdict({ url: 'https://svc.example/other', entry, cfg: config, nowMs: NOW });
    assert.equal(offPath.ok, false, 'the same origin on an unlisted path is NOT pinned');
    assert.equal(offPath.on_allowlist, false);
  });

  it('allowlist [] ⇒ NO catalog row is live and NO off-row host is live (strict mode, pin set empty)', () => {
    const config = cfg({ allowlist: [] });
    const onRow = livenessVerdict({ url, entry: { ...seedEntry, liveness: freshLive() }, cfg: config, nowMs: NOW });
    assert.equal(onRow.ok, false, 'even a seed row with a fresh record is refused — the pin set is empty');
    assert.equal(onRow.on_allowlist, false);
    const offRow = livenessVerdict({ url: 'https://stranger.example/api', entry: undefined, cfg: config, nowMs: NOW });
    assert.equal(offRow.ok, false, 'strict mode: an off-list host is refused');
    assert.match(offRow.reason ?? '', /not in the liveness allowlist/);
  });

  it('strict mode: a host that is NOT a catalog row is refused whenever the allowlist is explicit (L3)', () => {
    const config = cfg({ allowlist: [{ base_url: 'https://svc.example' }] });
    for (const target of ['https://stranger.example/api', 'https://svc-not.example/']) {
      const verdict = livenessVerdict({ url: target, entry: undefined, cfg: config, nowMs: NOW });
      assert.equal(verdict.ok, false, `${target} must be refused in strict mode`);
      assert.equal(verdict.on_allowlist, false);
      assert.match(verdict.reason ?? '', /not in the liveness allowlist/);
    }
  });

  it('is deterministic: same input twice ⇒ identical output', () => {
    const args = { url, entry: { ...seedEntry, liveness: freshLive() }, cfg: cfg(), nowMs: NOW };
    assert.deepEqual(livenessVerdict(args), livenessVerdict(args));
  });
});
