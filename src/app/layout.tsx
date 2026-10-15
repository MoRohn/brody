import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { themeInitScript } from "@/lib/theme";

// The fonts ship with the app (latin subsets from Google Fonts, SIL Open Font License; see fonts/*.OFL.txt), so a build
// never downloads them: no network needed, and no build broken by a changed Google Fonts response.
const geistSans = localFont({ src: "./fonts/geist-latin.woff2", weight: "100 900", variable: "--font-geist-sans" });
const geistMono = localFont({ src: "./fonts/geist-mono-latin.woff2", weight: "100 900", variable: "--font-geist-mono", adjustFontFallback: false });
const playfair = localFont({ src: "./fonts/playfair-display-latin.woff2", weight: "400 900", variable: "--font-serif", adjustFontFallback: "Times New Roman" });
const lora = localFont({ src: "./fonts/lora-latin.woff2", weight: "400 700", variable: "--font-document", adjustFontFallback: "Times New Roman" });
// The product wordmark only: a wide geometric face that is unmistakably Brody and nothing else in the interface.
const unbounded = localFont({ src: "./fonts/unbounded-latin.woff2", weight: "600 700", variable: "--font-brand" });

export const metadata: Metadata = {
  title: "Brody: Repository Intelligence",
  description: "Turn source code into system understanding: review, explanation and code map for any repository.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${playfair.variable} ${lora.variable} ${unbounded.variable} antialiased`} suppressHydrationWarning>
      <head>
        {/* Sets data-level before hydration, so the attribute legitimately differs from the server's HTML.
            brody-ignore: innerhtml (a constant script built from Brody's own theme ids, no request data) */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
