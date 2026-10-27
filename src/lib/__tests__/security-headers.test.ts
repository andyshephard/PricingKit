import { describe, it, expect } from 'vitest';
import { contentSecurityPolicy, securityHeaders } from '../security-headers';

describe('security headers', () => {
  it("production CSP: no 'unsafe-eval', base-uri 'none', form-action 'self', no plugins, no framing", () => {
    const csp = contentSecurityPolicy(false);
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("allows 'unsafe-eval' under next dev only", () => {
    expect(contentSecurityPolicy(true)).toContain("'unsafe-eval'");
  });

  it('sends the framing, sniffing, referrer and HSTS headers', () => {
    expect(securityHeaders(false).map((h) => h.key)).toEqual([
      'X-Content-Type-Options',
      'X-Frame-Options',
      'Referrer-Policy',
      'Permissions-Policy',
      'Content-Security-Policy',
      'Strict-Transport-Security',
    ]);
  });
});
