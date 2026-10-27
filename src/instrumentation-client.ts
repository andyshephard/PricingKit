// Runs in the browser before any app code (Next.js instrumentation-client).
//
// zod 4 checks once whether it may compile parsers with `new Function`. Our
// Content-Security-Policy forbids eval, so the check fails (zod falls back),
// but the browser still reports it as a CSP violation on every page that
// loads a schema, including routes prefetched from a link. Running zod
// without that check keeps the policy's reports meaningful; parsing is the
// same, only without the eval fast path the policy blocks anyway.
import { config } from 'zod';

config({ jitless: true });
