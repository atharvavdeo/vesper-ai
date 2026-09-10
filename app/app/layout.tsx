import type { Metadata, Viewport } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { Inter, Instrument_Serif, Geist_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: "400",
  style: "italic",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "https://vesper-ai.vercel.app"),
  title: "Vesper.ai — Verify every site observation before it is logged",
  description: "Voice-led construction site intelligence that checks spoken observations against current drawings, RFIs, BOQs and permits before they are logged.",
  keywords: ["construction site voice assistant", "site observation software", "drawing verification", "construction QA", "RFI", "construction AI"],
  openGraph: {
    title: "Vesper.ai — Verify every site observation before it is logged",
    description: "Voice-led construction site intelligence grounded in current drawings, RFIs and permits.",
    images: ["/brand/vesper-mark.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "Vesper.ai — Verify every site observation before it is logged",
    description: "Voice-led construction site intelligence grounded in current drawings, RFIs and permits.",
    images: ["/brand/vesper-mark.png"],
  },
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/brand/vesper-mark.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#000000",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${instrumentSerif.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <meta name="theme-color" content="#000000" />
        <meta name="color-scheme" content="dark" />
      </head>
      <body className="min-h-full flex flex-col bg-black text-white selection:bg-white/20 selection:text-white">
        <ClerkProvider>
          {children}
        </ClerkProvider>
      </body>
    </html>
  );
}
