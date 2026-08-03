"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { getSession } from "../lib/api";
import { homeRouteFor } from "../lib/home-route";

export function ExistingSessionRedirect() {
  const router = useRouter();

  useEffect(() => {
    let active = true;
    getSession()
      .then((session) => {
        if (!active) return;
        router.replace(homeRouteFor(session.employee.roles.map((role) => role.roleCode)));
      })
      .catch(() => {
        // Без действующей сессии остаётся публичный стартовый экран.
      });
    return () => {
      active = false;
    };
  }, [router]);

  return null;
}
