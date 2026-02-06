import { z } from 'zod';

/**
 * SKU/Product ID validation for Google Play
 * - Must be alphanumeric, underscores, or periods
 * - Must start with a letter or number
 * - Max 150 characters (Google Play limit)
 */
export const googlePlaySkuSchema = z
  .string()
  .min(1, 'SKU cannot be empty')
  .max(150, 'SKU exceeds maximum length of 150 characters')
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9._]*$/,
    'SKU must start with a letter or number and contain only letters, numbers, underscores, or periods'
  );

/**
 * Base plan ID validation for Google Play
 * - Same as SKU but also allows hyphens
 * - Must start with a letter or number
 * - Max 150 characters
 */
export const googlePlayBasePlanIdSchema = z
  .string()
  .min(1, 'Base plan ID cannot be empty')
  .max(150, 'Base plan ID exceeds maximum length of 150 characters')
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
    'Base plan ID must start with a letter or number and contain only letters, numbers, underscores, periods, or hyphens'
  );

/**
 * Product ID validation for Apple App Store Connect
 * - Must be alphanumeric, underscores, or periods
 * - Must start with a letter or number
 * - Max 100 characters
 */
export const appleProductIdSchema = z
  .string()
  .min(1, 'Product ID cannot be empty')
  .max(100, 'Product ID exceeds maximum length of 100 characters')
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9._]*$/,
    'Product ID must start with a letter or number and contain only letters, numbers, underscores, or periods'
  );

/**
 * Apple internal ID validation (numeric string)
 */
export const appleInternalIdSchema = z
  .string()
  .min(1, 'ID cannot be empty')
  .max(20, 'ID exceeds maximum length')
  .regex(/^[0-9]+$/, 'ID must be numeric');

/**
 * Region/territory code validation
 * - ISO 3166-1 alpha-2 (2 letters) or alpha-3 (3 letters)
 */
export const regionCodeSchema = z
  .string()
  .min(2, 'Region code must be at least 2 characters')
  .max(3, 'Region code must be at most 3 characters')
  .regex(/^[A-Z]{2,3}$/, 'Region code must be uppercase letters only (ISO 3166-1)');

/**
 * ISO 4217 currency code validation
 * - Exactly 3 uppercase letters
 */
export const currencyCodeSchema = z
  .string()
  .length(3, 'Currency code must be exactly 3 characters')
  .regex(/^[A-Z]{3}$/, 'Currency code must be 3 uppercase letters (ISO 4217)');

/**
 * Money object validation with proper currency code
 */
export const moneySchema = z.object({
  currencyCode: currencyCodeSchema,
  units: z.string().regex(/^-?\d+$/, 'Units must be a numeric string'),
  nanos: z.number().int().min(-999999999).max(999999999).optional(),
});

/**
 * Package name validation for Google Play
 * - Must follow Java package naming (reverse domain notation)
 * - Max 150 characters
 */
export const packageNameSchema = z
  .string()
  .min(1, 'Package name cannot be empty')
  .max(150, 'Package name exceeds maximum length of 150 characters')
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/,
    'Package name must follow Java package naming convention (e.g., com.example.app)'
  );

/**
 * Bundle ID validation for Apple
 * - Must follow reverse domain notation
 * - Max 155 characters
 */
export const bundleIdSchema = z
  .string()
  .min(1, 'Bundle ID cannot be empty')
  .max(155, 'Bundle ID exceeds maximum length of 155 characters')
  .regex(
    /^[a-zA-Z][a-zA-Z0-9-]*(\.[a-zA-Z][a-zA-Z0-9-]*)+$/,
    'Bundle ID must follow reverse domain notation (e.g., com.example.app)'
  );

/**
 * Validates and decodes a URL-encoded SKU parameter
 * Returns the decoded SKU if valid, or throws an error
 */
export function validateAndDecodeSku(encodedSku: string): string {
  const decoded = decodeURIComponent(encodedSku);
  const result = googlePlaySkuSchema.safeParse(decoded);
  if (!result.success) {
    throw new ValidationError('Invalid SKU', result.error.issues);
  }
  return decoded;
}

/**
 * Validates and decodes a URL-encoded Apple product ID parameter
 */
export function validateAndDecodeAppleProductId(encodedId: string): string {
  const decoded = decodeURIComponent(encodedId);
  const result = appleProductIdSchema.safeParse(decoded);
  if (!result.success) {
    throw new ValidationError('Invalid product ID', result.error.issues);
  }
  return decoded;
}

/**
 * Validates an Apple internal ID (numeric)
 */
export function validateAppleInternalId(id: string): string {
  const result = appleInternalIdSchema.safeParse(id);
  if (!result.success) {
    throw new ValidationError('Invalid Apple ID', result.error.issues);
  }
  return id;
}

/**
 * Custom validation error with details
 */
export class ValidationError extends Error {
  constructor(
    message: string,
    public details: z.ZodIssue[] = []
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Type for validation result
 */
export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; details: z.ZodIssue[] };

/**
 * Safe validation wrapper that returns a result object
 */
export function validateSafe<T>(
  schema: z.ZodSchema<T>,
  data: unknown
): ValidationResult<T> {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    error: result.error.issues[0]?.message || 'Validation failed',
    details: result.error.issues,
  };
}
