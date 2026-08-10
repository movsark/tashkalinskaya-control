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
  const positions = new Set<string>();
  for (const request of requests) {
    if (request.status !== "PENDING") continue;
    if (request.lines.length === 0) {
      positions.add(request.id);
      continue;
    }
    for (const line of request.lines) {
      positions.add(
        [request.territoryId, request.sourceDriverId, request.dispatchDate, line.productId].join(
          ":",
        ),
      );
    }
  }
  return positions.size;
}

export function countPendingDriverSpoilage(requests: readonly WriteoffRequestView[]) {
  const positions = new Set<string>();
  for (const request of requests) {
    if (
      !request.awaitingReceipt ||
      request.status !== "SUBMITTED" ||
      request.sourceTerritoryNumber === null
    )
      continue;
    positions.add(
      [
        request.sourceTerritoryNumber,
        request.sourceDriverName ?? request.createdByName,
        request.sourceDispatchDate ?? request.businessDate,
        request.productId,
      ].join(":"),
    );
  }
  return positions.size;
}

function SettlementBadge({ count, label }: { count: number; label: string }) {
  if (count === 0) return null;
  return (
    <b aria-label={label} className="driver-settlement-switch__badge">
      {count > 99 ? "99+" : count}
    </b>
  );
}
