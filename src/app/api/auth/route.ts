import { NextRequest, NextResponse } from 'next/server';
import { requireGoogleAuth } from '@/middleware/auth';
import { rejectCrossSite } from '@/lib/request-guard';
import { probeGooglePackage } from '../_lib/google-probe';
import { limitConnectCheck } from '../_lib/connect-limit';

// POST /api/auth (Google Play connect check)
// The browser mints the access token itself from the key it keeps and sends
// it as X-PK-Google-Token, with the package name as X-PK-App. This makes one
// read-only call to show the token can read that app. Nothing is stored and
// no cookie is set.
export async function POST(request: NextRequest) {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  const auth = requireGoogleAuth(request);
  if (!auth.ok) return auth.response;
  const limited = limitConnectCheck();
  if (limited) return limited;

  const probe = await probeGooglePackage(auth.tokens, auth.packageName);
  if (probe) return probe;
  return NextResponse.json({ success: true, packageName: auth.packageName });
}
