'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Store,
  DollarSign,
  Package,
  TrendingUp,
  BookOpen,
  ArrowRight,
} from 'lucide-react';
import { ServiceAccountUpload } from '@/components/auth/service-account-upload';
import { AppleConnectUpload } from '@/components/auth/apple-connect-upload';
import { useAuthStore } from '@/store/auth-store';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

type PlatformTab = 'google' | 'apple';

export default function Home() {
  const router = useRouter();
  const isGoogleAuthenticated = useAuthStore(
    (state) => state.isGoogleAuthenticated
  );
  const isAppleAuthenticated = useAuthStore(
    (state) => state.isAppleAuthenticated
  );
  const [activeTab, setActiveTab] = useState<PlatformTab>('google');

  useEffect(() => {
    // Redirect if both platforms are connected
    if (isGoogleAuthenticated && isAppleAuthenticated) {
      router.push('/dashboard');
    }
    // If only one is connected, still redirect (they can add more from settings)
    else if (isGoogleAuthenticated || isAppleAuthenticated) {
      router.push('/dashboard');
    }
  }, [isGoogleAuthenticated, isAppleAuthenticated, router]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted">
      <div className="container mx-auto px-4 py-16">
        <div className="flex flex-col items-center text-center mb-12">
          <div className="flex items-center gap-2 mb-4">
            <Store className="h-10 w-10 text-primary" />
            <h1 className="text-4xl font-bold">Pricing.io</h1>
          </div>
          <p className="text-xl text-muted-foreground max-w-2xl">
            Manage in-app product and subscription pricing for Google Play and
            Apple App Store
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-12 max-w-5xl mx-auto">
          <div className="flex flex-col justify-center space-y-8">
            <div className="space-y-6">
              <div className="flex items-start gap-4">
                <div className="rounded-lg bg-primary/10 p-2">
                  <Package className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <h3 className="font-semibold mb-1">In-App Products</h3>
                  <p className="text-sm text-muted-foreground">
                    View and manage pricing for all your one-time purchase
                    products across regions
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="rounded-lg bg-primary/10 p-2">
                  <TrendingUp className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <h3 className="font-semibold mb-1">Subscriptions</h3>
                  <p className="text-sm text-muted-foreground">
                    Manage subscription plans and regional pricing
                    configurations
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="rounded-lg bg-primary/10 p-2">
                  <DollarSign className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <h3 className="font-semibold mb-1">Multi-Platform</h3>
                  <p className="text-sm text-muted-foreground">
                    Connect both Google Play and Apple App Store to manage all
                    your apps in one place
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-lg border bg-card p-4">
              <div className="flex items-start gap-3">
                <div className="rounded-lg bg-primary/10 p-2">
                  <BookOpen className="h-5 w-5 text-primary" />
                </div>
                <div className="flex-1">
                  <h4 className="font-medium mb-1">New here?</h4>
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
                <p className="font-medium mb-2">What you&apos;ll need:</p>
                <ul className="space-y-1">
                  <li>
                    • A Google Cloud project with Play Developer API enabled
                  </li>
                  <li>• A service account JSON key file</li>
                  <li>
                    • Your app&apos;s package name (e.g., com.example.app)
                  </li>
                </ul>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">
                <p className="font-medium mb-2">What you&apos;ll need:</p>
                <ul className="space-y-1">
                  <li>• An Apple Developer Program membership ($99/year)</li>
                  <li>• An API key (.p8 file) from App Store Connect</li>
                  <li>• Your Key ID and Issuer ID</li>
                  <li>• Your app&apos;s Bundle ID (e.g., com.example.app)</li>
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
    </div>
  );
}
