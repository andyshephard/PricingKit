import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "PricingKit - Free, Open-Source tool for Google Play / App Store Pricing",
  description: "A free and open-source tool to manage in-app product and subscription pricing for Google Play and Apple App Store",
  openGraph: {
    title: "PricingKit - Free, Open-Source tool for Google Play / App Store Pricing",
    description: "A free and open-source tool to manage in-app product and subscription pricing for Google Play and Apple App Store",
    images: [{ url: '/banner.webp' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: "PricingKit - Free, Open-Source tool for Google Play / App Store Pricing",
    description: "A free and open-source tool to manage in-app product and subscription pricing for Google Play and Apple App Store",
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
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
