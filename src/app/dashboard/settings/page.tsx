'use client';

import { useState, useEffect } from 'react';
import { Key, RefreshCw, Check, ExternalLink, Trash2 } from 'lucide-react';
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

interface ApiKeyStatus {
  hasKey: boolean;
  apiKey?: string;
  source: 'user' | 'environment' | 'none';
}

async function loadStatus(): Promise<ApiKeyStatus | null> {
  try {
    const response = await fetch('/api/settings/exchange-rates');
    const data = await response.json();
    return data.success ? data : null;
  } catch (error) {
    console.error('Failed to fetch API key status:', error);
    return null;
  }
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
    if (!apiKey.trim()) {
      toast.error('Please enter an API key');
      return;
    }

    setSaving(true);
    try {
      const response = await fetch('/api/settings/exchange-rates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });

      const data = await response.json();

      if (data.success) {
        toast.success('API key saved and validated successfully');
        setApiKey('');
        fetchStatus();
      } else {
        toast.error(data.error || 'Failed to save API key');
      }
    } catch {
      toast.error('Failed to save API key');
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    try {
      const response = await fetch('/api/settings/exchange-rates', {
        method: 'DELETE',
      });

      const data = await response.json();

      if (data.success) {
        toast.success('API key removed');
        fetchStatus();
      }
    } catch {
      toast.error('Failed to remove API key');
    }
  };

  return (
    <div className="flex h-full flex-col">
      <Header showSearch={false} />
      <div className={cn(pageClass, 'max-w-3xl')}>
        <PageHeader title="Settings" description="Exchange rates and other options for this browser session." />

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Key className="h-5 w-5" />
              Exchange Rates API
            </CardTitle>
            <CardDescription>
              Configure your Open Exchange Rates API key for real-time currency conversion.
              This enables accurate pricing calculations across all regions.
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
