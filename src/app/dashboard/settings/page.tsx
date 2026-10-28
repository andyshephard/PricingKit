'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Key, KeyRound, RefreshCw, Check, ExternalLink, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Header } from '@/components/layout/header';
import { PageHeader, pageClass } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { browserKeys, getOerKey, setOerKey } from '@/lib/web/client';
import type { KeyInfo, KeyPlatform } from '@/lib/browser-keys';
import { useAuthStore } from '@/store/auth-store';

interface ApiKeyStatus {
  hasKey: boolean;
  apiKey?: string;
  source: 'user' | 'environment' | 'none';
}

const OER_KEY_PATTERN = /^[A-Za-z0-9]{8,64}$/;

/** The user's key (kept in this browser) first, then whether the server has its own */
async function loadStatus(): Promise<ApiKeyStatus | null> {
  const saved = getOerKey();
  if (saved) return { hasKey: true, apiKey: `••••${saved.slice(-4)}`, source: 'user' };
  try {
    const response = await fetch('/api/settings/exchange-rates');
    const data = await response.json();
    return data.success ? data : null;
  } catch {
    return null;
  }
}

/** Tests an Open Exchange Rates app ID from this browser: the key goes to Open Exchange Rates only */
async function testOerKey(apiKey: string): Promise<string | null> {
  try {
    const response = await fetch(`https://openexchangerates.org/api/latest.json?app_id=${encodeURIComponent(apiKey)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return null;
    const data = (await response.json().catch(() => ({}))) as { description?: unknown };
    return typeof data.description === 'string' && data.description ? data.description : 'Invalid API key';
  } catch {
    return 'Could not reach Open Exchange Rates. Try again.';
  }
}

const STORE_NAMES: Record<KeyPlatform, string> = { apple: 'App Store Connect', google: 'Google Play' };

/** The store keys held in this browser, each with a "Forget this key" control */
function StoredKeysCard() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const clearAppleAuth = useAuthStore((s) => s.clearAppleAuth);
  const clearGoogleAuth = useAuthStore((s) => s.clearGoogleAuth);
  const [keys, setKeys] = useState<Record<KeyPlatform, KeyInfo | null> | null>(null);
  const [storageError, setStorageError] = useState(false);
  const [forgetting, setForgetting] = useState<KeyPlatform | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([browserKeys().info('apple'), browserKeys().info('google')])
      .then(([apple, google]) => {
        if (!cancelled) setKeys({ apple, google });
      })
      .catch(() => {
        if (!cancelled) setStorageError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const forget = async (platform: KeyPlatform) => {
    setForgetting(platform);
    try {
      await browserKeys().forget(platform);
    } catch {
      toast.error(`Could not delete the ${STORE_NAMES[platform]} key from this browser. It is still stored; try again.`);
      setForgetting(null);
      return;
    }
    const next = { apple: keys?.apple ?? null, google: keys?.google ?? null, [platform]: null };
    setKeys(next);
    setForgetting(null);
    if (platform === 'apple') clearAppleAuth();
    else clearGoogleAuth();
    queryClient.clear();
    toast.success(`${STORE_NAMES[platform]} key deleted from this browser`);
    if (!next.apple && !next.google) router.push('/setup');
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-5 w-5" />
          Store keys in this browser
        </CardTitle>
        <CardDescription>
          Your keys stay in this browser, which uses them to sign short-lived access tokens. They are kept until you
          sign out or forget them here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {storageError ? (
          <p className="text-sm text-destructive">This browser&apos;s key storage (IndexedDB) is unavailable.</p>
        ) : !keys ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <RefreshCw className="h-4 w-4 animate-spin" />
            Loading...
          </div>
        ) : (
          (['apple', 'google'] as const).map((platform) => {
            const info = keys[platform];
            return (
              <div key={platform} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3.5">
                <div className="min-w-0">
                  <p className="font-semibold">{STORE_NAMES[platform]}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {!info
                      ? 'No key stored'
                      : info.platform === 'apple'
                        ? `Key ID ${info.keyId} · Issuer ${info.issuerId}`
                        : `${info.clientEmail} · ${info.projectId}`}
                  </p>
                </div>
                {info && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => forget(platform)}
                    disabled={forgetting !== null}
                    className="text-destructive hover:text-destructive"
                  >
                    <Trash2 className="mr-1.5 h-4 w-4" aria-hidden="true" />
                    {forgetting === platform ? 'Forgetting...' : 'Forget this key'}
                  </Button>
                )}
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  const [apiKey, setApiKey] = useState('');
  const [status, setStatus] = useState<ApiKeyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const fetchStatus = async () => {
    const data = await loadStatus();
    if (data) setStatus(data);
  };

  useEffect(() => {
    let cancelled = false;
    loadStatus()
      .then((data) => {
        if (!cancelled && data) setStatus(data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSave = async () => {
    const key = apiKey.trim();
    if (!key) {
      toast.error('Please enter an API key');
      return;
    }
    if (!OER_KEY_PATTERN.test(key)) {
      toast.error('That is not an Open Exchange Rates app ID');
      return;
    }

    setSaving(true);
    try {
      const problem = await testOerKey(key);
      if (problem) {
        toast.error(problem);
        return;
      }
      if (!setOerKey(key)) {
        toast.error("This browser's storage is unavailable, so the key can't be saved.");
        return;
      }
      toast.success('API key saved in this browser');
      setApiKey('');
      fetchStatus();
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = () => {
    if (!setOerKey(null)) {
      toast.error('Failed to remove API key');
      return;
    }
    toast.success('API key removed');
    fetchStatus();
  };

  return (
    <div className="flex h-full flex-col">
      <Header showSearch={false} />
      <div className={cn(pageClass, 'max-w-3xl')}>
        <PageHeader title="Settings" description="Store keys, exchange rates and other options for this browser." />

        <div className="mb-6">
          <StoredKeysCard />
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Key className="h-5 w-5" />
              Exchange Rates API
            </CardTitle>
            <CardDescription>
              Configure your Open Exchange Rates API key for real-time currency conversion.
              It is kept in this browser and sent only with exchange-rate requests.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Current Status */}
            {loading ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <RefreshCw className="h-4 w-4 animate-spin" />
                Loading...
              </div>
            ) : status?.hasKey ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-success p-3.5">
                <div className="flex items-center gap-3">
                  <Check className="h-5 w-5 text-success-foreground" aria-hidden="true" />
                  <div>
                    <p className="font-semibold text-success-foreground">
                      API Key Configured
                    </p>
                    <p className="text-sm text-success-foreground">
                      {status.source === 'environment'
                        ? 'Set by the server operator'
                        : status.apiKey}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">
                    {status.source === 'environment' ? 'From Environment' : 'User Provided'}
                  </Badge>
                  {status.source === 'user' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleRemove}
                      className="text-destructive hover:text-destructive"
                      aria-label="Remove API key"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-warn-border bg-warn p-3.5">
                <p className="font-semibold text-warn-foreground">
                  No API Key Configured
                </p>
                <p className="text-sm text-warn-foreground">
                  Using fallback exchange rates. Add an API key for real-time rates.
                </p>
              </div>
            )}

            {/* Add New Key */}
            <div className="space-y-3 pt-2">
              <Label htmlFor="api-key">
                {status?.hasKey ? 'Update API Key' : 'Add API Key'}
              </Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  id="api-key"
                  type="password"
                  placeholder="Enter your Open Exchange Rates App ID"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="flex-1"
                />
                <Button onClick={handleSave} disabled={saving || !apiKey.trim()}>
                  {saving ? (
                    <>
                      <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                      Validating...
                    </>
                  ) : (
                    'Save'
                  )}
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">
                Get a free API key from{' '}
                <a
                  href="https://openexchangerates.org/signup/free"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-link font-semibold hover:underline inline-flex items-center gap-1"
                >
                  openexchangerates.org
                  <ExternalLink className="h-3 w-3" />
                </a>
                {' '}(1,000 requests/month free)
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
