'use client';

import Link from 'next/link';
import {
  ArrowLeft,
  ExternalLink,
  CheckCircle2,
  Copy,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';

function CopyButton({ text }: { text: string }) {
  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard');
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-6 w-6"
      onClick={handleCopy}
    >
      <Copy className="h-3 w-3" />
    </Button>
  );
}

function StepNumber({ num }: { num: number }) {
  return (
    <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">
      {num}
    </div>
  );
}

export default function SetupGuidePage() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted">
      <div className="container mx-auto px-4 py-8 max-w-4xl">
        <div className="mb-8">
          <Button variant="ghost" asChild className="mb-4">
            <Link href="/">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Home
            </Link>
          </Button>
          <h1 className="text-3xl font-bold mb-2">Setup Guide</h1>
          <p className="text-muted-foreground">
            Follow these steps to connect your Google Play Developer account
          </p>
        </div>

        <div className="space-y-6">
          {/* Prerequisites */}
          <Card>
            <CardHeader>
              <CardTitle className="text-xl">Prerequisites</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2">
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="h-5 w-5 text-green-500 mt-0.5 flex-shrink-0" />
                  <span>A Google Play Developer account ($25 one-time registration fee)</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="h-5 w-5 text-green-500 mt-0.5 flex-shrink-0" />
                  <span>At least one app published (or in draft) in Google Play Console</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="h-5 w-5 text-green-500 mt-0.5 flex-shrink-0" />
                  <span>Permission to invite users in Google Play Console</span>
                </li>
              </ul>
            </CardContent>
          </Card>

          {/* Step 1 */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <StepNumber num={1} />
                <CardTitle className="text-xl">Create a Google Cloud Project</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <ol className="list-decimal list-inside space-y-3 text-sm">
                <li>
                  Go to the{' '}
                  <a
                    href="https://console.cloud.google.com/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline inline-flex items-center gap-1"
                  >
                    Google Cloud Console
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </li>
                <li>Click the project dropdown at the top of the page</li>
                <li>Click <Badge variant="secondary">New Project</Badge></li>
                <li>Enter a project name (e.g., &quot;Play Pricing Manager&quot;)</li>
                <li>Click <Badge variant="secondary">Create</Badge></li>
                <li>Wait for the project to be created, then select it from the dropdown</li>
              </ol>
            </CardContent>
          </Card>

          {/* Step 2 */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <StepNumber num={2} />
                <CardTitle className="text-xl">Enable the Google Play Developer API</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <ol className="list-decimal list-inside space-y-3 text-sm">
                <li>
                  In your Google Cloud project, go to{' '}
                  <a
                    href="https://console.cloud.google.com/apis/library/androidpublisher.googleapis.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline inline-flex items-center gap-1"
                  >
                    Google Play Android Developer API
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </li>
                <li>Click <Badge variant="secondary">Enable</Badge></li>
                <li>Wait for the API to be enabled (this may take a few seconds)</li>
              </ol>
            </CardContent>
          </Card>

          {/* Step 3 */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <StepNumber num={3} />
                <CardTitle className="text-xl">Create a Service Account</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <ol className="list-decimal list-inside space-y-3 text-sm">
                <li>
                  Go to{' '}
                  <a
                    href="https://console.cloud.google.com/iam-admin/serviceaccounts"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline inline-flex items-center gap-1"
                  >
                    Service Accounts
                    <ExternalLink className="h-3 w-3" />
                  </a>
                  {' '}in Google Cloud Console
                </li>
                <li>Make sure your project is selected at the top</li>
                <li>Click <Badge variant="secondary">Create Service Account</Badge></li>
                <li>
                  Fill in the details:
                  <ul className="list-disc list-inside ml-4 mt-2 space-y-1 text-muted-foreground">
                    <li>Service account name: e.g., &quot;play-pricing-manager&quot;</li>
                    <li>Service account ID: will auto-fill</li>
                    <li>Description: optional</li>
                  </ul>
                </li>
                <li>Click <Badge variant="secondary">Create and Continue</Badge></li>
                <li>Skip the optional &quot;Grant access&quot; steps - click <Badge variant="secondary">Done</Badge></li>
              </ol>
            </CardContent>
          </Card>

          {/* Step 4 */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <StepNumber num={4} />
                <CardTitle className="text-xl">Download the Service Account Key</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <ol className="list-decimal list-inside space-y-3 text-sm">
                <li>In the Service Accounts list, find your newly created service account</li>
                <li>Click on the service account email to open its details</li>
                <li>Go to the <Badge variant="secondary">Keys</Badge> tab</li>
                <li>
                  Click <Badge variant="secondary">Add Key</Badge> → <Badge variant="secondary">Create new key</Badge>
                </li>
                <li>Select <strong>JSON</strong> format</li>
                <li>Click <Badge variant="secondary">Create</Badge></li>
                <li>The JSON file will download automatically</li>
              </ol>

              <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 p-4 mt-4">
                <p className="text-sm text-amber-800 dark:text-amber-200">
                  <strong>Important:</strong> Keep this JSON file safe! It contains credentials to access your Play Console.
                  Also note the <strong>service account email address</strong> - you&apos;ll need it in the next step.
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Step 5 */}
          <Card className="border-primary">
            <CardHeader>
              <div className="flex items-center gap-3">
                <StepNumber num={5} />
                <div>
                  <CardTitle className="text-xl">Invite Service Account to Play Console</CardTitle>
                  <p className="text-sm text-muted-foreground mt-1">
                    This is the most important step!
                  </p>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <ol className="list-decimal list-inside space-y-3 text-sm">
                <li>
                  Go to{' '}
                  <a
                    href="https://play.google.com/console/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline inline-flex items-center gap-1"
                  >
                    Google Play Console
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </li>
                <li>
                  Click <Badge variant="secondary">Users and permissions</Badge> in the left sidebar
                </li>
                <li>
                  Click <Badge variant="secondary">Invite new users</Badge>
                </li>
                <li>
                  Enter your <strong>service account email address</strong>
                  <ul className="list-disc list-inside ml-4 mt-2 space-y-1 text-muted-foreground">
                    <li>Find this in your downloaded JSON file (the <code className="bg-muted px-1 rounded">client_email</code> field)</li>
                    <li>It looks like: <code className="bg-muted px-1 rounded text-xs">name@project-id.iam.gserviceaccount.com</code></li>
                  </ul>
                </li>
                <li>Set the <strong>access expiry</strong> (or leave as &quot;Never&quot;)</li>
                <li>Configure permissions (see next step)</li>
                <li>Click <Badge variant="secondary">Invite user</Badge></li>
              </ol>

              <div className="rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900 p-4 mt-4">
                <p className="text-sm text-blue-800 dark:text-blue-200">
                  <strong>Note:</strong> You no longer need to link your Google Cloud project to Play Console.
                  Simply inviting the service account email as a user is sufficient.
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Step 6 */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <StepNumber num={6} />
                <CardTitle className="text-xl">Configure Permissions</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                When inviting the service account, grant these permissions:
              </p>

              <div className="space-y-4">
                <div>
                  <h4 className="font-medium mb-2">Required Permissions</h4>
                  <ul className="space-y-2 text-sm">
                    <li className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-green-500" />
                      <strong>View app information and download bulk reports</strong>
                    </li>
                    <li className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-green-500" />
                      <strong>View financial data, orders, and cancellation survey responses</strong>
                    </li>
                    <li className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-green-500" />
                      <strong>Manage orders and subscriptions</strong>
                    </li>
                  </ul>
                </div>

                <div>
                  <h4 className="font-medium mb-2">For Managing Pricing (also recommended)</h4>
                  <ul className="space-y-2 text-sm">
                    <li className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-green-500" />
                      <strong>Manage store presence</strong>
                    </li>
                    <li className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-green-500" />
                      <strong>Manage pricing and distribution</strong>
                    </li>
                  </ul>
                </div>

                <div className="text-sm text-muted-foreground">
                  <p>You can grant permissions at the <strong>Account level</strong> (all apps) or for <strong>specific apps</strong> only.</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Step 7 */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <StepNumber num={7} />
                <CardTitle className="text-xl">Find Your Package Name</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Your package name uniquely identifies your Android app. It looks like:{' '}
                <code className="bg-muted px-1.5 py-0.5 rounded text-xs">com.company.appname</code>
              </p>

              <Accordion type="single" collapsible className="w-full">
                <AccordionItem value="method1">
                  <AccordionTrigger className="text-sm">
                    Method 1: From Play Console Dashboard
                  </AccordionTrigger>
                  <AccordionContent className="text-sm text-muted-foreground">
                    <ol className="list-decimal list-inside space-y-2">
                      <li>Go to Google Play Console</li>
                      <li>Select your app</li>
                      <li>The package name is shown on the App Dashboard</li>
                      <li>Or check the URL - it contains your app&apos;s identifier</li>
                    </ol>
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="method2">
                  <AccordionTrigger className="text-sm">
                    Method 2: From App Integrity
                  </AccordionTrigger>
                  <AccordionContent className="text-sm text-muted-foreground">
                    <ol className="list-decimal list-inside space-y-2">
                      <li>In Play Console, select your app</li>
                      <li>Go to Release → App integrity</li>
                      <li>Your package name is displayed at the top</li>
                    </ol>
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="method3">
                  <AccordionTrigger className="text-sm">
                    Method 3: From build.gradle
                  </AccordionTrigger>
                  <AccordionContent className="text-sm text-muted-foreground">
                    <p className="mb-2">Check your app&apos;s build.gradle file:</p>
                    <pre className="bg-muted p-3 rounded-lg text-xs overflow-x-auto">
{`android {
    namespace = "com.yourcompany.yourapp"
}`}
                    </pre>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </CardContent>
          </Card>

          {/* Ready */}
          <Card className="bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-900">
            <CardContent className="pt-6">
              <div className="flex items-center gap-3 mb-4">
                <CheckCircle2 className="h-8 w-8 text-green-500" />
                <div>
                  <h3 className="font-semibold text-lg">You&apos;re Ready!</h3>
                  <p className="text-sm text-muted-foreground">
                    You now have everything needed to connect
                  </p>
                </div>
              </div>
              <Button asChild className="w-full">
                <Link href="/setup">
                  Go to Connect Page
                </Link>
              </Button>
            </CardContent>
          </Card>

          {/* Troubleshooting */}
          <Card>
            <CardHeader>
              <CardTitle className="text-xl">Troubleshooting</CardTitle>
            </CardHeader>
            <CardContent>
              <Accordion type="single" collapsible className="w-full">
                <AccordionItem value="access-denied">
                  <AccordionTrigger className="text-sm">
                    &quot;Access denied&quot; error
                  </AccordionTrigger>
                  <AccordionContent className="text-sm text-muted-foreground space-y-2">
                    <p>The service account doesn&apos;t have sufficient permissions.</p>
                    <ol className="list-decimal list-inside space-y-1">
                      <li>Go to Play Console → Users and permissions</li>
                      <li>Find your service account email</li>
                      <li>Click on it to edit permissions</li>
                      <li>Ensure all required permissions are enabled (see Step 6)</li>
                      <li>Save changes and wait a few minutes</li>
                    </ol>
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="app-not-found">
                  <AccordionTrigger className="text-sm">
                    &quot;App not found&quot; error
                  </AccordionTrigger>
                  <AccordionContent className="text-sm text-muted-foreground space-y-2">
                    <p>The package name is incorrect or the service account doesn&apos;t have access to this app.</p>
                    <ol className="list-decimal list-inside space-y-1">
                      <li>Double-check your package name for typos</li>
                      <li>Verify the app exists in Play Console</li>
                      <li>Check that the service account has permissions for this specific app</li>
                    </ol>
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="invalid-credentials">
                  <AccordionTrigger className="text-sm">
                    &quot;Invalid credentials&quot; error
                  </AccordionTrigger>
                  <AccordionContent className="text-sm text-muted-foreground space-y-2">
                    <p>The JSON key file is invalid or corrupted.</p>
                    <ol className="list-decimal list-inside space-y-1">
                      <li>Verify you&apos;re uploading the service account JSON file</li>
                      <li>The file should contain <code className="bg-muted px-1 rounded">&quot;type&quot;: &quot;service_account&quot;</code></li>
                      <li>Try creating and downloading a new key from Google Cloud Console</li>
                    </ol>
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="cant-invite">
                  <AccordionTrigger className="text-sm">
                    Can&apos;t invite users in Play Console
                  </AccordionTrigger>
                  <AccordionContent className="text-sm text-muted-foreground space-y-2">
                    <p>You may not have permission to invite users.</p>
                    <ol className="list-decimal list-inside space-y-1">
                      <li>Contact your Play Console account owner or admin</li>
                      <li>Ask them to either invite the service account for you</li>
                      <li>Or grant you permission to manage users</li>
                    </ol>
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="no-products">
                  <AccordionTrigger className="text-sm">
                    Connected but no products showing
                  </AccordionTrigger>
                  <AccordionContent className="text-sm text-muted-foreground space-y-2">
                    <p>The app may not have any in-app products configured.</p>
                    <ol className="list-decimal list-inside space-y-1">
                      <li>In Play Console, go to your app → Monetize → Products → In-app products</li>
                      <li>Products must be in &quot;Active&quot; or &quot;Inactive&quot; status (not just &quot;Draft&quot;)</li>
                      <li>Make sure you entered the correct package name</li>
                    </ol>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </CardContent>
          </Card>

          {/* Security note */}
          <Card>
            <CardHeader>
              <CardTitle className="text-xl">Security</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5 flex-shrink-0" />
                  Your service account JSON is never stored on our servers
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5 flex-shrink-0" />
                  Credentials are encrypted and stored only in your browser
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5 flex-shrink-0" />
                  Sessions automatically expire after 24 hours
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5 flex-shrink-0" />
                  You can disconnect at any time from Settings
                </li>
              </ul>
            </CardContent>
          </Card>

          {/* Reference */}
          <Card>
            <CardHeader>
              <CardTitle className="text-xl">Reference</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                This guide is based on the official Google documentation:{' '}
                <a
                  href="https://developers.google.com/android-publisher/getting_started"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline inline-flex items-center gap-1"
                >
                  Getting Started with the Google Play Developer API
                  <ExternalLink className="h-3 w-3" />
                </a>
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
