import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Loop Harmonizer",
  description: "節拍器同步、音檔載入、Tempo 時間軸、即時切 Beat、Tap Tempo"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
