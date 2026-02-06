#!/usr/bin/env npx tsx

/**
 * Apple App Store Connect JWT Generator
 *
 * Generates a JWT for authenticating with the App Store Connect API.
 *
 * Usage:
 *   APPLE_KEY_ID=ABC123 APPLE_ISSUER_ID=DEF456 APPLE_KEY_FILE=./AuthKey.p8 npx tsx scripts/apple-jwt.ts
 *
 * Environment Variables:
 *   APPLE_KEY_ID    - Your API key ID from App Store Connect
 *   APPLE_ISSUER_ID - Your issuer ID from App Store Connect
 *   APPLE_KEY_FILE  - Path to your .p8 private key file
 *
 * Output:
 *   The JWT token is printed to stdout (for easy piping/copying)
 *   Errors are printed to stderr
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const JWT_EXPIRY_SECONDS = 20 * 60; // 20 minutes (max allowed by Apple)

function base64UrlEncode(str: string): string {
  return Buffer.from(str)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function base64ToBase64Url(base64: string): string {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function generateJWT(keyId: string, issuerId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + JWT_EXPIRY_SECONDS;

  // JWT Header
  const header = {
    alg: 'ES256',
    kid: keyId,
    typ: 'JWT',
  };

  // JWT Payload
  const payload = {
    iss: issuerId,
    iat: now,
    exp: expiresAt,
    aud: 'appstoreconnect-v1',
  };

  // Encode header and payload
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));

  // Create signature
  const signatureInput = `${encodedHeader}.${encodedPayload}`;
  const sign = crypto.createSign('SHA256');
  sign.update(signatureInput);
  sign.end();

  // Sign with the private key
  const signature = sign.sign(
    {
      key: privateKey,
      dsaEncoding: 'ieee-p1363', // Required for ES256
    },
    'base64'
  );

  // Convert base64 to base64url
  const encodedSignature = base64ToBase64Url(signature);

  return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
}

function main(): void {
  const keyId = process.env.APPLE_KEY_ID;
  const issuerId = process.env.APPLE_ISSUER_ID;
  const keyFilePath = process.env.APPLE_KEY_FILE;

  // Validate required environment variables
  const missing: string[] = [];
  if (!keyId) missing.push('APPLE_KEY_ID');
  if (!issuerId) missing.push('APPLE_ISSUER_ID');
  if (!keyFilePath) missing.push('APPLE_KEY_FILE');

  if (missing.length > 0) {
    console.error('Error: Missing required environment variables:', missing.join(', '));
    console.error('');
    console.error('Usage:');
    console.error('  APPLE_KEY_ID=ABC123 APPLE_ISSUER_ID=DEF456 APPLE_KEY_FILE=./AuthKey.p8 npx tsx scripts/apple-jwt.ts');
    console.error('');
    console.error('Environment Variables:');
    console.error('  APPLE_KEY_ID    - Your API key ID from App Store Connect');
    console.error('  APPLE_ISSUER_ID - Your issuer ID from App Store Connect');
    console.error('  APPLE_KEY_FILE  - Path to your .p8 private key file');
    process.exit(1);
  }

  // At this point, TypeScript doesn't know process.exit never returns,
  // so we use non-null assertions after the validation above
  const validKeyId = keyId!;
  const validIssuerId = issuerId!;
  const validKeyFilePath = keyFilePath!;

  // Resolve the key file path
  const resolvedKeyPath = path.resolve(validKeyFilePath);

  // Check if file exists
  if (!fs.existsSync(resolvedKeyPath)) {
    console.error(`Error: Private key file not found: ${resolvedKeyPath}`);
    process.exit(1);
  }

  // Read the private key
  let privateKey: string;
  try {
    privateKey = fs.readFileSync(resolvedKeyPath, 'utf-8');
  } catch (error) {
    console.error(`Error: Failed to read private key file: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  // Validate the private key format
  if (!privateKey.includes('-----BEGIN PRIVATE KEY-----') && !privateKey.includes('-----BEGIN EC PRIVATE KEY-----')) {
    console.error('Error: Invalid private key format. Expected a PEM-formatted private key.');
    process.exit(1);
  }

  // Generate and output the JWT
  try {
    const token = generateJWT(validKeyId, validIssuerId, privateKey);
    console.log(token);
  } catch (error) {
    console.error(`Error: Failed to generate JWT: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

main();
