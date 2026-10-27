import type { Metadata } from "next";

// Self-hosted, never fetched at build time: see the note at the top of fonts.css.
import "./fonts/fonts.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Task Tracker",
  description: "Everything you said you'd do, with a deadline on it.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
