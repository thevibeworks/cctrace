import type { TracePair } from "./types";

// Single source of truth for redaction. Every captured pair passes through
// redactPair() before it touches disk (.jsonl), the shareable HTML snapshot, or
// the live WebSocket — so a credential can never reach a sink unredacted.
//
// Why this matters: Claude Code refreshes its OAuth credential (~hourly) against
// an Anthropic host we intercept. That exchange carries access/refresh tokens in
// the *body* (and sometimes auth codes in the *URL*), not just headers. Header-
// only redaction would persist a live refresh token into a file the UI invites
// you to share. That is account-takeover-grade. So we redact headers, bodies,
// and URL query params, uniformly, at one choke point.

// Header names whose values we mask. Substring match (covers x-api-key, etc.).
export const SENSITIVE_HEADERS = ["authorization", "x-api-key", "x-auth-token", "cookie", "set-cookie"];

// Body/URL field names that carry secrets. Matched exactly against JSON object
// keys and URL/query/form param names — NOT as substrings of free text — so
// message payloads (whose keys are role/content/system/tools/...) are untouched.
const CREDENTIAL_KEY = /^(access_token|refresh_token|id_token|client_secret|code|code_verifier|api[-_]?key|apikey|secret|password|session_key|x-api-key)$/i;

// Identity fields: UUIDs, session/device/account IDs. Redacted by default to
// prevent user fingerprinting in shared traces.
const IDENTITY_KEY = /^(device_id|account_uuid|session_id|user_id|machine_id|installation_id|x-claude-code-session-id|x-client-request-id|anthropic-organization-id)$/i;

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_ID_RE = /\b[0-9a-f]{32,64}\b/gi;

// Same names as URL/form params, for masking `?refresh_token=...` and
// `refresh_token=...&...` form bodies.
const CREDENTIAL_PARAM = /(access_token|refresh_token|id_token|client_secret|code|code_verifier|api[-_]?key|apikey|secret|password|session_key)/i;

const MASK = "[REDACTED]";

/** Mask sensitive header values, keeping a first-10/last-4 preview so you can
 *  still tell which key was used without exposing it. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...headers };
  for (const [key, value] of Object.entries(out)) {
    if (SENSITIVE_HEADERS.some((s) => key.toLowerCase().includes(s))) {
      out[key] = value.length > 14 ? `${value.slice(0, 10)}...${value.slice(-4)}` : MASK;
    } else if (IDENTITY_KEY.test(key)) {
      out[key] = maskIds(value);
    }
  }
  return out;
}

function maskIds(s: string): string {
  return s.replace(UUID_RE, (m) => m.slice(0, 8) + "-****-****-****-************")
          .replace(HEX_ID_RE, (m) => m.slice(0, 8) + "..." + m.slice(-4));
}

/** Recursively mask credential and identity keys in a parsed JSON body. Non-mutating. */
function maskObject(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(maskObject);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (CREDENTIAL_KEY.test(k)) out[k] = MASK;
      else if (IDENTITY_KEY.test(k) && typeof val === "string") out[k] = maskIds(val);
      else out[k] = maskObject(val);
    }
    return out;
  }
  return v;
}

/** Mask `name=value` occurrences in a form-encoded / query-ish string. Only
 *  fires on credential param names, so ordinary text bodies pass through. */
function maskFormEncoded(s: string): string {
  return s.replace(
    new RegExp(`((?:^|[?&])${CREDENTIAL_PARAM.source}=)[^&\\s"']+`, "gi"),
    `$1${MASK}`,
  );
}

/** Redact a parsed JSON body (object → key mask) or a raw string body
 *  (form-encoded → param mask). Leaves ordinary content intact. */
export function redactBody(body: unknown): unknown {
  if (body == null) return body;
  if (typeof body === "string") return maskFormEncoded(body);
  if (typeof body === "object") return maskObject(body);
  return body;
}

/** Strip secrets from a URL's query string (e.g. OAuth `?code=...`). */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    let changed = false;
    for (const k of [...u.searchParams.keys()]) {
      if (CREDENTIAL_PARAM.test(k)) {
        u.searchParams.set(k, MASK);
        changed = true;
      }
    }
    return changed ? u.toString() : raw;
  } catch {
    return raw;
  }
}

/** The one function the capture paths call. Returns a new, fully redacted pair;
 *  never mutates the input. */
export function redactPair(pair: TracePair): TracePair {
  const req = pair.request;
  const res = pair.response;
  return {
    ...pair,
    request: {
      ...req,
      url: redactUrl(req.url),
      headers: redactHeaders(req.headers),
      body: redactBody(req.body),
    },
    response: res
      ? {
          ...res,
          headers: redactHeaders(res.headers),
          ...("body" in res ? { body: redactBody(res.body) } : {}),
          ...("bodyRaw" in res ? { bodyRaw: maskFormEncoded(res.bodyRaw ?? "") } : {}),
        }
      : res,
  };
}
