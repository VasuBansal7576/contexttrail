import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ContextTrail — Every image has a history",
  description:
    "ContextTrail traces where an image has appeared across the web, reconstructs how its context changed, and shows you the evidence trail.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-paper text-ink antialiased">{children}</body>
    </html>
  );
}
