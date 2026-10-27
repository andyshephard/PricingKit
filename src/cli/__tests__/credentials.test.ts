// Credentials come only from env vars and never reach the output. The last
// tests run the real store clients against a stubbed fetch that echoes the
// key and the Authorization header back in its error body, to prove the
// output stays clean even when the upstream misbehaves.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appleCredentialsFromEnv, googleCredentialsFromEnv } from '../credentials';
import { Redactor, REDACTED } from '../redact';
import { run, tempDir, throwawayP8, throwawayRsaPem } from './fixtures';

const BUNDLE = 'com.example.app';
const KEY_ID = 'TESTKEY987';
const ISSUER = '99999999-8888-7777-6666-555555555555';

let p8: string;
let rsa: string;
let tmp: ReturnType<typeof tempDir>;

beforeEach(async () => {
  p8 = await throwawayP8();
  rsa = await throwawayRsaPem();
  tmp = tempDir();
});

afterEach(() => {
  tmp.cleanup();
  vi.unstubAllGlobals();
});

/** Every piece of key material that must never appear in output */
function keyMaterial(pem: string): string[] {
  return pem.split('\n').filter((line) => line.length >= 16 && !line.startsWith('-----'));
}

function expectClean(output: string, secrets: string[]) {
  for (const secret of secrets) expect(output).not.toContain(secret);
  expect(output).not.toMatch(/BEGIN PRIVATE KEY/);
  expect(output).not.toMatch(/Bearer\s+(?!\[redacted\])\S/);
  expect(output).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./);
}

describe('App Store credentials from env', () => {
  it('reads key ID, issuer and an inline key, unescaping \\n', async () => {
    const creds = await appleCredentialsFromEnv(
      { ASC_KEY_ID: KEY_ID, ASC_ISSUER_ID: ISSUER, ASC_PRIVATE_KEY: p8.replace(/\n/g, '\\n') },
      BUNDLE,
      new Redactor()
    );
    expect(creds).toEqual({ keyId: KEY_ID, issuerId: ISSUER, privateKey: p8, bundleId: BUNDLE });
  });

  it('reads the key from ASC_PRIVATE_KEY_PATH', async () => {
    const path = join(tmp.dir, 'AuthKey.p8');
    writeFileSync(path, p8);
    const creds = await appleCredentialsFromEnv({ ASC_KEY_ID: KEY_ID, ASC_ISSUER_ID: ISSUER, ASC_PRIVATE_KEY_PATH: path }, BUNDLE, new Redactor());
    expect(creds.privateKey).toBe(p8);
  });

  it('names the missing variables, never values', async () => {
    await expect(appleCredentialsFromEnv({ ASC_KEY_ID: KEY_ID }, BUNDLE, new Redactor())).rejects.toThrow(
      'Missing App Store Connect credentials: set ASC_ISSUER_ID, ASC_PRIVATE_KEY or ASC_PRIVATE_KEY_PATH'
    );
    await expect(
      appleCredentialsFromEnv({ ASC_KEY_ID: KEY_ID, ASC_ISSUER_ID: ISSUER, ASC_PRIVATE_KEY: p8, ASC_PRIVATE_KEY_PATH: '/x' }, BUNDLE, new Redactor())
    ).rejects.toThrow('Set only one of ASC_PRIVATE_KEY and ASC_PRIVATE_KEY_PATH');
    await expect(
      appleCredentialsFromEnv({ ASC_KEY_ID: KEY_ID, ASC_ISSUER_ID: ISSUER, ASC_PRIVATE_KEY_PATH: join(tmp.dir, 'missing.p8') }, BUNDLE, new Redactor())
    ).rejects.toThrow("Can't read the file named by ASC_PRIVATE_KEY_PATH (ENOENT)");
  });

  it('ignores credential-looking flags: there are none', async () => {
    const r = await run(['export', '--bundle-id', BUNDLE, '--subscription', '1', '--private-key', p8]);
    expect(r.code).toBe(1);
    expectClean(r.stdout + r.stderr, keyMaterial(p8));
  });
});

describe('Google Play credentials from env', () => {
  const account = () => ({ type: 'service_account', client_email: 'robot@example-project.iam.gserviceaccount.com', private_key_id: 'kid-0123456789', private_key: rsa });

  it('reads inline JSON or a key file', async () => {
    expect((await googleCredentialsFromEnv({ GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(account()) }, new Redactor())).private_key).toBe(rsa);
    const path = join(tmp.dir, 'sa.json');
    writeFileSync(path, JSON.stringify(account()));
    expect((await googleCredentialsFromEnv({ GOOGLE_APPLICATION_CREDENTIALS: path }, new Redactor())).client_email).toBe(account().client_email);
  });

  it('refuses both, neither, bad JSON and missing fields without quoting the input', async () => {
    await expect(googleCredentialsFromEnv({}, new Redactor())).rejects.toThrow(/set GOOGLE_APPLICATION_CREDENTIALS .* or GOOGLE_SERVICE_ACCOUNT_JSON/);
    await expect(googleCredentialsFromEnv({ GOOGLE_APPLICATION_CREDENTIALS: '/x', GOOGLE_SERVICE_ACCOUNT_JSON: '{}' }, new Redactor())).rejects.toThrow(/only one/);
    const broken = `{"private_key": "${rsa.slice(0, 80)}`;
    const error = await googleCredentialsFromEnv({ GOOGLE_SERVICE_ACCOUNT_JSON: broken }, new Redactor()).catch((e: Error) => e);
    expect((error as Error).message).toBe('The service account key in GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON');
    const { private_key_id: _omit, ...partial } = account();
    const missing = await googleCredentialsFromEnv({ GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(partial) }, new Redactor()).catch((e: Error) => e);
    expect((missing as Error).message).toBe('The service account key in GOOGLE_SERVICE_ACCOUNT_JSON is missing or has invalid fields: private_key_id');
  });
});

describe('Redactor', () => {
  it('scrubs registered secrets, their lines and JSON-escaped forms, PEM blocks, bearer tokens and JWTs', () => {
    const r = new Redactor();
    r.add(p8);
    r.add(KEY_ID);
    const line = keyMaterial(p8)[1];
    expect(r.redact(`key ${KEY_ID} line ${line}`)).toBe(`key ${REDACTED} line ${REDACTED}`);
    expect(r.redact(JSON.stringify({ body: p8 }))).not.toContain(line);
    const label = ['EC', 'PRIVATE', 'KEY'].join(' ');
    expect(r.redact(`-----BEGIN ${label}-----\nabc\n-----END ${label}-----`)).toBe(REDACTED);
    expect(r.redact('Authorization: Bearer ya29.abc-def')).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(r.redact('token eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJ4In0.c2lnbmF0dXJl here')).toBe(`token ${REDACTED} here`);
  });

  it('leaves short fragments alone', () => {
    const r = new Redactor();
    r.add('abc');
    expect(r.redact('abc')).toBe('abc');
  });
});

describe('no key material in output, with the real store clients', () => {
  it('App Store: an error body echoing the key and the Authorization header is redacted', async () => {
    const seen: Array<{ url: string; authorization: string | null }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const authorization = new Headers(init.headers).get('Authorization');
        seen.push({ url, authorization });
        const detail = `bad key ${KEY_ID} ${ISSUER} ${authorization} ${p8}`;
        return new Response(JSON.stringify({ errors: [{ status: '401', code: 'NOT_AUTHORIZED', title: 'Unauthorized', detail }] }), { status: 401 });
      })
    );
    const env = { ASC_KEY_ID: KEY_ID, ASC_ISSUER_ID: ISSUER, ASC_PRIVATE_KEY: p8 };
    for (const json of [false, true]) {
      const r = await run(['export', '--bundle-id', BUNDLE, '--subscription', '1234567890', ...(json ? ['--json'] : [])], { env });
      expect(r.code).toBe(1);
      const output = r.stdout + r.stderr;
      expect(output).toContain('NOT_AUTHORIZED');
      expectClean(output, [KEY_ID, ISSUER, ...keyMaterial(p8), seen[0].authorization!.slice(7)]);
    }
    // A JWT was really minted and sent: the redaction above is what kept it out
    expect(seen[0].url).toMatch(/^https:\/\/api\.appstoreconnect\.apple\.com\//);
    expect(seen[0].authorization).toMatch(/^Bearer eyJ/);
  });

  it('Google Play: an error body echoing the service account key is redacted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('oauth2') || url.includes('/token')) {
          return new Response(JSON.stringify({ access_token: 'ya29.fake-access-token-value', expires_in: 3600, token_type: 'Bearer' }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: `denied for kid-0123456789 ${rsa}` } }), { status: 403 });
      })
    );
    const account = { type: 'service_account', client_email: 'robot@example-project.iam.gserviceaccount.com', private_key_id: 'kid-0123456789', private_key: rsa };
    const path = join(tmp.dir, 'sa.json');
    writeFileSync(path, JSON.stringify(account));
    const r = await run(['export', '--package-name', 'com.example.app', '--subscription', 'pro', '--base-plan', 'annual', '--json'], {
      env: { GOOGLE_APPLICATION_CREDENTIALS: path },
    });
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toContain('PERMISSION_DENIED');
    expectClean(r.stdout + r.stderr, ['kid-0123456789', ...keyMaterial(rsa)]);
  });
});
