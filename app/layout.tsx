import type { Metadata } from "next";
import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/ThemeProvider";
import { TooltipLayer } from "@/components/TooltipLayer";
import { LeaveGuardProvider } from "@/components/LeaveGuardProvider";
import { themeNoFlashScript } from "@/components/theme-no-flash-script";

const display = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["400", "500", "600", "700"],
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  // 800 is the heaviest weight Google ships for JetBrains Mono. We need it
  // for the lane-gate letters drawn on the canvas — without it the browser
  // silently falls back to the next-loaded weight (700), so a 900 request
  // looks identical to font-bold.
  weight: ["400", "600", "700", "800"],
});

export const metadata: Metadata = {
  title: "SYNCLE",
  description: "4K rhythm game. Random song. Endless retries.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${mono.variable}`}
      // Default theme used until the inline script below overwrites it
      // (which happens before first paint, so this is just a fallback for
      // environments with JS disabled).
      data-theme="dark"
      // suppressHydrationWarning: the inline script flips data-theme on
      // <html> before React hydrates, which differs from the SSR markup
      // by design. Without this, React would log a mismatch warning.
      suppressHydrationWarning
    >
      <head>
        <script
          // Runs before React hydration. Reads the persisted theme and
          // sets data-theme on <html> so first paint is already correct.
          dangerouslySetInnerHTML={{ __html: themeNoFlashScript }}
        />
      </head>
      <body>
        <ThemeProvider>
          {/* LeaveGuardProvider sits inside ThemeProvider so its
              modal inherits the same theme tokens. Inert when no
              page registers a guard — the cost on idle pages is one
              context value + a couple of refs. */}
          <LeaveGuardProvider>{children}</LeaveGuardProvider>
        </ThemeProvider>
        {/* Single-mount, document-level event delegation. Replaces the
            native `title` tooltip everywhere with the brutalist bubble
            in components/TooltipLayer.tsx. Placed AFTER children so it
            renders into a portal at the end of <body> and naturally
            stacks above app content. */}
        <TooltipLayer />
      </body>
    </html>
  );
}
