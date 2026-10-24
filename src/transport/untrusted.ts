// Issue #63 — seller- and directory-controlled text is UNTRUSTED data for an
// AI agent (prompt injection: seller text may contain instructions aimed at
// the model reading it). Every piece of seller/directory text the tools
// surface must:
//   1. live ONLY in a named untrusted field (untrusted.body, untrusted.challenge,
//      untrusted.description) — never on plain tool fields,
//   2. have control characters (C0 except tab/newline, DEL, C1) and ANSI
//      escapes stripped — display tricks cannot hide instructions or flip a
//      terminal, and
//   3. honour a per-field cap (X402_MAX_UNTRUSTED_CHARS, default per surface)
//      with an explicit truncation marker + original size, so nothing sneaks
//      past a cap silently.
// The tool's own status/error/message fields stay fixed text (values the
// x402-agent-mcp authors wrote), and raw detail goes to the local debug log.
//
// Pure module: no fetch, no ledger, no policy import.

/** Default cap for untrusted seller text (issue #63 req 2). Generous enough
 * for real seller pages, small enough that a flooded model context cannot
 * push real data out (per surface: probe/paid body and error detail). */
export const PROBE_UNTRUSTED_MAX = 100_000;

/** Cap for a rendered challenge/off-requirement blob (a serialised payment
 * requirement object is machine text, not a page). */
export const CHALLENGE_UNTRUSTED_MAX = 1_000;

/** Cap for scraped directory free text (descriptions). Kept small on
 * purpose: a directory row is a reference card, and long free text is where
 * prompt injection hides. */
export const CRAWL_UNTRUSTED_MAX = 2_000;

function fromEnvCap(): number | undefined {
  const raw = process.env.X402_MAX_UNTRUSTED_CHARS;
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n);
}

export interface UntrustedText {
  text: string;
  truncated: boolean;
  original_bytes: number;
}

/** Strip control characters and ANSI escape sequences and cap the length
 * (issue #63 req 2). Tab and newline are kept (real text formatting); C0
 * controls, DEL, C1 controls and CSI/OSC escape sequences are removed. The
 * original size is recorded BEFORE stripping so callers can still tell that
 * text was dropped. */
export function untrustedText(
  input: string,
  defaultCap: number,
  opts: { cap?: number } = {},
): UntrustedText {
  const originalBytes = input.length; // JS chars, not UTF-8 bytes — close enough for a marker
  // strip ANSI escapes first, then remaining control characters
  let text = input
    // eslint-disable-next-line no-control-regex -- the whole point of this field
    .replace(/\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u0080-\u009f]/g, "");
  const cap = opts.cap ?? fromEnvCap() ?? defaultCap;
  let truncated = false;
  if (text.length > cap) {
    text = text.slice(0, cap);
    truncated = true;
  }
  return { text, truncated, original_bytes: originalBytes };
}

/** Strip + cap without truncation bookkeeping (for log lines). */
export function stripUntrusted(
  input: string,
  cap: number,
): string {
  return untrustedText(input, cap).text;
}