'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Upload, FileJson, AlertCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuthStore } from '@/store/auth-store';

interface UploadState {
  isDragging: boolean;
  file: File | null;
  error: string | null;
  isLoading: boolean;
}

export function ServiceAccountUpload() {
  const router = useRouter();
  const setGoogleAuthenticated = useAuthStore((state) => state.setGoogleAuthenticated);
  const setPlatform = useAuthStore((state) => state.setPlatform);
  const [packageName, setPackageName] = useState('');
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
    if (!file.name.endsWith('.json')) {
      setState((prev) => ({
        ...prev,
        error: 'Please upload a JSON file',
        file: null,
      }));
      return false;
    }

    if (file.size > 50 * 1024) {
      // 50KB limit
      setState((prev) => ({
        ...prev,
        error: 'File is too large. Service account files are typically under 5KB.',
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

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && validateFile(file)) {
      setState((prev) => ({ ...prev, file, error: null }));
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!state.file || !packageName.trim()) {
      setState((prev) => ({
        ...prev,
        error: 'Please provide both a service account file and package name',
      }));
      return;
    }

    setState((prev) => ({ ...prev, isLoading: true, error: null }));

    try {
      const text = await state.file.text();
      let credentials: unknown;

      try {
        credentials = JSON.parse(text);
      } catch {
        setState((prev) => ({
          ...prev,
          error: 'Invalid JSON file',
          isLoading: false,
        }));
        return;
      }

      const response = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          credentials,
          packageName: packageName.trim(),
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

      setGoogleAuthenticated({
        packageName: packageName.trim(),
        projectId: data.projectId,
        clientEmail: data.clientEmail,
      });
      setPlatform('google');
      router.push('/dashboard');
    } catch (error) {
      console.error('Upload error:', error);
      setState((prev) => ({
        ...prev,
        error: 'Failed to upload credentials. Please try again.',
        isLoading: false,
      }));
    }
  };

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Connect to Google Play</CardTitle>
        <CardDescription>
          Upload your service account JSON file to manage in-app product pricing
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="packageName">Package Name</Label>
            <Input
              id="packageName"
              type="text"
              placeholder="com.example.myapp"
              value={packageName}
              onChange={(e) => setPackageName(e.target.value)}
              disabled={state.isLoading}
            />
          </div>

          <div className="space-y-2">
            <Label>Service Account JSON</Label>
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
                accept=".json"
                onChange={handleFileSelect}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                disabled={state.isLoading}
              />
              <div className="flex flex-col items-center gap-2 text-center">
                {state.file ? (
                  <>
                    <FileJson className="h-10 w-10 text-green-500" />
                    <p className="text-sm font-medium">{state.file.name}</p>
                    <p className="text-xs text-muted-foreground">
                      Click or drag to replace
                    </p>
                  </>
                ) : (
                  <>
                    <Upload className="h-10 w-10 text-muted-foreground" />
                    <p className="text-sm font-medium">
                      Drop your service account JSON here
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
            disabled={!state.file || !packageName.trim() || state.isLoading}
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
            Your credentials are encrypted and stored securely in your browser.
            They are never saved to disk on our servers.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
