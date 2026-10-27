import { NextRequest, NextResponse } from 'next/server';
import { requireGoogleAuth } from '@/middleware/auth';
import { readJsonBody, rejectCrossSite, SMALL_BODY_LIMIT } from '@/lib/request-guard';
import { packageNameSchema } from '@/lib/validation';
import { probeGooglePackage } from '../_lib/google-probe';

// POST /api/active-app { packageName }
// Checks that the browser's Google access token can read the app. Nothing is
// stored: the browser keeps the selection and sends it as X-PK-App.
export async function POST(request: NextRequest) {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  const auth = requireGoogleAuth(request, { app: 'none' });
  if (!auth.ok) return auth.response;

  const read = await readJsonBody(request, SMALL_BODY_LIMIT);
  if (!read.ok) return read.response;
  const body = (typeof read.body === 'object' && read.body !== null ? read.body : {}) as { packageName?: unknown };

  if (typeof body.packageName !== 'string' || body.packageName.trim() === '') {
    return NextResponse.json(
      { error: 'Missing packageName in request body' },
      { status: 400 }
    );
  }
  const parsedPackage = packageNameSchema.safeParse(body.packageName);
  if (!parsedPackage.success) {
    return NextResponse.json({ error: 'Invalid package name' }, { status: 400 });
  }
  const packageName = parsedPackage.data;

  // Switching apps is read-only: the list call confirms access. Pricing write
  // permission is not probed (that would mean writing to the live store); a
  // missing permission surfaces on the first real edit via the route-level
  // 403 handlers.
  const probe = await probeGooglePackage(auth.tokens, packageName);
  if (probe) return probe;

  return NextResponse.json({ ok: true, packageName });
}
