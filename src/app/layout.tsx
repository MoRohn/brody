import type { Metadata } from "next";
import { Geist, Geist_Mono, Lora, Playfair_Display, Unbounded } from "next/font/google";
import "./globals.css";
import { themeInitScript } from "@/lib/theme";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const playfair = Playfair_Display({ variable: "--font-serif", subsets: ["latin"] });
const lora = Lora({ variable: "--font-document", subsets: ["latin"] });
// The product wordmark only: a wide geometric face that is unmistakably Brody and nothing else in the interface.
const unbounded = Unbounded({ variable: "--font-brand", subsets: ["latin"], weight: ["600", "700"] });

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
