import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Duka Ledger — test console",
  description:
    "Local test console for the Duka Ledger WhatsApp bot. No Meta, no ngrok.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
