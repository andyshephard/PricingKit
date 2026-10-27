import { Callout, DocLink } from '@/components/docs/doc-blocks';
import { MarkdownView } from '@/components/docs/markdown-view';
import { GITHUB_URL } from '@/config/site';
import { parseMarkdown, type Block } from '@/lib/docs/markdown';
import changelogSource from '../../../../CHANGELOG.md';
import type { DocPage, DocSection } from '../types';

export const security: DocPage = {
  slug: 'security',
  title: 'Security model',
  description: 'How PricingKit handles your store credentials, what the server enforces, and how to report a vulnerability.',
  sections: [
    {
      id: 'reporting-a-vulnerability',
      title: 'Reporting a vulnerability',
      body: (
        <>
          <p>
            Report security issues privately through GitHub&apos;s private vulnerability reporting:{' '}
            <a href={`${GITHUB_URL}/security/advisories/new`} rel="noopener noreferrer">
              Report a vulnerability
            </a>
            . Do not open a public issue. Include the affected version or commit, steps to reproduce, and the impact you expect. You should get an
            acknowledgement within a few days. Fixes are released on <code>main</code> and credited in the advisory unless you prefer otherwise.
          </p>
          <p>Only the latest <code>main</code> is supported.</p>
        </>
      ),
    },
    {
      id: 'how-credentials-are-handled',
      title: 'How credentials are handled',
      body: (
        <>
          <p>
            PricingKit needs store API credentials: an App Store Connect API key (<code>.p8</code> private key, Key ID, Issuer ID) and/or a Google Play
            service account JSON key.
          </p>
          <ol>
            <li>
              <strong>Upload.</strong> The browser sends the credentials over HTTPS to the PricingKit server you are using. They do leave your browser:
              the server makes the Apple and Google API calls.
            </li>
            <li>
              <strong>Session cookie.</strong> The server validates them with a read-only API call and keeps only the fields it needs (for Google:{' '}
              <code>client_email</code>, <code>private_key_id</code>, <code>private_key</code>, <code>project_id</code>). It seals them in an envelope
              with the session type, the time issued and an absolute expiry 24 hours later, encrypts that with AES-256-GCM under a key derived from{' '}
              <code>ENCRYPTION_KEY</code> (HKDF-SHA-256 over the key&apos;s bytes), with the cookie&apos;s name and the session version as additional
              authenticated data, and returns it in an <code>HttpOnly</code>, <code>SameSite=Strict</code>, <code>Secure</code> cookie named with the{' '}
              <code>__Host-</code> prefix (in production). Page JavaScript can&apos;t read it.
            </li>
            <li>
              <strong>The server enforces the 24 hours.</strong> A copied cookie stops working when its envelope expires, whatever the browser does,
              and nothing extends it. One kind of session can&apos;t be used as another. Credentials too large for a cookie (about 4 KB) are refused at
              sign-in instead of being silently dropped by the browser.
            </li>
            <li>
              <strong>Per request.</strong> Each request sends the cookie back. The server decrypts it in memory, calls Apple or Google, and discards the
              plaintext. Credentials are not written to disk, a database, or logs.
            </li>
            <li>
              <strong>Token cache.</strong> Short-lived tokens (App Store JWTs, up to 20 minutes; Google access tokens, up to 1 hour) are cached in
              server memory, keyed by a SHA-256 hash of the full credential, private key included, at most 50 entries. Two users whose keys share a Key
              ID or client email never share a token.
            </li>
            <li>
              <strong>Sign-in is read-only.</strong> Connecting or switching apps only lists data. Google keys are accepted only as RSA keys of 2048 to
              4096 bits (checked before the key is imported), and sign-in is rate limited: 10 attempts per client per 10 minutes when{' '}
              <code>TRUSTED_CLIENT_IP_HEADER</code> is set, and 300 per server instance.
            </li>
            <li>
              <strong>
                <code>ENCRYPTION_KEY</code> is required, and should be random.
              </strong>{' '}
              The server checks its format (base64 of at least 32 bytes with at least 16 distinct byte values); without it, or with anything else, it
              refuses to create or read sessions. The check can&apos;t tell whether a key is random: generate it, don&apos;t type it. The only exception
              is <code>next dev</code>. See <DocLink to="run-it-yourself#encryption-key">Run it yourself</DocLink>.
            </li>
            <li>
              <strong>Cookies from earlier versions</strong> are read until 2026-11-10 00:00 UTC and re-written in the current format; from then on they
              are refused. Under an old cookie name only an old-format cookie is accepted: a current-format session found there was planted (a sibling
              subdomain can set unprefixed cookies) and is refused. Anything that isn&apos;t a well-formed cookie of a plausible size is refused before
              any key is derived. Legacy cookies are refused at once when <code>SESSION_VERSION</code> is set.
            </li>
          </ol>
        </>
      ),
    },
    {
      id: 'requests-that-change-something',
      title: 'Requests that change something',
      body: (
        <>
          <p>
            <code>POST</code>, <code>PUT</code>, <code>PATCH</code> and <code>DELETE</code> requests:
          </p>
          <ul>
            <li>
              must come from the app&apos;s own pages: a browser request whose <code>Sec-Fetch-Site</code> isn&apos;t <code>same-origin</code>, or whose{' '}
              <code>Origin</code> names another host, is refused with <code>403</code>. A request with neither header (curl, a script) is not from a
              browser, so no other site can make a visitor&apos;s browser send it; it is allowed and still needs a session where the route does.
            </li>
            <li>
              take a body only as <code>application/json</code> (<code>415</code> otherwise), so a cross-site HTML form can&apos;t sign a visitor in to
              an attacker&apos;s account or plant an Open Exchange Rates key.
            </li>
            <li>
              are size-limited: 16 KB for sign-in, app switching and settings, 1 MB for store edits, plans, applies and bulk updates (<code>413</code>),
              by <code>Content-Length</code> and by the bytes actually read.
            </li>
          </ul>
          <p>
            Every response carries a Content-Security-Policy (no <code>eval</code> outside <code>next dev</code>, no <code>&lt;base&gt;</code> changes,
            forms only to this site, no plugins, no framing), <code>X-Frame-Options: DENY</code>, <code>nosniff</code>, a strict referrer policy and
            HSTS. Inline scripts and styles are still allowed (Next.js inlines its bootstrap code; a nonce-based policy is planned).
          </p>
        </>
      ),
    },
    {
      id: 'other-data',
      title: 'Other data',
      body: (
        <ul>
          <li>
            The optional Open Exchange Rates key entered in Settings is stored in an <code>HttpOnly</code> cookie (<code>__Host-</code> prefixed in
            production) for up to a year and sent to the server on each request. Signing out deletes it. Settings only ever shows its last four
            characters. An operator key set through <code>OPEN_EXCHANGE_RATES_APP_ID</code> is never returned to clients.
          </li>
          <li>
            Signing out clears both store sessions, that key and the tab&apos;s &quot;verified&quot; flag, and reports a sign-out the server didn&apos;t
            confirm instead of looking done.
          </li>
          <li>
            The public endpoints (<code>/api/ppp</code>, <code>/api/exchange-rates</code>, <code>/index-checker</code>) need no sign-in. Forcing an
            upstream refresh with <code>?refresh=true</code> needs a valid App Store or Google Play session (<code>401</code> otherwise).
          </li>
        </ul>
      ),
    },
    {
      id: 'command-line-and-agents',
      title: 'Command line and agents',
      body: (
        <>
          <p>
            The command line takes credentials only from environment variables, holds them in memory, and scrubs everything it prints or writes to a
            run log. Only <code>apply</code> writes to a store, only with the plan&apos;s hash, and at a terminal only after you type the app&apos;s ID.
            See <DocLink to="cli-install">Install and credentials</DocLink>.
          </p>
          <p>
            The MCP server has no apply tool and leaves confirm hashes out of its output. That is a speed bump, not a gate: an agent that can run code
            can recompute a hash. The typed confirmation at a terminal is the gate. See <DocLink to="agents">Agents (MCP)</DocLink>.
          </p>
        </>
      ),
    },
    {
      id: 'hosted-vs-self-hosted',
      title: 'Hosted or self-hosted',
      body: (
        <>
          <p>
            <strong>Hosted instance.</strong> Your credentials pass through, and are decrypted in the memory of, a server you don&apos;t control. The
            code doesn&apos;t store them, but you are trusting the operator to run the published code with a secret <code>ENCRYPTION_KEY</code>. Use a
            dedicated API key with only the permissions PricingKit needs, and revoke it when you are done.
          </p>
          <p>
            <strong>Self-hosted.</strong> You control the server, <code>ENCRYPTION_KEY</code> and logs, so credentials never reach a third party apart
            from Apple and Google. This is the recommended setup for production accounts. See{' '}
            <DocLink to="run-it-yourself">Run it yourself</DocLink>.
          </p>
          <Callout>
            This page follows <code>SECURITY.md</code> in the repository, which is the authoritative policy.
          </Callout>
        </>
      ),
    },
  ],
};

/** Splits the changelog into sections at its ## and ### headings */
function changelogPage(source: string): DocPage {
  const blocks = parseMarkdown(source);
  const intro: Block[] = [];
  const sections: DocSection[] = [];
  let current: { id: string; title: string; level: 2 | 3; blocks: Block[] } | null = null;
  const push = () => {
    if (current) sections.push({ id: current.id, title: current.title, level: current.level, body: <MarkdownView blocks={current.blocks} /> });
  };
  for (const block of blocks) {
    if (block.type === 'heading' && block.level === 1) continue;
    if (block.type === 'heading' && (block.level === 2 || block.level === 3)) {
      push();
      current = { id: block.id, title: block.text, level: block.level, blocks: [] };
      continue;
    }
    (current ? current.blocks : intro).push(block);
  }
  push();
  return {
    slug: 'changelog',
    title: 'Changelog',
    description: 'Every user-visible change to PricingKit, newest first, from CHANGELOG.md in the repository.',
    intro: <MarkdownView blocks={intro} />,
    sections,
  };
}

export const changelog: DocPage = changelogPage(changelogSource);
