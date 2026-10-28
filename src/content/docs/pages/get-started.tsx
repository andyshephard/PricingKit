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
            <strong>Connect a store.</strong> Choose an App Store Connect API key file or a Google Play service account key. Connecting only reads.
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
            Your store key stays in your browser. It is imported there as a key that can sign but can&apos;t be read back out, and kept until you sign
            out or forget it in Settings. The browser signs short-lived access tokens with it (App Store Connect up to 20 minutes, Google Play up to 1
            hour), and the published code sends the PricingKit server you use only those tokens, which it forwards to Apple or Google; the server
            keeps nothing. A hosted instance also serves the page&apos;s JavaScript, so you still trust its operator to serve the published code;{' '}
            <DocLink to="run-it-yourself">run it yourself</DocLink> to depend on no one else. The <DocLink to="security">Security model</DocLink> has the
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
            On <Link href="/setup">Connect</Link>, choose the <code>.p8</code> file and enter the Key ID and Issuer ID, then pick your app. Connecting and
            switching apps only read from App Store Connect: if the key can&apos;t change prices, you find out on your first edit.
          </p>
          <p>
            App Store Connect API keys work across every app of a team. Before reading or changing a subscription, PricingKit checks it belongs to the
            app you picked (its group must be one of the app&apos;s subscription groups), so a subscription ID from another app is refused.
          </p>
          <Callout>
            Use a dedicated key with only the access PricingKit needs, and revoke it when you are done. The key stays in your browser, which signs a
            20-minute App Store Connect token for each request; PricingKit&apos;s server only receives those tokens. Sign out, or use Forget this key in
            Settings, to remove it from the browser.
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
            On <Link href="/setup">Connect</Link>, choose the JSON key and enter the package name. Connecting and switching apps only read from Google
            Play. The key stays in your browser, which mints Google access tokens (up to 1 hour) at Google&apos;s token endpoint itself; PricingKit&apos;s
            server only receives those tokens. RSA keys of 2048 to 4096 bits are accepted.
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
    'Self-hosting keeps even the short-lived access tokens between you, Apple and Google. PricingKit is a Next.js app that runs on Node or on Cloudflare Workers, with no database and no secret to configure.',
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
            <code>npm run dev</code> and a production build (<code>npm run build</code>, then <code>npm start</code>) work without any configuration:
            store keys stay in each user&apos;s browser, so the server has no secret of its own.
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
          <p>Set any of the optional variables below as Worker secrets, for example:</p>
          <CodeBlock lang="bash" code={`npx --no-install wrangler secret put OPEN_EXCHANGE_RATES_APP_ID`} />
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
              <code key="k">OPEN_EXCHANGE_RATES_APP_ID</code>,
              <>
                Optional operator key for live exchange rates. Users can also save their own key in Settings, which stays in their browser and is sent
                only to the exchange-rate routes. The operator key is never returned to clients, and a forced refresh never spends it (only a
                user&apos;s own key).
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
      id: 'variables-no-longer-used',
      title: 'Variables no longer used',
      level: 3,
      body: (
        <p>
          Earlier versions kept store keys in an encrypted session cookie and needed <code>ENCRYPTION_KEY</code>, with <code>SESSION_VERSION</code>{' '}
          and <code>TRUSTED_CLIENT_IP_HEADER</code> as options. Keys now stay in the browser and the server sets no cookies, so none of the three is
          read any more: delete them from your environment, <code>.dev.vars</code> and Worker secrets (
          <code>npx --no-install wrangler secret delete ENCRYPTION_KEY</code>). After upgrading, every user connects their store once more.
        </p>
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
