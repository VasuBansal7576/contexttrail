import type { Metadata } from "next";
import { getChatGPTUser, chatGPTSignInPath } from "./chatgpt-auth";
import localFont from "next/font/local";
import "./globals.css";
import { ChapterTurnProvider } from '@/components/casebook/ChapterTurn';

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
  adjustFontFallback: false,
});

const geistSans = localFont({
  src: [{ path: "./fonts/geist-sans-latin.woff2", weight: "100 900", style: "normal" }],
  variable: "--font-geist-sans",
  display: "swap",
  adjustFontFallback: false,
});

export const metadata: Metadata = {
  title: "ContextTrail — A place for the question",
  description:
    "Follow a question, trace an image, and keep the exact evidence behind your research.",
};

export const dynamic = "force-dynamic";
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getChatGPTUser();
  return (
    <html lang="en">
      <body
        className={`${instrumentSerif.variable} ${geistSans.variable} bg-paper text-ink antialiased`}
      >
        <div className="public-trial-account"><span>Public trial · 3 attempts per day · shared allowance</span>{user ? <a href="/signout-with-chatgpt?return_to=%2F" target="_top">Sign out</a> : <a href={chatGPTSignInPath("/questions")} target="_top">Sign in with ChatGPT to try it</a>}</div>
        <ChapterTurnProvider>{children}</ChapterTurnProvider>
      </body>
    </html>
  );
}
