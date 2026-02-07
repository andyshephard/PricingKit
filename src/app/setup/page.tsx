'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, BookOpen } from 'lucide-react';
import { ServiceAccountUpload } from '@/components/auth/service-account-upload';
import { AppleConnectUpload } from '@/components/auth/apple-connect-upload';
import { useAuthStore } from '@/store/auth-store';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LandingFooter } from '@/components/landing/landing-footer';

type PlatformTab = 'google' | 'apple';

export default function SetupPage() {
  const router = useRouter();
  const isGoogleAuthenticated = useAuthStore(
    (state) => state.isGoogleAuthenticated
  );
  const isAppleAuthenticated = useAuthStore(
    (state) => state.isAppleAuthenticated
  );
  const [activeTab, setActiveTab] = useState<PlatformTab>('apple');

  useEffect(() => {
    if (isGoogleAuthenticated || isAppleAuthenticated) {
      router.push('/dashboard');
    }
  }, [isGoogleAuthenticated, isAppleAuthenticated, router]);

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-12">
        <div className="mb-10">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/">
              <ArrowLeft className="h-4 w-4 mr-1.5" />
              Back to home
            </Link>
          </Button>
        </div>

        <div className="flex flex-col items-center text-center mb-14">
          <h1 className="text-4xl font-bold tracking-tight mb-4">Connect your account</h1>
          <p className="text-lg text-muted-foreground max-w-lg">
            Upload your API credentials to start managing your app pricing.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-12 max-w-5xl mx-auto">
          <div className="flex flex-col justify-center space-y-8">
            <div className="rounded-xl border bg-card p-5">
              <div className="flex items-start gap-3">
                <div className="rounded-lg bg-primary/10 p-2">
                  <BookOpen className="h-5 w-5 text-primary" />
                </div>
                <div className="flex-1">
                  <h4 className="font-semibold mb-1">New here?</h4>
                  <p className="text-sm text-muted-foreground mb-3">
                    Follow our step-by-step guides to set up your API access.
                  </p>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" asChild>
                      <Link href="/setup-guide">
                        Google Play Guide
                        <ArrowRight className="ml-2 h-4 w-4" />
                      </Link>
                    </Button>
                    <Button variant="outline" size="sm" asChild>
                      <Link href="/setup-guide/apple">
                        Apple Guide
                        <ArrowRight className="ml-2 h-4 w-4" />
                      </Link>
                    </Button>
                  </div>
                </div>
              </div>
            </div>

            {activeTab === 'google' ? (
              <div className="text-sm text-muted-foreground">
                <p className="font-semibold mb-2">What you&apos;ll need:</p>
                <ul className="space-y-1">
                  <li>
                    &bull; A Google Cloud project with Play Developer API enabled
                  </li>
                  <li>&bull; A service account JSON key file</li>
                  <li>
                    &bull; Your app&apos;s package name (e.g., com.example.app)
                  </li>
                </ul>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">
                <p className="font-semibold mb-2">What you&apos;ll need:</p>
                <ul className="space-y-1">
                  <li>&bull; An Apple Developer Program membership ($99/year)</li>
                  <li>&bull; An API key (.p8 file) from App Store Connect</li>
                  <li>&bull; Your Key ID and Issuer ID</li>
                  <li>&bull; Your app&apos;s Bundle ID (e.g., com.example.app)</li>
                </ul>
              </div>
            )}
          </div>

          <div className="flex items-start justify-center pt-4">
            <Tabs
              value={activeTab}
              onValueChange={(v) => setActiveTab(v as PlatformTab)}
              className="w-full max-w-md"
            >
              <TabsList className="grid w-full grid-cols-2 mb-4">
                <TabsTrigger value="google">Google Play</TabsTrigger>
                <TabsTrigger value="apple">Apple App Store</TabsTrigger>
              </TabsList>
              <TabsContent value="google">
                <ServiceAccountUpload />
              </TabsContent>
              <TabsContent value="apple">
                <AppleConnectUpload />
              </TabsContent>
            </Tabs>
          </div>
        </div>
      </div>

      <LandingFooter />
    </div>
  );
}
