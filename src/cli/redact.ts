// Output scrubbing. The CLI never prints credentials on purpose; this is the
// backstop for text it doesn't control (upstream error bodies, library
// messages). Every line written to stdout or stderr passes through it.

const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
// A signed JWT (header.payload.signature, base64url, header starts with {")
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

export const REDACTED = '[redacted]';

export class Redactor {
  private secrets: string[] = [];

  /** Remember a secret value. Each line of a multi-line value is also scrubbed on its own. */
  add(value: string | undefined): void {
    if (!value) return;
    const candidates = [value, value.replace(/\\n/g, '\n'), ...value.split(/\\n|\r?\n/)];
    for (const raw of candidates) {
      const candidate = raw.trim();
      // Short fragments (PEM armour, empty lines) would scrub ordinary words
      if (candidate.length >= 8 && !this.secrets.includes(candidate) && !/^-----(BEGIN|END) /.test(candidate)) {
        this.secrets.push(candidate);
      }
    }
    // Longest first, so a whole value is replaced before its pieces
    this.secrets.sort((a, b) => b.length - a.length);
  }

  redact(text: string): string {
    let out = text.replace(PEM_BLOCK, REDACTED).replace(BEARER, `Bearer ${REDACTED}`).replace(JWT, REDACTED);
    for (const secret of this.secrets) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTED);
      // Also the JSON-escaped form, e.g. a key inside an error body
      const escaped = JSON.stringify(secret).slice(1, -1);
      if (escaped !== secret && out.includes(escaped)) out = out.split(escaped).join(REDACTED);
    }
    return out;
  }
}
