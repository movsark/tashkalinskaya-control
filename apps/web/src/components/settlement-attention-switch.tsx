import type { GoodReturnRequestView, WriteoffRequestView } from "@tashkalinskaya/contracts";
import Link from "next/link";

export function SettlementAttentionSwitch({
  active,
  returnCount,
  spoilageCount,
}: {
  active: "RETURNS" | "SPOILAGE";
  returnCount: number;
  spoilageCount: number;
}) {
  return (
    <nav className="driver-settlement-switch" aria-label="Возвраты и порча">
      <Link
        aria-current={active === "RETURNS" ? "page" : undefined}
        className={active === "RETURNS" ? "is-active" : undefined}
        href="/returns"
      >
        Годный возврат
        <SettlementBadge
          count={returnCount}
          label={`Ожидают приёмки годные возвраты: ${returnCount}`}
        />
      </Link>
      <Link
        aria-current={active === "SPOILAGE" ? "page" : undefined}
        className={active === "SPOILAGE" ? "is-active" : undefined}
        href="/spoilage"
      >
        Порча и списание
        <SettlementBadge count={spoilageCount} label={`Ожидает приёмки порча: ${spoilageCount}`} />
      </Link>
    </nav>
  );
}

export function countPendingGoodReturns(requests: readonly GoodReturnRequestView[]) {
  return requests.filter((request) => request.status === "PENDING").length;
}

export function countPendingDriverSpoilage(requests: readonly WriteoffRequestView[]) {
  return requests.filter(
    (request) =>
      request.awaitingReceipt &&
      request.status === "SUBMITTED" &&
      request.sourceTerritoryNumber !== null,
  ).length;
}

function SettlementBadge({ count, label }: { count: number; label: string }) {
  if (count === 0) return null;
  return (
    <b aria-label={label} className="driver-settlement-switch__badge">
      {count > 99 ? "99+" : count}
    </b>
  );
}
