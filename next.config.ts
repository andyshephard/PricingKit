import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import { securityHeaders } from "./src/lib/security-headers";

initOpenNextCloudflareForDev();

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: '/(.*)',
        // 'unsafe-eval' in the CSP only under `next dev` (React's dev tooling needs it)
        headers: securityHeaders(process.env.NODE_ENV === 'development'),
      },
    ];
  },
};

export default nextConfig;
