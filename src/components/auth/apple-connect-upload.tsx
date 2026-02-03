'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Upload, Key, AlertCircle, Loader2, CheckCircle2 } from 'lucide-react';
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
import { useAuthStore } from '@/store/auth-store';

interface UploadState {
  isDragging: boolean;
  file: File | null;
  error: string | null;
  isLoading: boolean;
}

export function AppleConnectUpload() {
  const router = useRouter();
  const setAppleAuthenticated = useAuthStore(
    (state) => state.setAppleAuthenticated
  );
  const setPlatform = useAuthStore((state) => state.setPlatform);

  const [keyId, setKeyId] = useState('');
  const [issuerId, setIssuerId] = useState('');
  const [bundleId, setBundleId] = useState('');
  const [state, setState] = useState<UploadState>({
    isDragging: false,
    file: null,
    error: null,
    isLoading: false,
  });

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setState((prev) => ({ ...prev, isDragging: true }));
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setState((prev) => ({ ...prev, isDragging: false }));
  }, []);

  const validateFile = (file: File): boolean => {
    if (!file.name.endsWith('.p8')) {
      setState((prev) => ({
        ...prev,
        error: 'Please upload a .p8 file (Apple API Key)',
        file: null,
      }));
      return false;
    }

    if (file.size > 10 * 1024) {
      // 10KB limit
      setState((prev) => ({
        ...prev,
        error: 'File is too large. Apple API keys are typically under 1KB.',
        file: null,
      }));
      return false;
    }

    return true;
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setState((prev) => ({ ...prev, isDragging: false }));

    const file = e.dataTransfer.files[0];
    if (file && validateFile(file)) {
      setState((prev) => ({ ...prev, file, error: null }));
    }
  }, []);

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file && validateFile(file)) {
        setState((prev) => ({ ...prev, file, error: null }));
      }
    },
    []
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!state.file || !keyId.trim() || !issuerId.trim() || !bundleId.trim()) {
      setState((prev) => ({
        ...prev,
        error: 'Please provide all required fields',
      }));
      return;
    }

    setState((prev) => ({ ...prev, isLoading: true, error: null }));

    try {
      const privateKey = await state.file.text();

      const response = await fetch('/api/apple/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          privateKey,
          keyId: keyId.trim(),
          issuerId: issuerId.trim(),
          bundleId: bundleId.trim(),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setState((prev) => ({
          ...prev,
          error: data.error || 'Authentication failed',
          isLoading: false,
        }));
        return;
      }

      setAppleAuthenticated({
        bundleId: bundleId.trim(),
        keyId: keyId.trim(),
        issuerId: issuerId.trim(),
      });
      setPlatform('apple');
      router.push('/dashboard');
    } catch (error) {
      console.error('Upload error:', error);
      setState((prev) => ({
        ...prev,
        error: 'Failed to connect. Please check your credentials and try again.',
        isLoading: false,
      }));
    }
  };

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Connect to App Store Connect</CardTitle>
        <CardDescription>
          Upload your API key (.p8 file) to manage in-app purchases and
          subscriptions
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="bundleId">Bundle ID</Label>
            <Input
              id="bundleId"
              type="text"
              placeholder="com.example.myapp"
              value={bundleId}
              onChange={(e) => setBundleId(e.target.value)}
              disabled={state.isLoading}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="keyId">Key ID</Label>
              <Input
                id="keyId"
                type="text"
                placeholder="ABC123DEF4"
                value={keyId}
                onChange={(e) => setKeyId(e.target.value)}
                disabled={state.isLoading}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="issuerId">Issuer ID</Label>
              <Input
                id="issuerId"
                type="text"
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx"
                value={issuerId}
                onChange={(e) => setIssuerId(e.target.value)}
                disabled={state.isLoading}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>API Key (.p8 file)</Label>
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`
                relative border-2 border-dashed rounded-lg p-6 transition-colors
                ${state.isDragging ? 'border-primary bg-primary/5' : 'border-muted-foreground/25'}
                ${state.file ? 'border-green-500 bg-green-50 dark:bg-green-950/20' : ''}
                ${state.isLoading ? 'opacity-50 pointer-events-none' : 'cursor-pointer'}
              `}
            >
              <input
                type="file"
                accept=".p8"
                onChange={handleFileSelect}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                disabled={state.isLoading}
              />
              <div className="flex flex-col items-center gap-2 text-center">
                {state.file ? (
                  <>
                    <Key className="h-10 w-10 text-green-500" />
                    <p className="text-sm font-medium">{state.file.name}</p>
                    <p className="text-xs text-muted-foreground">
                      Click or drag to replace
                    </p>
                  </>
                ) : (
                  <>
                    <Upload className="h-10 w-10 text-muted-foreground" />
                    <p className="text-sm font-medium">
                      Drop your .p8 key file here
                    </p>
                    <p className="text-xs text-muted-foreground">
                      or click to browse
                    </p>
                  </>
                )}
              </div>
            </div>
          </div>

          {state.error && (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              <span>{state.error}</span>
            </div>
          )}

          <Button
            type="submit"
            className="w-full"
            disabled={
              !state.file ||
              !keyId.trim() ||
              !issuerId.trim() ||
              !bundleId.trim() ||
              state.isLoading
            }
          >
            {state.isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Connecting...
              </>
            ) : (
              'Connect'
            )}
          </Button>
        </form>

        <div className="mt-4 pt-4 border-t">
          <p className="text-xs text-muted-foreground">
            Your API key is encrypted and stored securely in your browser.
            It is never saved to disk on our servers.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
