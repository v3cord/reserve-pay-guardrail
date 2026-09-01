import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Silkscreen } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

const silkscreen = Silkscreen({
  weight: ["400", "700"],
  subsets: ["latin"],
  variable: "--font-pixel",
  display: "swap",
});


const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});

const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "Reserve Pay Guardrail // Autonomous AI Commerce Financial Policy Engine",
  description: "The Layer Between Agent Decides and Money Moves — Atomic Reservation + Compensating Payment Workflow with Integer Paise Ledger & SHA-256 Verification",
  icons: {
    icon: "https://framerusercontent.com/images/OgsUEuFRkZSTBJlB7D7f76yV6Y.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${inter.variable} ${jetbrainsMono.variable} ${silkscreen.variable} ${geistSans.variable} ${geistMono.variable} font-sans bg-black text-[#f0f1f1] antialiased selection:bg-[#ff571a] selection:text-white`}
      >
        {children}
      </body>
    </html>
  );
}


