import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});
const mono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "KFAI — Agentic Assistant",
  description: "KFAI — agentic AI assistant with captcha-verified login and per-user isolated environments.",
  keywords: ["KFAI", "agentic AI", "krouter", "AI assistant", "tool calling", "captcha auth"],
  authors: [{ name: "kangwifi" }],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="id" suppressHydrationWarning>
      <body className={`${inter.variable} ${mono.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}
