'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Upload, FileJson, Key, AlertCircle, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuthStore } from '@/store/auth-store';

interface ConnectPlatformModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  platform: 'google' | 'apple';
}

interface UploadState {
  isDragging: boolean;
  file: File | null;
  error: string | null;
  isLoading: boolean;
}

export function ConnectPlatformModal({
  open,
  onOpenChange,
  platform,
}: ConnectPlatformModalProps) {
  const router = useRouter();
  const setGoogleAuthenticated = useAuthStore(
    (state) => state.setGoogleAuthenticated
  );
  const setAppleAuthenticated = useAuthStore(
    (state) => state.setAppleAuthenticated
  );
  const setPlatform = useAuthStore((state) => state.setPlatform);

  // Google-specific state
  const [packageName, setPackageName] = useState('');

  // Apple-specific state
  const [keyId, setKeyId] = useState('');
  const [issuerId, setIssuerId] = useState('');
  const [bundleId, setBundleId] = useState('');

  const [state, setState] = useState<UploadState>({
    isDragging: false,
    file: null,
    error: null,
    isLoading: false,
  });

  const resetState = () => {
    setPackageName('');
    setKeyId('');
    setIssuerId('');
    setBundleId('');
    setState({
      isDragging: false,
      file: null,
      error: null,
      isLoading: false,
    });
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      resetState();
    }
    onOpenChange(open);
  };

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setState((prev) => ({ ...prev, isDragging: true }));
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setState((prev) => ({ ...prev, isDragging: false }));
  }, []);

  const validateFile = (file: File): boolean => {
    if (platform === 'google') {
      if (!file.name.endsWith('.json')) {
        setState((prev) => ({
          ...prev,
          error: 'Please upload a JSON file',
          file: null,
        }));
        return false;
      }
      if (file.size > 50 * 1024) {
        setState((prev) => ({
          ...prev,
          error: 'File is too large. Service account files are typically under 5KB.',
          file: null,
        }));
        return false;
      }
    } else {
      if (!file.name.endsWith('.p8')) {
        setState((prev) => ({
          ...prev,
          error: 'Please upload a .p8 file (Apple API Key)',
          file: null,
        }));
        return false;
      }
      if (file.size > 10 * 1024) {
        setState((prev) => ({
          ...prev,
          error: 'File is too large. Apple API keys are typically under 1KB.',
          file: null,
        }));
        return false;
      }
    }
    return true;
  };

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setState((prev) => ({ ...prev, isDragging: false }));

      const file = e.dataTransfer.files[0];
      if (file && validateFile(file)) {
        setState((prev) => ({ ...prev, file, error: null }));
      }
    },
    [platform]
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file && validateFile(file)) {
        setState((prev) => ({ ...prev, file, error: null }));
      }
    },
    [platform]
  );

  const handleGoogleSubmit = async () => {
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
      handleOpenChange(false);
    } catch (error) {
      console.error('Upload error:', error);
      setState((prev) => ({
        ...prev,
        error: 'Failed to connect. Please try again.',
        isLoading: false,
      }));
    }
  };

  const handleAppleSubmit = async () => {
    if (
      !state.file ||
      !keyId.trim() ||
      !issuerId.trim() ||
      !bundleId.trim()
    ) {
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
      handleOpenChange(false);
    } catch (error) {
      console.error('Upload error:', error);
      setState((prev) => ({
        ...prev,
        error: 'Failed to connect. Please try again.',
        isLoading: false,
      }));
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (platform === 'google') {
      handleGoogleSubmit();
    } else {
      handleAppleSubmit();
    }
  };

  const isFormValid =
    platform === 'google'
      ? state.file && packageName.trim()
      : state.file && keyId.trim() && issuerId.trim() && bundleId.trim();

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Connect to {platform === 'google' ? 'Google Play' : 'App Store Connect'}
          </DialogTitle>
          <DialogDescription>
            {platform === 'google'
              ? 'Upload your service account JSON file to connect'
              : 'Upload your API key (.p8 file) to connect'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {platform === 'google' ? (
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
          ) : (
            <>
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
                    placeholder="xxxxxxxx-xxxx-xxxx"
                    value={issuerId}
                    onChange={(e) => setIssuerId(e.target.value)}
                    disabled={state.isLoading}
                  />
                </div>
              </div>
            </>
          )}

          <div className="space-y-2">
            <Label>
              {platform === 'google' ? 'Service Account JSON' : 'API Key (.p8 file)'}
            </Label>
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`
                relative border-2 border-dashed rounded-lg p-4 transition-colors
                ${state.isDragging ? 'border-primary bg-primary/5' : 'border-muted-foreground/25'}
                ${state.file ? 'border-green-500 bg-green-50 dark:bg-green-950/20' : ''}
                ${state.isLoading ? 'opacity-50 pointer-events-none' : 'cursor-pointer'}
              `}
            >
              <input
                type="file"
                accept={platform === 'google' ? '.json' : '.p8'}
                onChange={handleFileSelect}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                disabled={state.isLoading}
              />
              <div className="flex flex-col items-center gap-2 text-center">
                {state.file ? (
                  <>
                    {platform === 'google' ? (
                      <FileJson className="h-8 w-8 text-green-500" />
                    ) : (
                      <Key className="h-8 w-8 text-green-500" />
                    )}
                    <p className="text-sm font-medium">{state.file.name}</p>
                    <p className="text-xs text-muted-foreground">
                      Click or drag to replace
                    </p>
                  </>
                ) : (
                  <>
                    <Upload className="h-8 w-8 text-muted-foreground" />
                    <p className="text-sm font-medium">
                      Drop your {platform === 'google' ? 'JSON' : '.p8'} file here
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
            disabled={!isFormValid || state.isLoading}
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
      </DialogContent>
    </Dialog>
  );
}
