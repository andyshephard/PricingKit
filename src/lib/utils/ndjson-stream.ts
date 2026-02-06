/**
 * Server-side NDJSON (Newline-Delimited JSON) streaming utility.
 * Creates a ReadableStream and a writer object for sending progress events.
 */

type ProgressEvent = {
  type: 'progress';
  completed: number;
  total: number;
  phase?: string;
};

type DoneEvent = {
  type: 'done';
  data: unknown;
};

type ErrorEvent = {
  type: 'error';
  error: string;
  completed?: number;
  total?: number;
};

type StreamEvent = ProgressEvent | DoneEvent | ErrorEvent;

interface NdjsonWriter {
  progress(completed: number, total: number, phase?: string): void;
  done(data: unknown): void;
  error(message: string, completed?: number, total?: number): void;
}

const encoder = new TextEncoder();

export function createNdjsonStream(): { stream: ReadableStream; writer: NdjsonWriter } {
  let controller: ReadableStreamDefaultController;

  const stream = new ReadableStream({
    start(c) {
      controller = c;
    },
  });

  function enqueue(event: StreamEvent) {
    try {
      controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
    } catch {
      // Stream already closed
    }
  }

  function close() {
    try {
      controller.close();
    } catch {
      // Stream already closed
    }
  }

  const writer: NdjsonWriter = {
    progress(completed, total, phase) {
      const event: ProgressEvent = { type: 'progress', completed, total };
      if (phase) event.phase = phase;
      enqueue(event);
    },
    done(data) {
      enqueue({ type: 'done', data });
      close();
    },
    error(message, completed, total) {
      const event: ErrorEvent = { type: 'error', error: message };
      if (completed !== undefined) event.completed = completed;
      if (total !== undefined) event.total = total;
      enqueue(event);
      close();
    },
  };

  return { stream, writer };
}

export const NDJSON_HEADERS = {
  'Content-Type': 'application/x-ndjson',
  'Transfer-Encoding': 'chunked',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
};
