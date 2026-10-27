import type { Metadata } from "next";
import { IBM_Plex_Mono, Manrope } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { THEME_SCRIPT } from "@/components/theme/theme-script";

// next/font downloads the fonts at build time and serves them from this
// origin: no request to Google Fonts at runtime.
const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL('https://pricing-kit.com'),
  title: "PricingKit - Free, Open-Source Regional Pricing for the App Store & Google Play",
  description: "Free, open-source regional pricing tool for the App Store and Google Play. Set PPP-adjusted prices across 175+ territories in one click. Credentials stay in an encrypted HttpOnly cookie and are never stored server-side — or self-host it.",
  openGraph: {
    title: "PricingKit - Free, Open-Source Regional Pricing for the App Store & Google Play",
    description: "Free, open-source regional pricing tool for the App Store and Google Play. Set PPP-adjusted prices across 175+ territories in one click. Credentials stay in an encrypted HttpOnly cookie and are never stored server-side — or self-host it.",
    images: [{ url: '/banner.webp', width: 2202, height: 1222 }],
  },
  twitter: {
    card: 'summary_large_image',
    title: "PricingKit - Free, Open-Source Regional Pricing for the App Store & Google Play",
    description: "Free, open-source regional pricing tool for the App Store and Google Play. Set PPP-adjusted prices across 175+ territories in one click. Credentials stay in an encrypted HttpOnly cookie and are never stored server-side — or self-host it.",
    images: ['/banner.webp'],
  },
  icons: {
    icon: [
      { url: '/favicon.ico' },
      { url: '/favicon/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicon/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
    ],
    apple: '/favicon/apple-touch-icon.png',
  },
  manifest: '/favicon/site.webmanifest',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Sets the light/dark class before first paint; see theme-script.ts. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body
        className={`${manrope.variable} ${plexMono.variable} antialiased`}
      >
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
