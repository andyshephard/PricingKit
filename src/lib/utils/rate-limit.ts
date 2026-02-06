/**
 * Rate-limited promise execution utility
 * Processes tasks with controlled concurrency and retry logic
 */

export interface RateLimitOptions {
  /** Max concurrent requests (default: 3) */
  concurrency?: number;
  /** ms delay between batches (default: 100) */
  delayBetweenBatches?: number;
  /** Retry attempts for failures (default: 3) */
  maxRetries?: number;
  /** Base delay for exponential backoff in ms (default: 1000) */
  retryDelay?: number;
  /** HTTP status codes that should trigger a retry (default: [500, 502, 503, 504, 429]) */
  retryableStatusCodes?: number[];
}

export class RateLimitError extends Error {
  constructor(
    message: string,
    public successCount: number,
    public totalCount: number,
    public failedIndex: number,
    public originalError: Error
  ) {
    super(message);
    this.name = 'RateLimitError';
  }
}

interface RetryableError {
  statusCode?: number;
}

function isRetryableError(error: unknown, retryableStatusCodes: number[]): boolean {
  if (error && typeof error === 'object' && 'statusCode' in error) {
    const statusCode = (error as RetryableError).statusCode;
    return typeof statusCode === 'number' && retryableStatusCodes.includes(statusCode);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute an array of task functions with rate limiting
 *
 * @param tasks - Array of functions that return promises (not promises themselves)
 * @param options - Rate limiting configuration
 * @returns Array of results in the same order as input tasks
 * @throws RateLimitError if a task fails after all retries
 *
 * @example
 * ```typescript
 * const tasks = urls.map(url => () => fetch(url));
 * const results = await executeWithRateLimit(tasks, { concurrency: 3 });
 * ```
 */
export async function executeWithRateLimit<T>(
  tasks: (() => Promise<T>)[],
  options?: RateLimitOptions
): Promise<T[]> {
  const {
    concurrency = 3,
    delayBetweenBatches = 100,
    maxRetries = 3,
    retryDelay = 1000,
    retryableStatusCodes = [500, 502, 503, 504, 429],
  } = options ?? {};

  const results: T[] = new Array(tasks.length);
  let completedCount = 0;

  // Process a single task with retries
  async function processWithRetry(
    task: () => Promise<T>,
    index: number
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await task();
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if we should retry
        if (attempt < maxRetries && isRetryableError(error, retryableStatusCodes)) {
          // Exponential backoff with jitter: retryDelay * 2^attempt * (0.5 + random)
          const delay = retryDelay * Math.pow(2, attempt) * (0.5 + Math.random());
          console.log(
            `[RateLimit] Task ${index + 1}/${tasks.length} failed with retryable error, ` +
            `attempt ${attempt + 1}/${maxRetries + 1}, retrying in ${delay}ms...`
          );
          await sleep(delay);
          continue;
        }

        // Non-retryable error or max retries exhausted
        break;
      }
    }

    // Task failed after all retries
    throw lastError;
  }

  // Process tasks in batches with controlled concurrency
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    const batchStartIndex = i;

    // Add delay between batches (but not before the first batch)
    if (i > 0 && delayBetweenBatches > 0) {
      await sleep(delayBetweenBatches);
    }

    console.log(
      `[RateLimit] Processing batch ${Math.floor(i / concurrency) + 1}/${Math.ceil(tasks.length / concurrency)} ` +
      `(tasks ${i + 1}-${Math.min(i + concurrency, tasks.length)} of ${tasks.length})`
    );

    // Process batch concurrently
    const batchPromises = batch.map(async (task, batchIndex) => {
      const absoluteIndex = batchStartIndex + batchIndex;
      try {
        const result = await processWithRetry(task, absoluteIndex);
        results[absoluteIndex] = result;
        completedCount++;
        return { success: true as const, index: absoluteIndex };
      } catch (error) {
        return {
          success: false as const,
          index: absoluteIndex,
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    });

    const batchResults = await Promise.all(batchPromises);

    // Check for failures (fail-fast)
    const failure = batchResults.find(r => !r.success);
    if (failure && !failure.success) {
      throw new RateLimitError(
        `Task ${failure.index + 1} of ${tasks.length} failed after ${maxRetries + 1} attempts: ${failure.error.message}`,
        completedCount,
        tasks.length,
        failure.index,
        failure.error
      );
    }
  }

  return results;
}
