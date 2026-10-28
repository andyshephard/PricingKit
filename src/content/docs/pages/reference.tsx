import { Callout, DocLink } from '@/components/docs/doc-blocks';
import { MarkdownView } from '@/components/docs/markdown-view';
import { GITHUB_URL } from '@/config/site';
import { parseMarkdown, type Block } from '@/lib/docs/markdown';
import changelogSource from '../../../../CHANGELOG.md';
import type { DocPage, DocSection } from '../types';

export const security: DocPage = {
  slug: 'security',
  title: 'Security model',
  description: 'How PricingKit keeps your store keys in your browser, what the server enforces, and how to report a vulnerability.',
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
            service account JSON key. The private key never leaves your browser.
          </p>
          <ol>
            <li>
              <strong>Import in the browser.</strong> When you connect, the browser reads the key file and imports the private key with the Web Crypto
              API as a <em>non-extractable</em> key: it can sign, but no script, PricingKit&apos;s own included, can read it back out. The file&apos;s
              text is then dropped. The key and its non-secret IDs (Key ID and Issuer ID, or the service account&apos;s email, key ID and project) are
              kept in this browser&apos;s IndexedDB.
            </li>
            <li>
              <strong>Proved before it is kept.</strong> The new key is first held in memory only and proved with one read-only call (listing your
              apps, or reading one subscription of the Google Play app). Only if the store accepts it is it stored, replacing any earlier key; if not,
              it is dropped and the earlier key stays as it was.
            </li>
            <li>
              <strong>Short-lived tokens.</strong> For each request the browser signs a token: an App Store Connect JWT (ES256, valid for 20 minutes)
              or, for Google Play, a signed assertion that the browser itself exchanges at Google&apos;s token endpoint for an access token (valid for
              up to 1 hour). The PricingKit server only ever receives these tokens, in request headers (<code>X-PK-Apple-Token</code>,{' '}
              <code>X-PK-Google-Token</code>, with the app in <code>X-PK-App</code>). App Store Connect doesn&apos;t accept calls from browsers, so
              the server forwards each call to Apple or Google with the token and keeps nothing: no session, no cookie, no stored credential.
            </li>
            <li>
              <strong>Checked, not trusted.</strong> Before using an App Store Connect token the server checks its shape: a JWT signed with ES256, for
              App Store Connect, valid for at most 20 minutes, not expired and not issued in the future. These checks save a pointless call; Apple and
              Google verify every token. Tokens and these headers are never logged, cached or echoed.
            </li>
            <li>
              <strong>Long requests.</strong> Writes, applies, bulk updates and exports ask the browser for a token with most of its life left, and the
              server refuses an App Store Connect token with under 10 minutes left for them, so a token can&apos;t expire halfway through.
            </li>
            <li>
              <strong>Connecting is read-only.</strong> Connecting or switching apps only lists data. If the key lacks pricing-write permission, you
              find out on your first edit.
            </li>
            <li>
              <strong>Kept until you remove it.</strong> The key stays in this browser profile until you <strong>Sign out</strong> (both keys) or use{' '}
              <strong>Forget this key</strong> in Settings. Signing out in one tab signs the other tabs out too. On a shared computer, always sign out.
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
              browser, so no other site can make a visitor&apos;s browser send it; it is allowed and still needs a store token where the route does.
              The token headers also force a CORS preflight, which these routes never grant, so this check is a second layer.
            </li>
            <li>
              take a body only as <code>application/json</code> (<code>415</code> otherwise), so a cross-site HTML form can&apos;t sign a visitor in to
              an attacker&apos;s account.
            </li>
            <li>
              are size-limited: 16 KB for connecting and app switching, 1 MB for store edits, plans, applies and bulk updates (<code>413</code>),
              by <code>Content-Length</code> and by the bytes actually read.
            </li>
          </ul>
          <p>
            Every response carries a Content-Security-Policy (no <code>eval</code> outside <code>next dev</code>, no <code>&lt;base&gt;</code> changes,
            forms only to this site, no plugins, no framing), <code>X-Frame-Options: DENY</code>, <code>nosniff</code>, a strict referrer policy and
            HSTS. The policy lets the page connect only to this site, Google&apos;s token endpoint and Open Exchange Rates. Inline scripts and styles
            are still allowed (Next.js inlines its bootstrap code; a nonce-based policy is planned).
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
            The optional Open Exchange Rates key entered in Settings is tested from your browser against Open Exchange Rates, kept in this
            browser&apos;s local storage, and sent (in <code>X-PK-OER-Key</code>) only with requests to the exchange-rate routes (
            <code>/api/exchange-rates</code>, <code>/api/ppp</code>). Rates fetched with it are returned to you only, never cached for other visitors,
            and such fetches are rate limited per server instance. Signing out deletes it. Settings only ever shows its last four characters. An
            operator key set through <code>OPEN_EXCHANGE_RATES_APP_ID</code> is never returned to clients.
          </li>
          <li>The selected app (bundle ID or package name) is kept in this browser&apos;s local storage. It isn&apos;t secret.</li>
          <li>
            Signing out deletes both store keys, that key and the app selection. If the browser can&apos;t delete the keys, it says so instead of
            looking signed out.
          </li>
          <li>
            The public endpoints (<code>/api/ppp</code>, <code>/api/exchange-rates</code>, <code>/index-checker</code>) need no sign-in. Forcing an
            upstream refresh with <code>?refresh=true</code> needs a store token header (<code>403</code> otherwise). That is a speed bump, not
            authentication: a refresh never spends the operator&apos;s Open Exchange Rates key, and World Bank data is refreshed at most every 10
            minutes.
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
            <strong>Hosted instance.</strong> Your private key stays in your browser, so the operator never has it. The server does see the
            short-lived tokens it forwards: a dishonest or compromised operator could misuse a token until it expires (at most 20 minutes for App
            Store Connect, 1 hour for Google Play), but could not keep access after that or make new tokens. Use a dedicated API key with only the
            permissions PricingKit needs, and revoke it when you are done.
          </p>
          <p>
            <strong>Self-hosted.</strong> You run the server, so even the tokens never reach a third party apart from Apple and Google. This is the
            recommended setup for production accounts. See <DocLink to="run-it-yourself">Run it yourself</DocLink>.
          </p>
        </>
      ),
    },
    {
      id: 'remaining-risks',
      title: 'Remaining risks',
      body: (
        <>
          <ul>
            <li>
              <strong>Script injected into the page.</strong> It couldn&apos;t read the key (it is non-extractable), but while the tab is open it
              could ask the browser to sign tokens and use them. The Content-Security-Policy is the main defence.
            </li>
            <li>
              <strong>Shared computers.</strong> The key stays in that browser profile until you sign out or forget it.
            </li>
          </ul>
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
