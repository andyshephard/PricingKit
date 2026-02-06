'use client';

import { useState, useCallback, useRef } from 'react';

export interface StreamProgress {
  completed: number;
  total: number;
  phase?: string;
}

interface StreamingMutationState<T> {
  isPending: boolean;
  progress: StreamProgress | null;
  error: Error | null;
  data: T | null;
}

export function useStreamingMutation<T = unknown>() {
  const [state, setState] = useState<StreamingMutationState<T>>({
    isPending: false,
    progress: null,
    error: null,
    data: null,
  });
  const abortRef = useRef<AbortController | null>(null);

  const mutateAsync = useCallback(async (url: string, fetchOptions?: RequestInit): Promise<T> => {
    abortRef.current?.abort();
    const abortController = new AbortController();
    abortRef.current = abortController;

    setState({ isPending: true, progress: null, error: null, data: null });

    const response = await fetch(url, {
      ...fetchOptions,
      signal: abortController.signal,
    });

    const contentType = response.headers.get('Content-Type') || '';

    // Non-streaming response (early error or non-NDJSON)
    if (!contentType.includes('application/x-ndjson')) {
      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: 'Request failed' }));
        const error = new Error(body.error || `Request failed with status ${response.status}`);
        setState(prev => ({ ...prev, isPending: false, error }));
        throw error;
      }
      const data = await response.json() as T;
      setState({ isPending: false, progress: null, error: null, data });
      return data;
    }

    // Streaming NDJSON response
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    return new Promise<T>((resolve, reject) => {
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop()!; // Keep incomplete line in buffer

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;

              const event = JSON.parse(trimmed);

              if (event.type === 'progress') {
                setState(prev => ({
                  ...prev,
                  progress: {
                    completed: event.completed,
                    total: event.total,
                    phase: event.phase,
                  },
                }));
              } else if (event.type === 'done') {
                const data = event.data as T;
                setState({ isPending: false, progress: null, error: null, data });
                resolve(data);
                return;
              } else if (event.type === 'error') {
                const error = new Error(event.error);
                setState(prev => ({ ...prev, isPending: false, error }));
                reject(error);
                return;
              }
            }
          }

          // Stream ended without a done/error event — treat remaining buffer
          if (buffer.trim()) {
            const event = JSON.parse(buffer.trim());
            if (event.type === 'done') {
              const data = event.data as T;
              setState({ isPending: false, progress: null, error: null, data });
              resolve(data);
              return;
            } else if (event.type === 'error') {
              const error = new Error(event.error);
              setState(prev => ({ ...prev, isPending: false, error }));
              reject(error);
              return;
            }
          }

          // Stream closed without final event
          const error = new Error('Stream ended unexpectedly');
          setState(prev => ({ ...prev, isPending: false, error }));
          reject(error);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          setState(prev => ({ ...prev, isPending: false, error }));
          reject(error);
        }
      })();
    });
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setState({ isPending: false, progress: null, error: null, data: null });
  }, []);

  return {
    mutateAsync,
    isPending: state.isPending,
    progress: state.progress,
    error: state.error,
    data: state.data,
    reset,
  };
}
