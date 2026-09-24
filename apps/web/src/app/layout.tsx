import type { Metadata, Viewport } from "next";
// Self-hosted fonts (no request to Google at build or run time).
import "@fontsource-variable/sora";
import "@fontsource/mukta/400.css";
import "@fontsource/mukta/500.css";
import "@fontsource/mukta/600.css";
import "@fontsource/mukta/700.css";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: { default: "Godamo", template: "%s · Godamo" },
  description: "Wholesale & Distribution Management",
  applicationName: "Godamo",
};

export const viewport: Viewport = {
  themeColor: "#1E3A5F",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
