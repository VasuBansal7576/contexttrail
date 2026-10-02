import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

/**
 * Project-owned font wiring (F16): Instrument Serif for editorial headings,
 * Geist Sans for UI/body. Local woff2 with robust system fallbacks — no
 * runtime CDN fetch, works offline after build.
 */
const instrumentSerif = localFont({
  src: [
    { path: "./fonts/instrument-serif-latin.woff2", weight: "400", style: "normal" },
    { path: "./fonts/instrument-serif-latin-italic.woff2", weight: "400", style: "italic" },
  ],
  variable: "--font-instrument-serif",
  display: "swap",
});

const geistSans = localFont({
  src: [{ path: "./fonts/geist-sans-latin.woff2", weight: "100 900", style: "normal" }],
  variable: "--font-geist-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ContextTrail — A place for the question",
  description:
    "Follow a question, trace an image, and keep the exact evidence behind your research.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        className={`${instrumentSerif.variable} ${geistSans.variable} bg-paper text-ink antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
