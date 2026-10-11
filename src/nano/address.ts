/**
 * Nano account address codec.
 *
 * A Nano address is `nano_` + 52 base32 characters encoding the 32-byte
 * ed25519 public key (left-padded with 4 zero bits to 260 bits) + 8 base32
 * characters encoding a 5-byte BLAKE2b checksum of that key, byte-reversed.
 * The alphabet omits 0, 2, l and v: `13456789abcdefghijkmnopqrstuwxyz`.
 * The legacy `xrb_` prefix encodes the same key and is accepted on input.
 *
 * Validation is exact: a wrong checksum is rejected, never repaired. BLAKE2b
 * (RFC 7693) is implemented here with BigInt words because Node's built-in
 * `blake2b512` cannot produce the 5-byte digest the checksum needs, and this
 * repo avoids new dependencies for a few lines of hashing.
 */

const ALPHABET = "13456789abcdefghijkmnopqrstuwxyz";

const MASK64 = (1n << 64n) - 1n;
const IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

function rotr64(x: bigint, n: bigint): bigint {
  return ((x >> n) | (x << (64n - n))) & MASK64;
}

function readWord(block: Uint8Array, i: number): bigint {
  let w = 0n;
  for (let b = 7; b >= 0; b--) w = (w << 8n) | BigInt(block[i * 8 + b]);
  return w;
}

/** Unkeyed BLAKE2b (RFC 7693) with a 1..64 byte digest. */
export function blake2b(input: Uint8Array, outLen: number): Uint8Array {
  if (!Number.isInteger(outLen) || outLen < 1 || outLen > 64) throw new Error("blake2b digest length must be 1..64");
  const h = [...IV];
  h[0] ^= 0x01010000n ^ BigInt(outLen);
  const blocks = Math.max(1, Math.ceil(input.length / 128));
  for (let n = 0; n < blocks; n++) {
    const block = new Uint8Array(128);
    block.set(input.subarray(n * 128, n * 128 + 128));
    const last = n === blocks - 1;
    const t = BigInt(last ? input.length : (n + 1) * 128);
    const m = Array.from({ length: 16 }, (_, i) => readWord(block, i));
    const v = [...h, ...IV];
    v[12] ^= t & MASK64;
    v[13] ^= t >> 64n;
    if (last) v[14] ^= MASK64;
    const g = (a: number, b: number, c: number, d: number, x: bigint, y: bigint) => {
      v[a] = (v[a] + v[b] + x) & MASK64; v[d] = rotr64(v[d] ^ v[a], 32n);
      v[c] = (v[c] + v[d]) & MASK64; v[b] = rotr64(v[b] ^ v[c], 24n);
      v[a] = (v[a] + v[b] + y) & MASK64; v[d] = rotr64(v[d] ^ v[a], 16n);
      v[c] = (v[c] + v[d]) & MASK64; v[b] = rotr64(v[b] ^ v[c], 63n);
    };
    for (let r = 0; r < 12; r++) {
      const s = SIGMA[r % 10];
      g(0, 4, 8, 12, m[s[0]], m[s[1]]);
      g(1, 5, 9, 13, m[s[2]], m[s[3]]);
      g(2, 6, 10, 14, m[s[4]], m[s[5]]);
      g(3, 7, 11, 15, m[s[6]], m[s[7]]);
      g(0, 5, 10, 15, m[s[8]], m[s[9]]);
      g(1, 6, 11, 12, m[s[10]], m[s[11]]);
      g(2, 7, 8, 13, m[s[12]], m[s[13]]);
      g(3, 4, 9, 14, m[s[14]], m[s[15]]);
    }
    for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
  }
  const out = new Uint8Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = Number((h[i >> 3] >> BigInt(8 * (i & 7))) & 0xffn);
  return out;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

function encodeBase32(n: bigint, chars: number): string {
  let out = "";
  for (let i = chars - 1; i >= 0; i--) out += ALPHABET[Number((n >> BigInt(5 * i)) & 31n)];
  return out;
}

function decodeBase32(s: string): bigint | undefined {
  let n = 0n;
  for (const ch of s) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) return undefined;
    n = (n << 5n) | BigInt(idx);
  }
  return n;
}

function checksumOf(publicKey: Uint8Array): string {
  return encodeBase32(bytesToBigInt(blake2b(publicKey, 5).reverse()), 8);
}

/** Encode a 32-byte public key as a canonical `nano_` address. */
export function publicKeyToNanoAddress(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error("Nano public key must be 32 bytes");
  return `nano_${encodeBase32(bytesToBigInt(publicKey), 52)}${checksumOf(publicKey)}`;
}

/**
 * Decode a `nano_` / `xrb_` address to its 32-byte public key, or undefined
 * when it is not a valid address (wrong prefix, alphabet, length, padding or
 * checksum). Total and pure — never throws.
 */
export function nanoAddressToPublicKey(address: string): Uint8Array | undefined {
  if (typeof address !== "string") return undefined;
  const m = /^(?:nano|xrb)_([13][13456789abcdefghijkmnopqrstuwxyz]{51})([13456789abcdefghijkmnopqrstuwxyz]{8})$/.exec(address);
  if (!m) return undefined;
  const n = decodeBase32(m[1]);
  if (n === undefined || n >> 256n !== 0n) return undefined;
  const publicKey = new Uint8Array(32);
  for (let i = 0; i < 32; i++) publicKey[i] = Number((n >> BigInt(8 * (31 - i))) & 0xffn);
  return checksumOf(publicKey) === m[2] ? publicKey : undefined;
}

/** True only for a checksum-valid `nano_` or `xrb_` address. */
export function isValidNanoAddress(address: string): boolean {
  return nanoAddressToPublicKey(address) !== undefined;
}

/** Canonical `nano_` form of a valid address (legacy `xrb_` rewritten), else undefined. */
export function normalizeNanoAddress(address: string): string | undefined {
  const publicKey = nanoAddressToPublicKey(typeof address === "string" ? address.trim() : address);
  return publicKey ? publicKeyToNanoAddress(publicKey) : undefined;
}
