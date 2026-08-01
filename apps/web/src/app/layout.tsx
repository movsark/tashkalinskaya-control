import type { Metadata, Viewport } from "next";

import { PwaRegistration } from "../components/pwa-registration";
import { NotificationShortcut } from "../components/notification-shortcut";
import "./globals.css";

export const metadata: Metadata = {
  applicationName: "Ташкалинская — контроль",
  description: "Внутренняя система контроля Ташкалинской кондитерской фабрики",
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
        <NotificationShortcut />
        {children}
      </body>
    </html>
  );
}
