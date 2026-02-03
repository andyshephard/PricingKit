'use client';

import { useState, useEffect } from 'react';
import { Settings, Key, RefreshCw, Check, ExternalLink, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
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
  apiKey: string;
  source: 'user' | 'environment' | 'none';
}

export default function SettingsPage() {
  const [apiKey, setApiKey] = useState('');
  const [status, setStatus] = useState<ApiKeyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchStatus();
  }, []);

  const fetchStatus = async () => {
    try {
      const response = await fetch('/api/settings/exchange-rates');
      const data = await response.json();
      if (data.success) {
        setStatus(data);
      }
    } catch (error) {
      console.error('Failed to fetch API key status:', error);
    } finally {
      setLoading(false);
    }
  };

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
    } catch (error) {
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
    } catch (error) {
      toast.error('Failed to remove API key');
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Settings className="h-6 w-6" />
          Settings
        </h1>
        <p className="text-muted-foreground mt-1">
          Configure your pricing tool settings
        </p>
      </div>

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
            <div className="flex items-center justify-between p-3 bg-green-50 dark:bg-green-950/20 rounded-lg border border-green-200 dark:border-green-900">
              <div className="flex items-center gap-3">
                <Check className="h-5 w-5 text-green-600" />
                <div>
                  <p className="font-medium text-green-800 dark:text-green-200">
                    API Key Configured
                  </p>
                  <p className="text-sm text-green-600 dark:text-green-400">
                    {status.apiKey}
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
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="p-3 bg-amber-50 dark:bg-amber-950/20 rounded-lg border border-amber-200 dark:border-amber-900">
              <p className="font-medium text-amber-800 dark:text-amber-200">
                No API Key Configured
              </p>
              <p className="text-sm text-amber-600 dark:text-amber-400">
                Using fallback exchange rates. Add an API key for real-time rates.
              </p>
            </div>
          )}

          {/* Add New Key */}
          <div className="space-y-3 pt-2">
            <Label htmlFor="api-key">
              {status?.hasKey ? 'Update API Key' : 'Add API Key'}
            </Label>
            <div className="flex gap-2">
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
                className="text-primary hover:underline inline-flex items-center gap-1"
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
  );
}
