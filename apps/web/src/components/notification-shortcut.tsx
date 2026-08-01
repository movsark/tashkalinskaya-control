"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { getNotificationsWorkspace } from "../lib/api";

const publicPaths = [
  "/",
  "/activate",
  "/login",
  "/recover",
  "/terminal-pair",
  "/attendance/terminal",
];

export function NotificationShortcut() {
  const pathname = usePathname();
  const [unread, setUnread] = useState<number | null>(null);
  const [critical, setCritical] = useState(false);
  const hidden = publicPaths.includes(pathname) || pathname === "/notifications";

  useEffect(() => {
    if (hidden) return;
    let active = true;
    const refresh = async () => {
      try {
        const workspace = await getNotificationsWorkspace();
        if (active) {
          setUnread(workspace.summary.totalUnread);
          setCritical(workspace.summary.criticalUnread > 0);
        }
      } catch {
        if (active) setUnread(null);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [hidden]);

  if (hidden || unread === null) return null;
  return (
    <Link
      aria-label={`Уведомления${unread ? `, непрочитанных ${unread}` : ""}`}
      className={`notification-shortcut ${critical ? "has-critical" : ""}`}
      href="/notifications"
    >
      <span aria-hidden="true">!</span>
      {unread > 0 ? <b>{unread > 99 ? "99+" : unread}</b> : null}
    </Link>
  );
}
