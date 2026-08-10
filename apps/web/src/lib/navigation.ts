import type { RoleCode } from "@tashkalinskaya/contracts";

export interface AppDestination {
  readonly href: string;
  readonly label: string;
  readonly driverLabel?: string;
  readonly driverShortLabel?: string;
  readonly shortLabel: string;
  readonly symbol: string;
  readonly roles: readonly RoleCode[];
}

const allRoles: readonly RoleCode[] = [
  "ACCOUNTANT",
  "ADMIN",
  "ATTENDANCE_ONLY",
  "CONFECTIONER",
  "DRIVER",
  "MANAGER",
  "STORE_SELLER",
  "WAREHOUSE_KEEPER",
  "WORKSHOP_MANAGER",
];

export const appDestinations: readonly AppDestination[] = [
  {
    href: "/attendance/me",
    label: "Мой табель",
    roles: allRoles,
    shortLabel: "Табель",
    symbol: "✓",
  },
  {
    href: "/employees",
    label: "Сотрудники",
    roles: ["ADMIN"],
    shortLabel: "Люди",
    symbol: "Л",
  },
  {
    href: "/attendance/control",
    label: "Контроль табеля",
    roles: ["ACCOUNTANT", "ADMIN", "MANAGER", "WORKSHOP_MANAGER"],
    shortLabel: "Контроль",
    symbol: "Т",
  },
  {
    href: "/production",
    label: "Производство",
    roles: ["ADMIN", "CONFECTIONER", "MANAGER", "WORKSHOP_MANAGER"],
    shortLabel: "Цех",
    symbol: "П",
  },
  {
    href: "/warehouse",
    label: "Склад",
    roles: ["ADMIN", "MANAGER", "WAREHOUSE_KEEPER"],
    shortLabel: "Склад",
    symbol: "С",
  },
  {
    href: "/logistics",
    label: "Территории и водители",
    roles: ["ADMIN", "MANAGER", "WAREHOUSE_KEEPER"],
    shortLabel: "Рейсы",
    symbol: "Р",
  },
  {
    href: "/logistics/today",
    driverLabel: "Моя погрузка",
    label: "Подтверждение водителем",
    roles: ["ADMIN", "DRIVER", "MANAGER"],
    shortLabel: "Погрузка",
    symbol: "М",
  },
  {
    href: "/logistics/warehouse",
    label: "Управление погрузкой",
    roles: ["ADMIN", "DRIVER", "MANAGER", "WAREHOUSE_KEEPER"],
    shortLabel: "Погрузка",
    symbol: "Г",
  },
  {
    href: "/planning/plan",
    label: "План вывоза",
    roles: ["ADMIN", "MANAGER", "WAREHOUSE_KEEPER", "WORKSHOP_MANAGER"],
    shortLabel: "План",
    symbol: "П",
  },
  {
    href: "/planning",
    driverLabel: "Моя норма",
    driverShortLabel: "Норма",
    label: "Нормы и календарь",
    roles: ["ADMIN", "DRIVER", "MANAGER"],
    shortLabel: "Нормы",
    symbol: "Н",
  },
  {
    href: "/store",
    label: "Фирменный магазин",
    roles: ["ADMIN", "MANAGER", "STORE_SELLER", "WAREHOUSE_KEEPER"],
    shortLabel: "Магазин",
    symbol: "Ф",
  },
  {
    href: "/warehouse/inventory",
    label: "Инвентаризация",
    roles: ["ADMIN", "MANAGER", "WAREHOUSE_KEEPER"],
    shortLabel: "Пересчёт",
    symbol: "И",
  },
  {
    href: "/returns",
    label: "Возвраты и порча",
    roles: ["ADMIN", "DRIVER", "MANAGER", "WAREHOUSE_KEEPER"],
    shortLabel: "Возвраты",
    symbol: "В",
  },
  {
    href: "/catalog",
    label: "Товары и импорт",
    roles: ["ADMIN", "MANAGER"],
    shortLabel: "Товары",
    symbol: "Т",
  },
  {
    href: "/reports",
    label: "Контроль и отчёты",
    roles: ["ACCOUNTANT", "ADMIN", "MANAGER"],
    shortLabel: "Отчёты",
    symbol: "О",
  },
  {
    href: "/terminals",
    label: "Планшеты табеля",
    roles: ["ADMIN"],
    shortLabel: "Планшеты",
    symbol: "У",
  },
];

export function destinationsFor(roles: readonly RoleCode[]): readonly AppDestination[] {
  return appDestinations.filter((destination) =>
    destination.roles.some((role) => roles.includes(role)),
  );
}

export function destinationLabelFor(
  destination: AppDestination,
  roles: readonly RoleCode[],
): string {
  return isRegularDriver(roles) && destination.driverLabel
    ? destination.driverLabel
    : destination.label;
}

export function destinationShortLabelFor(
  destination: AppDestination,
  roles: readonly RoleCode[],
): string {
  return isRegularDriver(roles) && destination.driverShortLabel
    ? destination.driverShortLabel
    : destination.shortLabel;
}

function isRegularDriver(roles: readonly RoleCode[]): boolean {
  return roles.includes("DRIVER") && !roles.some((role) => ["ADMIN", "MANAGER"].includes(role));
}

export function primaryDestinationFor(roles: readonly RoleCode[]): AppDestination {
  const priorities: readonly string[] = roles.includes("ADMIN")
    ? ["/employees"]
    : roles.includes("DRIVER")
      ? ["/logistics/today"]
      : roles.includes("STORE_SELLER")
        ? ["/store"]
        : roles.includes("WAREHOUSE_KEEPER")
          ? ["/warehouse"]
          : roles.some((role) => ["CONFECTIONER", "WORKSHOP_MANAGER"].includes(role))
            ? ["/production"]
            : roles.some((role) => ["ACCOUNTANT", "MANAGER"].includes(role))
              ? ["/attendance/control"]
              : ["/attendance/me"];
  const destinations = destinationsFor(roles);
  return (
    destinations.find((destination) => priorities.includes(destination.href)) ?? destinations[0]!
  );
}
