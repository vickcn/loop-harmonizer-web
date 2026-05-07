import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Loop Harmonizer M0",
  description: "Web M0 for loop timeline, tap tempo, and live BPM transitions"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
