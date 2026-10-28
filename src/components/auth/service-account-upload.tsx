'use client';

import { useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Upload, FileJson, AlertCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuthStore } from '@/store/auth-store';
import { connectDeps } from '@/lib/web/client';
import { connectGoogle, ConnectError } from '@/lib/web/connect';
import { KEY_STAYS_IN_BROWSER } from './key-copy';

interface UploadState {
  isDragging: boolean;
  file: File | null;
  error: string | null;
  errorHelpHref: string | null;
  errorHelpText: string | null;
  isLoading: boolean;
}

export function ServiceAccountUpload() {
  const router = useRouter();
  const setGoogleAuthenticated = useAuthStore((state) => state.setGoogleAuthenticated);
  const setPlatform = useAuthStore((state) => state.setPlatform);
  const fileInput = useRef<HTMLInputElement>(null);
  const [packageName, setPackageName] = useState('');
  const [state, setState] = useState<UploadState>({
    isDragging: false,
    file: null,
    error: null,
    errorHelpHref: null,
    errorHelpText: null,
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
        error: 'Please choose a JSON file',
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

    // The file is read once, imported as a non-extractable key and dropped:
    // neither the File nor its text is kept after this
    const file = state.file;
    setState((prev) => ({
      ...prev,
      file: null,
      isLoading: true,
      error: null,
      errorHelpHref: null,
      errorHelpText: null,
    }));
    if (fileInput.current) fileInput.current.value = '';

    try {
      const connected = await connectGoogle(connectDeps(), { file, packageName: packageName.trim() });
      setGoogleAuthenticated({
        packageName: connected.packageName,
        projectId: connected.projectId,
        clientEmail: connected.clientEmail,
      });
      setPlatform('google');
      router.push('/dashboard');
    } catch (error) {
      setState((prev) => ({
        ...prev,
        error: error instanceof ConnectError ? error.message : 'Failed to connect. Please try again.',
        errorHelpHref: error instanceof ConnectError ? (error.helpHref ?? null) : null,
        errorHelpText: error instanceof ConnectError ? (error.helpText ?? null) : null,
        isLoading: false,
      }));
    }
  };

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Connect to Google Play</CardTitle>
        <CardDescription>
          Choose your service account JSON file to manage in-app product pricing
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
                ${state.file ? 'border-success-foreground bg-success' : ''}
                ${state.isLoading ? 'opacity-50 pointer-events-none' : 'cursor-pointer'}
              `}
            >
              <input
                ref={fileInput}
                type="file"
                accept=".json"
                onChange={handleFileSelect}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                disabled={state.isLoading}
              />
              <div className="flex flex-col items-center gap-2 text-center">
                {state.file ? (
                  <>
                    <FileJson className="h-10 w-10 text-success-foreground" />
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
            <div className="flex items-start gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span>
                {state.error}
                {state.errorHelpHref && state.errorHelpText && (
                  <>
                    {' '}
                    <Link href={state.errorHelpHref} className="underline font-medium">
                      {state.errorHelpText}
                    </Link>
                  </>
                )}
              </span>
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
          <p className="text-xs text-muted-foreground">{KEY_STAYS_IN_BROWSER}</p>
        </div>
      </CardContent>
    </Card>
  );
}
