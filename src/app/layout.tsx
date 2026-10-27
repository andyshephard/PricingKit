import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Manrope } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { THEME_SCRIPT } from "@/components/theme/theme-script";
import { SITE_DESCRIPTION, SITE_NAME, getSiteUrl } from "@/config/site";

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

const TITLE = "PricingKit: regional pricing for the App Store and Google Play";

export const metadata: Metadata = {
  // Absolute URLs for Open Graph and canonical links. Set NEXT_PUBLIC_SITE_URL
  // at build time; see src/config/site.ts.
  metadataBase: getSiteUrl(),
  applicationName: SITE_NAME,
  title: { default: TITLE, template: `%s · ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    title: TITLE,
    description: SITE_DESCRIPTION,
    url: "/",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "PricingKit: one price doesn't fit 175 countries" }],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: SITE_DESCRIPTION,
    images: ["/og.png"],
  },
  // icon.svg and apple-icon.png in this folder are picked up by convention.
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f7f9" },
    { media: "(prefers-color-scheme: dark)", color: "#0e1116" },
  ],
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
