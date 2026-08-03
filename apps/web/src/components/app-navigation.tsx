"use client";

import type { AuthenticatedUser } from "@tashkalinskaya/contracts";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { getNotificationsWorkspace, getSession } from "../lib/api";
import { destinationsFor, primaryDestinationFor } from "../lib/navigation";

const hiddenPaths = new Set([
  "/activate",
  "/attendance/terminal",
  "/login",
  "/offline",
  "/recover",
  "/register",
  "/start",
  "/terminal-pair",
]);

export function AppNavigation() {
  const pathname = usePathname();
  const [session, setSession] = useState<AuthenticatedUser | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const hidden = hiddenPaths.has(pathname);

  useEffect(() => {
    if (hidden) return;
    let active = true;
    void getSession()
      .then((current) => {
        if (active) setSession(current);
      })
      .catch(() => {
        if (active) setSession(null);
      });
    return () => {
      active = false;
    };
  }, [hidden, pathname]);

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (session === null) return;
    let active = true;
    const refresh = async () => {
      try {
        const workspace = await getNotificationsWorkspace();
        if (active) setUnread(workspace.summary.totalUnread);
      } catch {
        if (active) setUnread(0);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [session]);

  const roles = useMemo(
    () => session?.employee.roles.map((role) => role.roleCode) ?? [],
    [session],
  );
  const destinations = useMemo(() => destinationsFor(roles), [roles]);
  const primary = roles.length > 0 ? primaryDestinationFor(roles) : null;

  if (hidden || session === null || primary === null) return null;

  return (
    <>
      <nav aria-label="Основная навигация" className="app-tabbar">
        <Link className={pathname === "/" ? "is-active" : ""} href="/">
          <span aria-hidden="true">⌂</span>
          <small>Главная</small>
        </Link>
        <Link className={pathname === primary.href ? "is-active" : ""} href={primary.href}>
          <span aria-hidden="true">{primary.symbol}</span>
          <small>{primary.shortLabel}</small>
        </Link>
        <Link className={pathname === "/notifications" ? "is-active" : ""} href="/notifications">
          <span aria-hidden="true">!</span>
          <small>События</small>
          {unread > 0 ? <b>{unread > 99 ? "99+" : unread}</b> : null}
        </Link>
        <button
          aria-expanded={menuOpen}
          aria-haspopup="dialog"
          className={menuOpen ? "is-active" : ""}
          onClick={() => setMenuOpen((current) => !current)}
          type="button"
        >
          <span aria-hidden="true">≡</span>
          <small>Меню</small>
        </button>
      </nav>

      {menuOpen ? (
        <div className="app-menu-backdrop" onClick={() => setMenuOpen(false)} role="presentation">
          <section
            aria-label="Разделы приложения"
            aria-modal="true"
            className="app-menu-sheet"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
          >
            <header>
              <div>
                <strong>Все разделы</strong>
                <small>{session.employee.fullName}</small>
              </div>
              <button aria-label="Закрыть меню" onClick={() => setMenuOpen(false)} type="button">
                ×
              </button>
            </header>
            <div className="app-menu-list">
              {destinations.map((destination) => (
                <Link href={destination.href} key={destination.href}>
                  <span aria-hidden="true">{destination.symbol}</span>
                  <strong>{destination.label}</strong>
                  <i aria-hidden="true">›</i>
                </Link>
              ))}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
