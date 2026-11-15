import type { Metadata } from "next";
import { Atkinson_Hyperlegible_Next } from "next/font/google";
import "./globals.css";

const atkinson = Atkinson_Hyperlegible_Next({ variable: "--font-atkinson", subsets: ["latin"], weight: ["400", "700"] });

export const metadata: Metadata = {
  title: "Lunar Prime: sunlight and Earth visibility for two lunar sites",
  description:
    "Compare lunar landing sites by geometric sunlight and direct-to-Earth visibility, computed with NASA NAIF SPICE.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${atkinson.variable} h-full antialiased`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
