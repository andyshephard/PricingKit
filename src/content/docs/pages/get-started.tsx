import Link from 'next/link';
import { Callout, CodeBlock, DocLink, DocTable } from '@/components/docs/doc-blocks';
import { DEFAULT_SITE_URL } from '@/config/site';
import type { DocPage } from '../types';

export const introduction: DocPage = {
  slug: '',
  title: 'Introduction',
  description:
    'PricingKit is a free, open-source regional pricing tool for the App Store and Google Play. It sets a price for every country from one base price, snaps each one to a real store price, and shows you every change before it is applied.',
  sections: [
    {
      id: 'what-it-does',
      title: 'What it does',
      body: (
        <ul>
          <li>
            <strong>Both stores in one place.</strong> In-app purchases, App Store subscriptions and Google Play base plans, priced by region or
            territory.
          </li>
          <li>
            <strong>Pricing strategies.</strong> PPP (World Bank), the Big Mac index, a Netflix price index, plain currency conversion, or your own
            multiplier per country. See <DocLink to="pricing-strategies">Pricing strategies</DocLink>.
          </li>
          <li>
            <strong>Real store prices.</strong> Every target is snapped to a price the store accepts: each App Store territory&apos;s own price
            points, and Google Play&apos;s own price conversion.
          </li>
          <li>
            <strong>Review before apply.</strong> The web app shows every change (before, after, percent) before it writes anything; the command line
            writes reviewable plan files that are applied only with their hash. See <DocLink to="plans">Plans, confirm and undo</DocLink>.
          </li>
          <li>
            <strong>What existing subscribers see.</strong> Every planned change says whether existing subscribers get a lower price, keep theirs,
            are notified or must consent. See <DocLink to="existing-subscribers">Existing subscribers</DocLink>.
          </li>
          <li>
            <strong>Offers.</strong> App Store promotional offers from a rule, Google Play offers, and rules files that keep offers in step with base
            prices. See <DocLink to="apple-offers">Apple offers</DocLink>.
          </li>
          <li>
            <strong>Headless.</strong> A <code>pricingkit</code> command line (JSON or YAML specs, <code>--json</code> output, exit codes for CI) and an
            MCP server so agents can plan while people apply. See <DocLink to="cli-install">Install and credentials</DocLink>.
          </li>
          <li>
            <strong>Several apps, both stores.</strong> Workspaces plan several App Store bundles and Google Play packages at once, one plan per app,
            and report where the two stores&apos; prices differ. See <DocLink to="workspaces">Workspaces, parity and CSV</DocLink>.
          </li>
          <li>
            <strong>Price export.</strong> Download a product&apos;s or subscription&apos;s current prices as CSV or JSON before you change them.
          </li>
          <li>
            <strong>Public index checker.</strong> Compare regional prices across strategies at <Link href="/index-checker">/index-checker</Link>, no
            sign-in needed.
          </li>
        </ul>
      ),
    },
    {
      id: 'how-it-works',
      title: 'How it works',
      body: (
        <ol>
          <li>
            <strong>Connect a store.</strong> Upload an App Store Connect API key or a Google Play service account key. Connecting only reads.
          </li>
          <li>
            <strong>Pick a strategy and a base price.</strong> PricingKit works out a price for every country in its own currency.
          </li>
          <li>
            <strong>Review the changes.</strong> Each country&apos;s price before and after, snapped to a real store price, with the countries it
            leaves out and why.
          </li>
          <li>
            <strong>Apply.</strong> Only the changes you reviewed are sent. Plans and Google Play bulk updates also leave alone any price that changed since
            you reviewed it.
          </li>
        </ol>
      ),
    },
    {
      id: 'web-app-or-command-line',
      title: 'Web app or command line',
      body: (
        <>
          <p>
            The web app is for looking at prices and changing them by hand or in bulk, App Store in-app purchases and app prices included. The
            command line works with plan files you can review, commit, apply, resume and undo: base prices of App Store subscriptions, Google Play base
            plans and one-time products, and offers on both stores. It is the only way to change offer kinds other than App Store promotional offers.
            It exports App Store in-app purchases but doesn&apos;t plan changes to them.
          </p>
          <p>
            Both use the same framework-free pricing core, so the maths is the same in both.
          </p>
        </>
      ),
    },
    {
      id: 'where-your-credentials-go',
      title: 'Where your credentials go',
      body: (
        <>
          <p>
            Your store credentials are sent to the PricingKit server you use (a hosted instance or your own), kept in an encrypted, HttpOnly cookie
            that expires 24 hours after sign-in, and never stored server-side. Using a hosted instance means trusting its operator with them;{' '}
            <DocLink to="run-it-yourself">run it yourself</DocLink> for full control. The <DocLink to="security">Security model</DocLink> has the
            details.
          </p>
          <p>
            <Link href="/setup">Connect a store</Link> to start, or read <DocLink to="connect-app-store">Connect App Store</DocLink> and{' '}
            <DocLink to="connect-google-play">Connect Google Play</DocLink> first.
          </p>
        </>
      ),
    },
  ],
};

export const connectAppStore: DocPage = {
  slug: 'connect-app-store',
  title: 'Connect App Store',
  description: 'PricingKit uses an App Store Connect API key to read and change prices. Here is what to create and what happens when you connect.',
  sections: [
    {
      id: 'what-you-need',
      title: 'What you need',
      body: (
        <ul>
          <li>An Apple Developer Program membership and at least one app in App Store Connect.</li>
          <li>The Admin or App Manager role in App Store Connect, to create the key.</li>
          <li>
            An App Store Connect API key with <strong>Admin</strong> or <strong>App Manager</strong> access: the <code>.p8</code> private key file,
            its Key ID and your team&apos;s Issuer ID.
          </li>
          <li>Your app&apos;s bundle ID, for example <code>com.example.app</code>.</li>
        </ul>
      ),
    },
    {
      id: 'create-the-key',
      title: 'Create the key',
      body: (
        <>
          <ol>
            <li>
              In App Store Connect, open <strong>Users and Access</strong>, then the <strong>Integrations</strong> tab and{' '}
              <strong>App Store Connect API</strong>.
            </li>
            <li>
              Add a key, name it, choose <strong>Admin</strong> or <strong>App Manager</strong> access and generate it.
            </li>
            <li>
              Download the key straight away. The <code>.p8</code> file can be downloaded only once; if you lose it, revoke the key and make a new one.
            </li>
            <li>Copy the Key ID (10 characters, in the keys list) and the Issuer ID (a UUID, at the top of the same page).</li>
          </ol>
          <p>
            The <Link href="/setup-guide/apple">App Store setup guide</Link> walks through each step in more detail, with where to find the bundle
            ID and troubleshooting.
          </p>
        </>
      ),
    },
    {
      id: 'connecting',
      title: 'Connecting',
      body: (
        <>
          <p>
            On <Link href="/setup">Connect</Link>, upload the <code>.p8</code> file and enter the Key ID and Issuer ID, then pick your app. Connecting and
            switching apps only read from App Store Connect: if the key can&apos;t change prices, you find out on your first edit.
          </p>
          <p>
            App Store Connect API keys work across every app of a team. Before reading or changing a subscription, PricingKit checks it belongs to the
            app you picked (its group must be one of the app&apos;s subscription groups), so a subscription ID from another app is refused.
          </p>
          <Callout>
            Use a dedicated key with only the access PricingKit needs, and revoke it when you are done. Short-lived App Store tokens (JWTs, up to 20
            minutes) are cached in server memory; the session itself ends 24 hours after sign-in.
          </Callout>
        </>
      ),
    },
  ],
};

export const connectGooglePlay: DocPage = {
  slug: 'connect-google-play',
  title: 'Connect Google Play',
  description: 'PricingKit uses a Google Cloud service account, invited to Play Console, to read and change prices.',
  sections: [
    {
      id: 'what-you-need',
      title: 'What you need',
      body: (
        <ul>
          <li>A Google Play Developer account with at least one app (published or in draft) in Play Console.</li>
          <li>Permission to invite users in Play Console.</li>
          <li>
            A Google Cloud project with the <strong>Google Play Android Developer API</strong> enabled, and a service account in it with a JSON key.
          </li>
          <li>Your app&apos;s package name, for example <code>com.example.app</code>.</li>
        </ul>
      ),
    },
    {
      id: 'set-up-the-service-account',
      title: 'Set up the service account',
      body: (
        <>
          <ol>
            <li>In Google Cloud Console, create (or pick) a project and enable the Google Play Android Developer API.</li>
            <li>Create a service account. Skip the optional &quot;Grant access&quot; steps.</li>
            <li>
              On the service account&apos;s <strong>Keys</strong> tab, add a key in <strong>JSON</strong> format. Keep the file safe: it gives access to
              your Play Console.
            </li>
            <li>
              In Play Console, under <strong>Users and permissions</strong>, invite the service account&apos;s email (the <code>client_email</code> in
              the JSON file). You don&apos;t need to link the Cloud project to Play Console.
            </li>
            <li>
              Grant it: view app information, view financial data, manage orders and subscriptions, and, to change prices, manage store presence and
              manage pricing and distribution. Account-wide or for chosen apps only.
            </li>
          </ol>
          <p>
            The <Link href="/setup-guide/google">Google Play setup guide</Link> has each step in detail, where to find the package name, and
            troubleshooting.
          </p>
        </>
      ),
    },
    {
      id: 'connecting',
      title: 'Connecting',
      body: (
        <>
          <p>
            On <Link href="/setup">Connect</Link>, upload the JSON key and enter the package name. Connecting and switching apps only read from Google
            Play. PricingKit keeps only the key&apos;s <code>client_email</code>, <code>private_key_id</code>, <code>private_key</code> and{' '}
            <code>project_id</code>, and accepts RSA keys of 2048 to 4096 bits.
          </p>
          <Callout>
            Google Play price edits change only the regions you edit. Other regions, availability and other base plans are sent back exactly as
            Google returned them, and PricingKit never fills in prices you didn&apos;t set. If Google needs something more, you see Google&apos;s
            error.
          </Callout>
        </>
      ),
    },
  ],
};

export const runItYourself: DocPage = {
  slug: 'run-it-yourself',
  title: 'Run it yourself',
  description:
    'Self-hosting keeps your credentials between you, Apple and Google. PricingKit is a Next.js app that runs on Node or on Cloudflare Workers, with no database.',
  sections: [
    {
      id: 'run-locally',
      title: 'Run locally',
      body: (
        <>
          <p>PricingKit needs Node 22 or later.</p>
          <CodeBlock
            lang="bash"
            code={`git clone https://github.com/andyshephard/PricingKit.git
cd PricingKit
npm ci
npm run dev        # http://localhost:3000`}
          />
          <p>
            <code>npm run dev</code> works without any configuration. A production build (<code>npm run build</code>, then <code>npm start</code>)
            refuses sign-in until <code>ENCRYPTION_KEY</code> is set.
          </p>
        </>
      ),
    },
    {
      id: 'deploy-to-cloudflare-workers',
      title: 'Deploy to Cloudflare Workers',
      body: (
        <>
          <p>The app is built for Cloudflare Workers with OpenNext:</p>
          <CodeBlock
            lang="bash"
            code={`npm run preview   # build and run locally on the Workers runtime (reads .dev.vars)
npm run deploy    # build and deploy with wrangler`}
          />
          <p>Set the variables below as Worker secrets, for example:</p>
          <CodeBlock lang="bash" code={`npx --no-install wrangler secret put ENCRYPTION_KEY`} />
          <p>
            For <code>npm run preview</code>, put them in <code>.dev.vars</code>. <code>NEXT_PUBLIC_SITE_URL</code> is read when the app is built, so set
            it in the build environment instead.
          </p>
          <p>
            Exchange rates are cached for 6 hours in each isolate&apos;s memory (on Node also in <code>.exchange-rates.json</code>). On a Worker served
            from a custom domain they are also kept in Cloudflare&apos;s Cache API, which holds entries per data center; Cloudflare doesn&apos;t
            document that cache for <code>*.workers.dev</code> addresses, so count on the in-memory cache only there.
          </p>
        </>
      ),
    },
    {
      id: 'environment-variables',
      title: 'Environment variables',
      body: (
        <DocTable
          caption="Environment variables"
          head={['Variable', 'What it does']}
          rows={[
            [
              <code key="k">ENCRYPTION_KEY</code>,
              <>
                Required everywhere except <code>next dev</code>. Encrypts session cookies. See <a href="#encryption-key">ENCRYPTION_KEY</a>.
              </>,
            ],
            [
              <code key="k">SESSION_VERSION</code>,
              <>
                Optional. Set it, or change it, to sign everyone out at once. See <a href="#session-version">SESSION_VERSION</a>.
              </>,
            ],
            [
              <code key="k">OPEN_EXCHANGE_RATES_APP_ID</code>,
              <>
                Optional operator key for live exchange rates. Users can also save their own key in Settings. It is never returned to clients, and a
                forced refresh never spends it (only a user&apos;s own key).
              </>,
            ],
            [
              <code key="k">TRUSTED_CLIENT_IP_HEADER</code>,
              <>
                Optional. The header your proxy sets to the real client IP. See <a href="#trusted-client-ip-header">TRUSTED_CLIENT_IP_HEADER</a>.
              </>,
            ],
            [
              <code key="k">NEXT_PUBLIC_SITE_URL</code>,
              <>
                Optional, read at build time. The address the site is served from, for canonical and social-preview URLs and the sitemap. Defaults to{' '}
                <code>{DEFAULT_SITE_URL}</code>. See <a href="#next-public-site-url">NEXT_PUBLIC_SITE_URL</a>.
              </>,
            ],
          ]}
        />
      ),
    },
    {
      id: 'encryption-key',
      title: 'ENCRYPTION_KEY',
      level: 3,
      body: (
        <>
          <p>
            Base64 (or base64url) of at least 32 bytes with at least 16 distinct byte values: what <code>openssl rand -base64 32</code> prints. A random
            64-character hex key also qualifies. Anything else (a passphrase, a short value, a repeated pattern) is refused outside{' '}
            <code>next dev</code>: sign-in fails with a message saying so, and existing sessions read as signed out.
          </p>
          <CodeBlock lang="bash" code={`openssl rand -base64 32`} />
          <Callout tone="warn" title="It checks the format, not randomness.">
            The check refuses obvious repeats but can&apos;t tell whether a key is random. Generate the key; don&apos;t type it.
          </Callout>
          <p>
            Under <code>next dev</code> any key works (with a warning), and without one the session is stored unencrypted for local convenience. Never
            expose a dev server to a network.
          </p>
          <p>
            Rotating the key signs every user out: there is one key and no key ID, so cookies made under the old key no longer decrypt. Rotate it (set a
            new random value and restart or redeploy) when it may have leaked.
          </p>
        </>
      ),
    },
    {
      id: 'session-version',
      title: 'SESSION_VERSION',
      level: 3,
      body: (
        <p>
          Part of every session&apos;s authenticated data. Setting or changing it (any value) signs everyone out without changing the key, for example
          when a copied session cookie must stop working before its 24 hours are up. While it is set, cookies from the legacy formats below are
          refused.
        </p>
      ),
    },
    {
      id: 'trusted-client-ip-header',
      title: 'TRUSTED_CLIENT_IP_HEADER',
      level: 3,
      body: (
        <>
          <p>
            With it set, sign-in is limited to 10 attempts per client per 10 minutes (300 per server instance either way), and testing an Open Exchange
            Rates key without signing in to 5 per client (50 per instance per 10 minutes either way).
          </p>
          <p>
            Values: <code>cf-connecting-ip</code> (Cloudflare, Workers included), <code>x-real-ip</code>, or <code>x-forwarded-for</code> (its last
            entry is used).
          </p>
          <Callout tone="warn">
            Only set it when every request passes through that proxy. Clients can forge these headers, so without the proxy a per-client limit means
            nothing.
          </Callout>
        </>
      ),
    },
    {
      id: 'next-public-site-url',
      title: 'NEXT_PUBLIC_SITE_URL',
      level: 3,
      body: (
        <>
          <p>
            The absolute address of your deployment, used for canonical links, Open Graph and Twitter previews, <code>sitemap.xml</code> and{' '}
            <code>robots.txt</code>. Next.js inlines it at build time. Without it the site uses <code>{DEFAULT_SITE_URL}</code>, so set it when you
            host PricingKit on your own domain:
          </p>
          <CodeBlock example lang="bash" code={`NEXT_PUBLIC_SITE_URL=https://pricing.example.com npm run deploy`} />
          <p>
            For local runs, put <code>NEXT_PUBLIC_SITE_URL=http://localhost:3000</code> in <code>.env.local</code> if you want local absolute URLs.
          </p>
        </>
      ),
    },
    {
      id: 'legacy-session-cutoff',
      title: 'Legacy sessions and the cutoff',
      body: (
        <>
          <p>
            Session cookies written by earlier versions (formats v1 and v2, and cookie names without the <code>__Host-</code> prefix) are read until{' '}
            <strong>2026-11-10 00:00 UTC</strong> and re-written in the current format on the request that reads them, with an expiry no later than
            that date. From then on they are refused, so anyone still on an old cookie signs in again. With a conforming <code>ENCRYPTION_KEY</code>,
            nobody is signed out by the upgrade itself.
          </p>
          <p>
            Rolling back to an older build would not read the new cookies (users sign in again). See the <DocLink to="changelog">Changelog</DocLink>{' '}
            upgrade notes for everything else that changed for self-hosters.
          </p>
        </>
      ),
    },
    {
      id: 'checks',
      title: 'Checks',
      body: (
        <>
          <CodeBlock
            lang="bash"
            code={`npm test            # Vitest
npm run typecheck   # tsc --noEmit
npm run lint        # ESLint`}
          />
          <p>
            CI runs all three on every pull request. Tests never call a live store API: they use fakes and throwaway keys.{' '}
            <a href="https://github.com/andyshephard/PricingKit/blob/main/CONTRIBUTING.md" rel="noopener noreferrer">
              CONTRIBUTING.md
            </a>{' '}
            has the conventions.
          </p>
        </>
      ),
    },
  ],
};
