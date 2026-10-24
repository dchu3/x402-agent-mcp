import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { guardUrl, isPrivateAddress, isPrivateIPv4, isPrivateIPv6, type ResolveFn } from './guard.js';

// Issue #58 C1 — the full address-class matrix against the shared transport
// guard. The resolver is INJECTED (opts.resolve) so these tests never touch
// real DNS; the default resolver is exercised only by tool-level tests.
//
// Decisions pinned here (plan D1/D2):
//   - codes: PRIVATE_HOST_REFUSED | HTTP_NOT_ALLOWED | URL_INVALID
//   - X402_ALLOW_PRIVATE_HOSTS is read from process.env ONLY — there is no
//     argument that can extend it (a caller cannot allowlist a private host).
//   - every resolved answer must be public; one private answer refutes.
//   - resolution failure does NOT refuse (the fetch fails through the normal
//     path) — that behaviour is asserted too.
//   - `http` is refused for public hosts (https only); allowlisted hosts
//     (private/loopback test sellers) may use http.

const PRIVATE_IPV4 = [
  '127.0.0.1', '127.255.255.254', // loopback 127/8
  '10.1.2.3',                     // private 10/8
  '172.16.5.4', '172.31.255.255', // 172.16/12 (both bounds)
  '192.168.0.2',                  // private 192.168/16
  '169.254.169.254',              // link-local 169.254/16 (cloud metadata)
  '0.0.0.0', '0.1.2.3',           // unspecified / this-network 0/8
];

const PUBLIC_IPV4 = [
  '93.184.216.34',
  '172.15.0.1', '172.32.0.1',      // 172.16/12 bounds — outside on both sides
  '192.169.0.1', '169.255.0.1',    // one above the private blocks
  '8.8.8.8', '1.1.1.1',
];

const PRIVATE_IPV6 = [
  '::1',                            // loopback
  '::',                             // unspecified
  'fc00::1', 'fdff::1',             // ULA fc00::/7 (both bounds)
  'fe80::1', 'febf::1',             // link-local fe80::/10 (both bounds)
  '::ffff:10.0.0.1',                // IPv4-mapped private
  '::ffff:127.0.0.1',               // IPv4-mapped loopback
];

const PUBLIC_IPV6 = [
  '::2', '2606:4700::6810:85e5', '::ffff:8.8.8.8', 'fec0::1',
];

/** Resolver stub: returns the given answers (or throws) — never real DNS. */
function resolverFor(answers: Array<{ address: string; family: number }>): ResolveFn {
  return async () => answers;
}
function failingResolver(): ResolveFn {
  return async () => { throw new Error('ENOTFOUND injected'); };
}

const env = { ...process.env };
afterEach(() => { process.env = { ...env }; });

describe('guardUrl — private literal addresses of every class are refused before any request (issue #58 req 2)', () => {
  for (const ip of PRIVATE_IPV4) {
    it(`refuses http://${ip}/ (IPv4 private literal)`, async () => {
      let resolved = 0;
      const r = await guardUrl(`http://${ip}/x`, { resolve: async () => { resolved++; return []; } });
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.equal(r.code, 'PRIVATE_HOST_REFUSED', ip);
      }
      assert.equal(resolved, 0, 'a literal IP is judged directly — never resolved');
    });
  }

  for (const ip of PRIVATE_IPV6) {
    it(`refuses http://[${ip}]/ (IPv6 private literal)`, async () => {
      const r = await guardUrl(`http://[${ip}]/x`);
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, 'PRIVATE_HOST_REFUSED', ip);
    });
  }
});

describe('guardUrl — public literals are not over-refused', () => {
  for (const ip of PUBLIC_IPV4) {
    it(`allows https://${ip}/ (IPv4 public literal)`, async () => {
      const r = await guardUrl(`https://${ip}/x`);
      assert.equal(r.ok, true, ip);
      if (r.ok) assert.equal(r.url, `https://${ip}/x`);
    });
  }
  for (const ip of PUBLIC_IPV6) {
    it(`allows https://[${ip}]/ (IPv6 public literal)`, async () => {
      const r = await guardUrl(`https://[${ip}]/x`);
      assert.equal(r.ok, true, ip);
    });
  }
});

describe('guardUrl — hostnames are resolved and EVERY answer must be public (issue #58 req 3)', () => {
  it('a hostname resolving to one private answer is refused, with the resolver called', async () => {
    let called = 0;
    const r = await guardUrl('https://seller.example/api', {
      resolve: async (host) => { called++; assert.equal(host, 'seller.example'); return [{ address: '10.0.0.1', family: 4 }]; },
    });
    assert.equal(called, 1);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'PRIVATE_HOST_REFUSED');
  });

  it('a hostname with MIXED public and private answers is refused (one bad answer refutes)', async () => {
    const r = await guardUrl('https://rebindable.example/', {
      resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }],
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'PRIVATE_HOST_REFUSED');
  });

  it('a hostname resolving to all-public answers is allowed', async () => {
    const r = await guardUrl('https://public.example/', {
      resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '2606:4700::6810:85e5', family: 6 }],
    });
    assert.equal(r.ok, true);
  });

  it('an unresolvable hostname is NOT refused (the fetch fails through the normal path)', async () => {
    const r = await guardUrl('https://does-not-resolve.invalid/', { resolve: failingResolver() });
    assert.equal(r.ok, true);
  });

  it('alternative IPv4 literal spellings (decimal/octal/hex) are refused once they resolve private', async () => {
    // 2130706433 = 127.0.0.1 decimal; 0177.0.0.1 = octal; 0x7f.0.0.1 = hex.
    // These are not isIP() literals, so the guard resolves them — the injected
    // resolver stands in for getaddrinfo's inet_aton semantics, which maps all
    // three spellings onto loopback.
    for (const host of ['2130706433', '0177.0.0.1', '0x7f.0.0.1', '0x7f000001']) {
      const r = await guardUrl(`http://${host}/`, { resolve: async () => [{ address: '127.0.0.1', family: 4 }] });
      assert.equal(r.ok, false, host);
      if (!r.ok) assert.equal(r.code, 'PRIVATE_HOST_REFUSED', host);
    }
  });

  it('localhost and .localhost names are refused without needing a resolver', async () => {
    for (const host of ['localhost', 'api.localhost', 'my-shop.localhost']) {
      const r = await guardUrl(`http://${host}:3000/`, { resolve: async () => { throw new Error('resolver must not be consulted for localhost names'); } });
      assert.equal(r.ok, false, host);
      if (!r.ok) assert.equal(r.code, 'PRIVATE_HOST_REFUSED', host);
    }
  });

  it('a URL with user info (user:pass@host) is refused as invalid — before any resolution', async () => {
    let resolved = 0;
    const r = await guardUrl('https://user:secret@93.184.216.34/', { resolve: async () => { resolved++; return []; } });
    assert.equal(resolved, 0);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'URL_INVALID');
  });

  it('non-http(s) schemes are refused (HTTP_NOT_ALLOWED) before any resolution', async () => {
    let resolved = 0;
    for (const raw of ['ftp://93.184.216.34/x', 'file:///etc/passwd', 'gopher://93.184.216.34']) {
      const r = await guardUrl(raw, { resolve: async () => { resolved++; return []; } });
      assert.equal(r.ok, false, raw);
      if (!r.ok) assert.equal(r.code, 'HTTP_NOT_ALLOWED', raw);
    }
    assert.equal(resolved, 0);
  });

  it('an unparseable URL is refused as URL_INVALID', async () => {
    const r = await guardUrl('not a url at all');
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'URL_INVALID');
  });
});

describe('guardUrl — plain http for a public host is refused (https only, issue #58 req 7)', () => {
  it('refuses http:// for a public literal host', async () => {
    const r = await guardUrl('http://93.184.216.34/x');
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'HTTP_NOT_ALLOWED');
  });

  it('refuses http:// for a publicly resolving hostname', async () => {
    const r = await guardUrl('http://public.example/x', { resolve: async () => [{ address: '93.184.216.34', family: 4 }] });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'HTTP_NOT_ALLOWED');
  });

  it('https for the same public host is allowed', async () => {
    const r = await guardUrl('https://public.example/x', { resolve: async () => [{ address: '93.184.216.34', family: 4 }] });
    assert.equal(r.ok, true);
  });
});

describe('X402_ALLOW_PRIVATE_HOSTS — the explicit private-host allowlist (issue #58 req 6)', () => {
  it('a host:port entry allows http AND https for exactly that host and port', async () => {
    process.env.X402_ALLOW_PRIVATE_HOSTS = '127.0.0.1:8787';
    for (const raw of ['http://127.0.0.1:8787/x', 'https://127.0.0.1:8787/x']) {
      const r = await guardUrl(raw);
      assert.equal(r.ok, true, raw);
      if (r.ok) assert.equal(r.url, raw);
    }
    const other = await guardUrl('http://127.0.0.1:9999/x');
    assert.equal(other.ok, false);
    if (!other.ok) assert.equal(other.code, 'PRIVATE_HOST_REFUSED');
  });

  it('a bare host entry (no port) matches any port on that host', async () => {
    process.env.X402_ALLOW_PRIVATE_HOSTS = '127.0.0.1';
    assert.equal((await guardUrl('http://127.0.0.1:1/')).ok, true);
    assert.equal((await guardUrl('http://127.0.0.1:65535/')).ok, true);
  });

  it('matching is case-insensitive on the host', async () => {
    process.env.X402_ALLOW_PRIVATE_HOSTS = 'LOCALHOST.EXAMPLE:8080';
    const r = await guardUrl('http://localhost.example:8080/', { resolve: async () => [{ address: '127.0.0.1', family: 4 }] });
    assert.equal(r.ok, true);
  });

  it('an allowlisted host is exempt from the private-refusal even when its DNS answers private', async () => {
    process.env.X402_ALLOW_PRIVATE_HOSTS = 'box.internal:8080';
    const r = await guardUrl('http://box.internal:8080/v1', { resolve: async () => [{ address: '192.168.1.10', family: 4 }] });
    assert.equal(r.ok, true);
  });

  it('an allowlist entry does NOT leak to another host or port', async () => {
    process.env.X402_ALLOW_PRIVATE_HOSTS = '127.0.0.1:8787,localhost:8788';
    for (const raw of ['http://10.0.0.1:8787/', 'http://192.168.1.1:8788/', 'http://localhost:8787/']) {
      const r = await guardUrl(raw);
      assert.equal(r.ok, false, raw);
      if (!r.ok) assert.equal(r.code, 'PRIVATE_HOST_REFUSED', raw);
    }
  });

  it('the allowlist can never be extended by the caller — there is no such argument (issue #58 req 6)', async () => {
    // opts only carries the injectable resolver; anything else (including a
    // hypothetical allowHosts) is ignored and the private host stays refused.
    const r = await guardUrl('http://127.0.0.1:8787/x', {
      resolve: failingResolver(),
      ...( { allowHosts: ['127.0.0.1:8787'] } as object),
    } as Parameters<typeof guardUrl>[1]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'PRIVATE_HOST_REFUSED');
  });

  it('an empty or unset allowlist refuses private hosts (deny by default)', async () => {
    delete process.env.X402_ALLOW_PRIVATE_HOSTS;
    assert.equal((await guardUrl('http://127.0.0.1:8787/')).ok, false);
    process.env.X402_ALLOW_PRIVATE_HOSTS = '';
    assert.equal((await guardUrl('http://127.0.0.1:8787/')).ok, false);
  });
});

describe('isPrivateAddress / isPrivateIPv6 — the shared classifier (moved from discover-url, issue #58 req 1)', () => {
  it('classify every private class true', () => {
    for (const ip of [...PRIVATE_IPV4, ...PRIVATE_IPV6]) assert.equal(isPrivateAddress(ip), true, ip);
  });

  it('classify public addresses false (boundary precision)', () => {
    for (const ip of [...PUBLIC_IPV4, ...PUBLIC_IPV6]) assert.equal(isPrivateAddress(ip), false, ip);
  });

  it('junk fails closed at the family classifiers (isPrivateAddress gates on isIP)', () => {
    // isPrivateIPv4/isPrivateIPv6 fail CLOSED on junk (true = treated private);
    // isPrivateAddress only routes through when isIP recognises the family —
    // a junk string is a HOSTNAME for the guard and takes the resolver path.
    for (const junk of ['junk', '1.2.3']) {
      assert.equal(isPrivateIPv4(junk), true, `isPrivateIPv4(${junk})`);
      assert.equal(isPrivateIPv6(junk), true, `isPrivateIPv6(${junk})`);
      assert.equal(isPrivateAddress(junk), false, `isPrivateAddress(${junk})`);
    }
    assert.equal(isPrivateAddress('999.999.999.999'), false, 'out-of-range octets are not an IPv4 literal (isIP gate)');
    assert.equal(isPrivateIPv6('1:2:3:4:5:6:7:8:9'), true, '9 hextets fail closed');
  });

  it('isPrivateIPv6 judges embedded dotted-quad tails by their IPv4 value', () => {
    assert.equal(isPrivateIPv6('::ffff:7f00:1'), true);   // hex-mapped loopback
    assert.equal(isPrivateIPv6('::ffff:8.8.8.8'), false); // hex-mapped public
  });
});