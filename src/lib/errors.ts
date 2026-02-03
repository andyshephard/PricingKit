/**
 * Standardized Error Classes for Pricing.io
 *
 * These error classes provide consistent error handling across the application
 * with proper HTTP status codes and structured error information.
 */

/**
 * Base class for all application errors.
 * Includes HTTP status code and optional details for debugging.
 */
export class AppError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public code: string = 'INTERNAL_ERROR',
    public details?: unknown
  ) {
    super(message);
    this.name = 'AppError';
    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Convert to a plain object suitable for JSON responses.
   * Excludes sensitive details in production.
   */
  toJSON(): { error: string; code: string; details?: unknown } {
    const response: { error: string; code: string; details?: unknown } = {
      error: this.message,
      code: this.code,
    };

    // Only include details in development
    if (process.env.NODE_ENV === 'development' && this.details) {
      response.details = this.details;
    }

    return response;
  }
}

/**
 * Authentication error (401).
 * Thrown when credentials are missing, invalid, or expired.
 */
export class AuthenticationError extends AppError {
  constructor(message: string = 'Not authenticated', details?: unknown) {
    super(message, 401, 'AUTHENTICATION_ERROR', details);
    this.name = 'AuthenticationError';
  }
}

/**
 * Authorization error (403).
 * Thrown when user lacks permission to access a resource.
 */
export class AuthorizationError extends AppError {
  constructor(message: string = 'Access denied', details?: unknown) {
    super(message, 403, 'AUTHORIZATION_ERROR', details);
    this.name = 'AuthorizationError';
  }
}

/**
 * Resource not found error (404).
 * Thrown when a requested resource doesn't exist.
 */
export class NotFoundError extends AppError {
  constructor(message: string = 'Resource not found', details?: unknown) {
    super(message, 404, 'NOT_FOUND', details);
    this.name = 'NotFoundError';
  }
}

/**
 * Validation error (400).
 * Thrown when request data fails validation.
 */
export class ValidationError extends AppError {
  constructor(
    message: string = 'Invalid request data',
    public validationErrors?: Array<{ path?: string; message: string }>
  ) {
    super(message, 400, 'VALIDATION_ERROR', validationErrors);
    this.name = 'ValidationError';
  }

  override toJSON() {
    return {
      error: this.message,
      code: this.code,
      details: this.validationErrors,
    };
  }
}

/**
 * Rate limit error (429).
 * Thrown when API rate limits are exceeded.
 */
export class RateLimitError extends AppError {
  constructor(
    message: string = 'Rate limit exceeded. Please try again later.',
    public retryAfter?: number
  ) {
    super(message, 429, 'RATE_LIMIT_EXCEEDED', { retryAfter });
    this.name = 'RateLimitError';
  }
}

/**
 * External API error.
 * Thrown when an external API (Google Play, Apple) returns an error.
 */
export class ExternalApiError extends AppError {
  constructor(
    message: string,
    statusCode: number = 502,
    public provider: 'google' | 'apple',
    public originalError?: unknown
  ) {
    super(message, statusCode, 'EXTERNAL_API_ERROR', {
      provider,
      originalError:
        process.env.NODE_ENV === 'development' ? originalError : undefined,
    });
    this.name = 'ExternalApiError';
  }
}

/**
 * Configuration error.
 * Thrown when required configuration is missing or invalid.
 */
export class ConfigurationError extends AppError {
  constructor(message: string, public missingConfig?: string) {
    super(message, 500, 'CONFIGURATION_ERROR', { missingConfig });
    this.name = 'ConfigurationError';
  }
}

/**
 * Type guard to check if an error is an AppError.
 */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Convert any error to an AppError.
 * Useful for consistent error handling in catch blocks.
 */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof Error) {
    // Check for common error patterns
    if (error.message.includes('401')) {
      return new AuthenticationError('Session expired');
    }
    if (error.message.includes('403')) {
      return new AuthorizationError();
    }
    if (error.message.includes('404')) {
      return new NotFoundError();
    }
    if (error.message.includes('429')) {
      return new RateLimitError();
    }

    return new AppError(error.message);
  }

  return new AppError('An unexpected error occurred');
}

/**
 * Helper to create a standardized error response for API routes.
 */
export function errorResponse(
  error: unknown
): { body: object; status: number } {
  const appError = toAppError(error);
  return {
    body: appError.toJSON(),
    status: appError.statusCode,
  };
}
