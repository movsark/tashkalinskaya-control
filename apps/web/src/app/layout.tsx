import type { Metadata, Viewport } from "next";

import { AppNavigation } from "../components/app-navigation";
import { ConnectionStatus } from "../components/connection-status";
import { PwaRegistration } from "../components/pwa-registration";
import "./globals.css";

export const metadata: Metadata = {
  applicationName: "Ташкалинская — контроль",
  description: "Внутренняя система контроля Ташкалинской кондитерской фабрики",
  icons: {
    apple: [
      {
        sizes: "180x180",
        type: "image/png",
        url: "/icons/tashkalinskaya-apple-touch.png",
      },
    ],
    icon: [
      {
        sizes: "64x64",
        type: "image/png",
        url: "/icons/tashkalinskaya-64.png",
      },
      {
        sizes: "192x192",
        type: "image/png",
        url: "/icons/tashkalinskaya-192.png",
      },
    ],
  },
  title: {
    default: "Ташкалинская — внутренний контроль",
    template: "%s · Ташкалинская",
  },
};

export const viewport: Viewport = {
  colorScheme: "light",
  initialScale: 1,
  themeColor: "#173c34",
  width: "device-width",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru">
      <body>
        <PwaRegistration />
        {children}
        <ConnectionStatus />
        <AppNavigation />
      </body>
    </html>
  );
}
