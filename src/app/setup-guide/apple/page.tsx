'use client';

import Link from 'next/link';
import {
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';

function StepNumber({ num }: { num: number }) {
  return (
    <div className="flex-shrink-0 size-9 rounded-full bg-accent text-accent-foreground flex items-center justify-center text-sm font-extrabold">
      {num}
    </div>
  );
}

export default function AppleSetupGuidePage() {
  return (
    <article className="min-w-0 max-w-[740px]">
        <p className="text-[13px] font-semibold text-accent-foreground">Setup guide</p>
        <h1 className="mt-2 text-[32px] leading-tight font-extrabold tracking-[-0.02em] sm:text-[40px]">Set up App Store Connect</h1>
        <p className="mt-4 text-[18px] leading-[1.7] text-soft">Create an API key with the right role, then connect it to PricingKit.</p>

        <div className="mt-10 space-y-12">
          {/* Prerequisites */}
          <Card>
            <CardHeader>
              <h2 className="text-2xl font-bold tracking-tight">Prerequisites</h2>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2">
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="h-5 w-5 text-success-foreground mt-0.5 flex-shrink-0" />
                  <span>
                    An Apple Developer Program membership ($99/year)
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="h-5 w-5 text-success-foreground mt-0.5 flex-shrink-0" />
                  <span>At least one app in App Store Connect</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="h-5 w-5 text-success-foreground mt-0.5 flex-shrink-0" />
                  <span>
                    Admin or App Manager role in App Store Connect
                  </span>
                </li>
              </ul>
            </CardContent>
          </Card>

          {/* Step 1 */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <StepNumber num={1} />
                <h2 className="text-2xl font-bold tracking-tight">
                  Navigate to API Keys
                </h2>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <ol className="list-decimal space-y-3 pl-5 text-[15px] leading-relaxed text-soft">
                <li>
                  Go to{' '}
                  <a
                    href="https://appstoreconnect.apple.com/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-semibold text-link hover:underline"
                  >
                    App Store Connect
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                </li>
                <li>
                  Click on <Badge variant="secondary">Users and Access</Badge>{' '}
                  in the top navigation
                </li>
                <li>
                  Select the <Badge variant="secondary">Integrations</Badge> tab
                </li>
                <li>
                  Click on{' '}
                  <Badge variant="secondary">App Store Connect API</Badge>
                </li>
              </ol>
            </CardContent>
          </Card>

          {/* Step 2 */}
          <Card className="border-primary">
            <CardHeader>
              <div className="flex items-center gap-3">
                <StepNumber num={2} />
                <div>
                  <h2 className="text-2xl font-bold tracking-tight">Generate API Key</h2>
                  <p className="text-sm text-muted-foreground mt-1">
                    This is the most important step!
                  </p>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <ol className="list-decimal space-y-3 pl-5 text-[15px] leading-relaxed text-soft">
                <li>
                  Click the{' '}
                  <Badge variant="secondary">+</Badge> button to create a new
                  key
                </li>
                <li>
                  Enter a name for your key (e.g., &quot;Pricing Manager&quot;)
                </li>
                <li>
                  Select <strong>Admin</strong> or <strong>App Manager</strong>{' '}
                  access level
                </li>
                <li>
                  Click <Badge variant="secondary">Generate</Badge>
                </li>
                <li>
                  <strong>IMPORTANT:</strong> Click{' '}
                  <Badge variant="secondary">Download API Key</Badge>{' '}
                  immediately
                </li>
              </ol>

              <div className="rounded-xl border border-warn-border bg-warn p-4 mt-4">
                <div className="flex gap-2">
                  <AlertTriangle className="h-5 w-5 text-warn-foreground flex-shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-warn-foreground">
                      One-Time Download Warning
                    </p>
                    <p className="text-sm text-warn-foreground mt-1">
                      The .p8 key file can only be downloaded once! If you lose
                      it, you&apos;ll need to generate a new key. Store it
                      securely.
                    </p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Step 3 */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <StepNumber num={3} />
                <h2 className="text-2xl font-bold tracking-tight">Copy Your Key ID</h2>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                After generating the key, you&apos;ll see it in the keys list.
              </p>
              <ol className="list-decimal space-y-3 pl-5 text-[15px] leading-relaxed text-soft">
                <li>Find your newly created key in the list</li>
                <li>
                  The <strong>Key ID</strong> is displayed in the table
                  (10-character alphanumeric code)
                </li>
                <li>Copy this Key ID - you&apos;ll need it to connect</li>
              </ol>

              <div className="rounded-xl bg-chip p-4 font-mono text-sm">
                Example Key ID: <code>ABC123DEF4</code>
              </div>
            </CardContent>
          </Card>

          {/* Step 4 */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <StepNumber num={4} />
                <h2 className="text-2xl font-bold tracking-tight">Copy Your Issuer ID</h2>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                The Issuer ID is shared across all API keys for your team.
              </p>
              <ol className="list-decimal space-y-3 pl-5 text-[15px] leading-relaxed text-soft">
                <li>
                  On the same API Keys page, look at the top of the page
                </li>
                <li>
                  You&apos;ll see <strong>Issuer ID</strong> displayed (UUID
                  format)
                </li>
                <li>Copy this Issuer ID - you&apos;ll need it to connect</li>
              </ol>

              <div className="rounded-xl bg-chip p-4 font-mono text-sm break-all">
                Example Issuer ID:{' '}
                <code>xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx</code>
              </div>
            </CardContent>
          </Card>

          {/* Step 5 */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <StepNumber num={5} />
                <h2 className="text-2xl font-bold tracking-tight">Find Your Bundle ID</h2>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Your Bundle ID uniquely identifies your app. It looks like:{' '}
                <code className="rounded-md bg-chip px-1.5 py-0.5 font-mono text-xs text-foreground">
                  com.company.appname
                </code>
              </p>

              <Accordion type="single" collapsible className="w-full">
                <AccordionItem value="method1">
                  <AccordionTrigger className="text-sm">
                    Method 1: From App Store Connect
                  </AccordionTrigger>
                  <AccordionContent className="text-sm text-muted-foreground">
                    <ol className="list-decimal list-inside space-y-2">
                      <li>Go to App Store Connect</li>
                      <li>Select your app</li>
                      <li>
                        Go to <strong>App Information</strong> under General
                      </li>
                      <li>The Bundle ID is shown at the top</li>
                    </ol>
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="method2">
                  <AccordionTrigger className="text-sm">
                    Method 2: From Xcode
                  </AccordionTrigger>
                  <AccordionContent className="text-sm text-muted-foreground">
                    <ol className="list-decimal list-inside space-y-2">
                      <li>Open your project in Xcode</li>
                      <li>Select your project in the navigator</li>
                      <li>Select your app target</li>
                      <li>
                        The Bundle Identifier is in the{' '}
                        <strong>General</strong> tab
                      </li>
                    </ol>
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="method3">
                  <AccordionTrigger className="text-sm">
                    Method 3: From Info.plist
                  </AccordionTrigger>
                  <AccordionContent className="text-sm text-muted-foreground">
                    <p className="mb-2">
                      Check your app&apos;s Info.plist or project.pbxproj:
                    </p>
                    <pre className="overflow-x-auto rounded-xl border border-line bg-code p-4 font-mono text-xs leading-[1.7] text-code-foreground">
                      {`PRODUCT_BUNDLE_IDENTIFIER = com.yourcompany.yourapp`}
                    </pre>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </CardContent>
          </Card>

          {/* Permissions */}
          <Card>
            <CardHeader>
              <h2 className="text-2xl font-bold tracking-tight">Required Permissions</h2>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Your API key needs the following permissions:
              </p>

              <div className="space-y-4">
                <div>
                  <h4 className="font-medium mb-2">
                    Admin Access (Recommended)
                  </h4>
                  <ul className="space-y-2 text-sm">
                    <li className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-success-foreground" />
                      Full access to all App Store Connect features
                    </li>
                    <li className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-success-foreground" />
                      Manage In-App Purchases and Subscriptions
                    </li>
                    <li className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-success-foreground" />
                      View and modify pricing
                    </li>
                  </ul>
                </div>

                <div>
                  <h4 className="font-medium mb-2">
                    App Manager Access (Minimum)
                  </h4>
                  <ul className="space-y-2 text-sm">
                    <li className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-success-foreground" />
                      View app information
                    </li>
                    <li className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-success-foreground" />
                      Manage In-App Purchases
                    </li>
                    <li className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-success-foreground" />
                      Manage Subscriptions
                    </li>
                  </ul>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Ready */}
          <Card className="bg-success border-line">
            <CardContent className="pt-6">
              <div className="flex items-center gap-3 mb-4">
                <CheckCircle2 className="h-8 w-8 text-success-foreground" />
                <div>
                  <h3 className="font-semibold text-lg">You&apos;re Ready!</h3>
                  <p className="text-sm text-muted-foreground">
                    You now have everything needed to connect
                  </p>
                </div>
              </div>

              <div className="rounded-xl bg-chip p-4 mb-4">
                <p className="text-sm font-medium mb-2">Checklist:</p>
                <ul className="space-y-1 text-sm text-muted-foreground">
                  <li className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-success-foreground" />
                    .p8 key file downloaded
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-success-foreground" />
                    Key ID copied
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-success-foreground" />
                    Issuer ID copied
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-success-foreground" />
                    Bundle ID known
                  </li>
                </ul>
              </div>

              <Button asChild className="w-full">
                <Link href="/setup">Go to Connect Page</Link>
              </Button>
            </CardContent>
          </Card>

          {/* Troubleshooting */}
          <Card>
            <CardHeader>
              <h2 className="text-2xl font-bold tracking-tight">Troubleshooting</h2>
            </CardHeader>
            <CardContent>
              <Accordion type="single" collapsible className="w-full">
                <AccordionItem value="invalid-key">
                  <AccordionTrigger className="text-sm">
                    &quot;Invalid credentials&quot; error
                  </AccordionTrigger>
                  <AccordionContent className="text-sm text-muted-foreground space-y-2">
                    <p>The .p8 key file may be invalid or corrupted.</p>
                    <ol className="list-decimal list-inside space-y-1">
                      <li>
                        Verify you&apos;re choosing the .p8 file (not .cer or
                        .pem)
                      </li>
                      <li>
                        The file should start with{' '}
                        <code className="rounded-md bg-chip px-1 font-mono text-foreground">
                          -----BEGIN PRIVATE KEY-----
                        </code>
                      </li>
                      <li>
                        Check that Key ID and Issuer ID match what&apos;s shown
                        in App Store Connect
                      </li>
                      <li>
                        If needed, generate a new API key and download it again
                      </li>
                    </ol>
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="access-denied">
                  <AccordionTrigger className="text-sm">
                    &quot;Access denied&quot; error
                  </AccordionTrigger>
                  <AccordionContent className="text-sm text-muted-foreground space-y-2">
                    <p>The API key doesn&apos;t have sufficient permissions.</p>
                    <ol className="list-decimal list-inside space-y-1">
                      <li>Go to App Store Connect &gt; Users and Access</li>
                      <li>Check your API key&apos;s access level</li>
                      <li>
                        Ensure it has Admin or App Manager access
                      </li>
                      <li>
                        If you changed permissions, you may need to generate a
                        new key
                      </li>
                    </ol>
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="app-not-found">
                  <AccordionTrigger className="text-sm">
                    &quot;App not found&quot; error
                  </AccordionTrigger>
                  <AccordionContent className="text-sm text-muted-foreground space-y-2">
                    <p>The Bundle ID doesn&apos;t match any app.</p>
                    <ol className="list-decimal list-inside space-y-1">
                      <li>Double-check your Bundle ID for typos</li>
                      <li>Verify the app exists in App Store Connect</li>
                      <li>
                        Bundle IDs are case-sensitive - use the exact format
                      </li>
                      <li>
                        Ensure the app isn&apos;t deleted or transferred
                      </li>
                    </ol>
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="no-products">
                  <AccordionTrigger className="text-sm">
                    Connected but no products showing
                  </AccordionTrigger>
                  <AccordionContent className="text-sm text-muted-foreground space-y-2">
                    <p>
                      The app may not have any In-App Purchases configured.
                    </p>
                    <ol className="list-decimal list-inside space-y-1">
                      <li>
                        In App Store Connect, go to your app &gt; Features
                      </li>
                      <li>Check In-App Purchases and Subscriptions sections</li>
                      <li>
                        Products must be in a valid state (not just draft)
                      </li>
                      <li>Ensure you&apos;ve created and saved at least one product</li>
                    </ol>
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="lost-key">
                  <AccordionTrigger className="text-sm">
                    Lost my .p8 file
                  </AccordionTrigger>
                  <AccordionContent className="text-sm text-muted-foreground space-y-2">
                    <p>
                      Unfortunately, .p8 files can only be downloaded once.
                    </p>
                    <ol className="list-decimal list-inside space-y-1">
                      <li>Go to App Store Connect &gt; Users and Access</li>
                      <li>Navigate to Integrations &gt; App Store Connect API</li>
                      <li>Revoke the old key (optional but recommended)</li>
                      <li>Generate a new API key</li>
                      <li>Download and store it securely this time</li>
                    </ol>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </CardContent>
          </Card>

          {/* Security note */}
          <Card>
            <CardHeader>
              <h2 className="text-2xl font-bold tracking-tight">Security</h2>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="h-4 w-4 text-success-foreground mt-0.5 flex-shrink-0" />
                  Your API key stays in your browser and is never sent to PricingKit&apos;s server
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="h-4 w-4 text-success-foreground mt-0.5 flex-shrink-0" />
                  Your browser signs the access tokens (JWTs), which expire after 20 minutes; the server only receives those
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="h-4 w-4 text-success-foreground mt-0.5 flex-shrink-0" />
                  The key is kept in this browser until you sign out
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="h-4 w-4 text-success-foreground mt-0.5 flex-shrink-0" />
                  You can forget the key at any time from Settings
                </li>
              </ul>
            </CardContent>
          </Card>

          {/* Reference */}
          <Card>
            <CardHeader>
              <h2 className="text-2xl font-bold tracking-tight">Reference</h2>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                This guide is based on the official Apple documentation:{' '}
                <a
                  href="https://developer.apple.com/documentation/appstoreconnectapi/creating_api_keys_for_app_store_connect_api"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-semibold text-link hover:underline"
                >
                  Creating API Keys for App Store Connect API
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
              </p>
            </CardContent>
          </Card>
        </div>
    </article>
  );
}
