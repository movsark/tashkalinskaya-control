"use client";

import type {
  LoadingLineView,
  LoadingProductView,
  LoadingSessionView,
} from "@tashkalinskaya/contracts";
import { useEffect, useState } from "react";

interface ProductLoadingRowProps {
  busyId: string;
  draftFor: (territoryId: string) => string;
  onCancel: (line: LoadingLineView) => Promise<void>;
  onDraft: (territoryId: string, value: string) => void;
  onReassign: (line: LoadingLineView, territoryId: string) => Promise<void>;
  onRevise: (line: LoadingLineView, quantity: number) => Promise<void>;
  onSend: (territoryId: string, quantity: number) => Promise<void>;
  onShowSent: () => void;
  onToggle: () => void;
  open: boolean;
  openMode: "send" | "sent";
  product: LoadingProductView;
  sessions: LoadingSessionView[];
}

export function ProductLoadingRow({
  busyId,
  draftFor,
  onCancel,
  onDraft,
  onReassign,
  onRevise,
  onSend,
  onShowSent,
  onToggle,
  open,
  openMode,
  product,
  sessions,
}: ProductLoadingRowProps) {
  const shortageQuantity = Math.max(0, product.remainingQuantity - product.freeQuantity);
  const initialTerritory =
    product.territories.find((item) => item.canSend && item.remainingQuantity > 0) ??
    product.territories.find((item) => item.remainingQuantity > 0) ??
    product.territories[0];
  const [selectedTerritoryId, setSelectedTerritoryId] = useState(
    initialTerritory?.territoryId ?? "",
  );
  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [quantityDrafts, setQuantityDrafts] = useState<Record<string, string>>({});
  const [targetTerritories, setTargetTerritories] = useState<Record<string, string>>({});
  const [cancelLineId, setCancelLineId] = useState<string | null>(null);
  const selectedTerritory =
    product.territories.find((item) => item.territoryId === selectedTerritoryId) ??
    initialTerritory;
  const transfers = sessions.flatMap((session) =>
    session.lines
      .filter((line) => line.productId === product.id)
      .map((line) => ({ line, session })),
  );

  useEffect(() => {
    if (
      selectedTerritoryId &&
      product.territories.some((item) => item.territoryId === selectedTerritoryId)
    )
      return;
    setSelectedTerritoryId(initialTerritory?.territoryId ?? "");
  }, [initialTerritory?.territoryId, product.territories, selectedTerritoryId]);

  return (
    <article className={`loading-product${open ? " is-open" : ""}`}>
      <div className="loading-product__summary">
        <button
          aria-expanded={open && openMode === "send"}
          className="loading-product__identity-button"
          onClick={() => {
            setSendDialogOpen(false);
            onToggle();
          }}
          type="button"
        >
          <span className="loading-product__identity">
            <small>{product.code}</small>
            <strong>{product.name}</strong>
          </span>
        </button>
        <span className="loading-product__metric">
          <small>На складе</small>
          <b>{product.freeQuantity} шт.</b>
        </span>
        <button
          aria-expanded={open && openMode === "sent"}
          className="loading-product__metric loading-product__sent"
          disabled={product.sentQuantity === 0}
          onClick={() => {
            setSendDialogOpen(false);
            onShowSent();
          }}
          type="button"
        >
          <small>Передано</small>
          <b>{product.sentQuantity} шт.</b>
        </button>
        <span className="loading-product__metric is-remaining">
          <small>Осталось</small>
          <b>
            {shortageQuantity > 0 ? (
              <em
                aria-label={`Не хватает ${shortageQuantity} шт.`}
                className="loading-product__shortage"
              >
                −{shortageQuantity}
              </em>
            ) : null}
            <span>{product.remainingQuantity} шт.</span>
          </b>
        </span>
        <button
          aria-label={open ? "Свернуть товар" : "Развернуть товар"}
          className="loading-product__toggle"
          onClick={() => {
            setSendDialogOpen(false);
            onToggle();
          }}
          type="button"
        >
          {open ? "−" : "+"}
        </button>
      </div>
      {open && openMode === "send" && selectedTerritory ? (
        <div className="loading-territory-picker">
          <div aria-label="Выбор территории" className="loading-territory-switcher" role="group">
            {product.territories.map((territory) => (
              <button
                aria-pressed={territory.territoryId === selectedTerritory.territoryId}
                className={
                  territory.territoryId === selectedTerritory.territoryId ? "is-selected" : ""
                }
                key={territory.territoryId}
                onClick={() => {
                  setSelectedTerritoryId(territory.territoryId);
                  setSendDialogOpen(true);
                }}
                type="button"
              >
                Территория {territory.territoryNumber}
                <small>{territory.remainingQuantity} шт.</small>
              </button>
            ))}
          </div>
          {sendDialogOpen ? (
            <TerritorySendDialog
              busyId={busyId}
              draft={draftFor(selectedTerritory.territoryId)}
              onClose={() => setSendDialogOpen(false)}
              onDraft={(value) => onDraft(selectedTerritory.territoryId, value)}
              onSend={(quantity) => onSend(selectedTerritory.territoryId, quantity)}
              product={product}
              territory={selectedTerritory}
            />
          ) : null}
        </div>
      ) : null}
      {open && openMode === "sent" ? (
        <div className="loading-transfer-history">
          {transfers.length ? (
            transfers.map(({ line, session }) => (
              <TransferItem
                busyId={busyId}
                cancelLineId={cancelLineId}
                key={line.id}
                line={line}
                onCancel={onCancel}
                onCancelChoice={setCancelLineId}
                onQuantityDraft={(value) =>
                  setQuantityDrafts((current) => ({ ...current, [line.id]: value }))
                }
                onReassign={onReassign}
                onRevise={onRevise}
                onTerritoryDraft={(value) =>
                  setTargetTerritories((current) => ({ ...current, [line.id]: value }))
                }
                product={product}
                quantityDraft={quantityDrafts[line.id] ?? String(line.quantity)}
                session={session}
                targetTerritoryId={targetTerritories[line.id] ?? session.territoryId}
              />
            ))
          ) : (
            <p className="loading-product-empty">По этому товару передач пока нет.</p>
          )}
        </div>
      ) : null}
    </article>
  );
}

function TransferItem({
  busyId,
  cancelLineId,
  line,
  onCancel,
  onCancelChoice,
  onQuantityDraft,
  onReassign,
  onRevise,
  onTerritoryDraft,
  product,
  quantityDraft,
  session,
  targetTerritoryId,
}: {
  busyId: string;
  cancelLineId: string | null;
  line: LoadingLineView;
  onCancel: (line: LoadingLineView) => Promise<void>;
  onCancelChoice: (lineId: string | null) => void;
  onQuantityDraft: (value: string) => void;
  onReassign: (line: LoadingLineView, territoryId: string) => Promise<void>;
  onRevise: (line: LoadingLineView, quantity: number) => Promise<void>;
  onTerritoryDraft: (value: string) => void;
  product: LoadingProductView;
  quantityDraft: string;
  session: LoadingSessionView;
  targetTerritoryId: string;
}) {
  const quantity = Number(quantityDraft);
  const maximum = line.quantity + product.freeQuantity;
  const quantityValid =
    Number.isInteger(quantity) && quantity > 0 && quantity <= maximum && quantity !== line.quantity;
  const editable =
    session.status === "IN_PROGRESS" &&
    (line.status === "SENT_TO_DRIVER" || line.status === "DISPUTED");
  return (
    <article className="loading-transfer-item">
      <header>
        <div>
          <strong>Территория {session.territoryNumber}</strong>
          <small>{session.driverName}</small>
        </div>
        <div>
          <b>{line.quantity} шт.</b>
          <Status value={line.status} />
        </div>
      </header>
      {line.responseReason ? <p>{line.responseReason}</p> : null}
      {editable ? (
        <div className="loading-transfer-actions">
          <label>
            Количество
            <input
              max={maximum}
              min="1"
              onChange={(event) => onQuantityDraft(event.target.value)}
              type="number"
              value={quantityDraft}
            />
          </label>
          <button
            className="secondary-button"
            disabled={!quantityValid || busyId === `quantity-${line.id}`}
            onClick={() => void onRevise(line, quantity)}
            type="button"
          >
            Изменить количество
          </button>
          <label>
            Территория
            <select
              onChange={(event) => onTerritoryDraft(event.target.value)}
              value={targetTerritoryId}
            >
              {product.territories.map((territory) => (
                <option key={territory.territoryId} value={territory.territoryId}>
                  Территория {territory.territoryNumber}
                </option>
              ))}
            </select>
          </label>
          <button
            className="secondary-button"
            disabled={
              targetTerritoryId === session.territoryId || busyId === `territory-${line.id}`
            }
            onClick={() => void onReassign(line, targetTerritoryId)}
            type="button"
          >
            Сменить территорию
          </button>
          {cancelLineId === line.id ? (
            <div className="loading-transfer-cancel-confirm">
              <span>Отменить и вернуть {line.quantity} шт. на склад?</span>
              <button onClick={() => onCancelChoice(null)} type="button">
                Нет
              </button>
              <button
                className="is-danger"
                disabled={busyId === `cancel-${line.id}`}
                onClick={() => void onCancel(line)}
                type="button"
              >
                Да, отменить
              </button>
            </div>
          ) : (
            <button
              className="text-button is-danger"
              onClick={() => onCancelChoice(line.id)}
              type="button"
            >
              Отменить передачу
            </button>
          )}
        </div>
      ) : (
        <p className="loading-transfer-locked">
          Водитель уже принял товар — исправление проводится отдельной складской операцией.
        </p>
      )}
    </article>
  );
}

function TerritorySendDialog({
  busyId,
  draft,
  onClose,
  onDraft,
  onSend,
  product,
  territory,
}: {
  busyId: string;
  draft: string;
  onClose: () => void;
  onDraft: (value: string) => void;
  onSend: (quantity: number) => Promise<void>;
  product: LoadingProductView;
  territory: LoadingProductView["territories"][number];
}) {
  const quantity = Number(draft);
  const maximum = Math.min(product.freeQuantity, territory.remainingQuantity);
  const valid = Number.isInteger(quantity) && quantity > 0 && quantity <= maximum;
  const key = `${product.id}:${territory.territoryId}`;
  const titleId = `send-product-${product.id}`;
  return (
    <div className="loading-territory-dialog-layer">
      <button
        aria-label="Закрыть окно передачи"
        className="loading-territory-dialog-backdrop"
        onClick={onClose}
        type="button"
      />
      <form
        aria-labelledby={titleId}
        aria-modal="true"
        className="loading-territory-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          onClose();
          void onSend(quantity);
        }}
        role="dialog"
      >
        <header>
          <div>
            <small>{product.code}</small>
            <h2 id={titleId}>Передать товар · Территория {territory.territoryNumber}</h2>
            <p>{product.name}</p>
          </div>
          <button aria-label="Закрыть окно передачи" onClick={onClose} type="button">
            ×
          </button>
        </header>
        <p className="loading-territory-dialog__limit">
          Можно передать сейчас: <strong>{maximum} шт.</strong>
        </p>
        <label>
          <span>Количество</span>
          <input
            autoFocus
            disabled={!territory.canSend || maximum < 1}
            inputMode="numeric"
            max={maximum}
            min="1"
            onChange={(event) => onDraft(event.target.value)}
            placeholder="0"
            type="number"
            value={draft}
          />
        </label>
        <button
          className="primary-button"
          disabled={!territory.canSend || !valid || busyId === key}
          type="submit"
        >
          {busyId === key ? "Отправляем…" : "Отправить водителю"}
        </button>
        {!territory.canSend ? (
          <p className="loading-territory-dialog__message">
            Для этой территории водитель ещё не нажал «Приступил к рейсу».
          </p>
        ) : territory.remainingQuantity === 0 ? (
          <p className="loading-territory-dialog__message">Норма этой территории уже передана.</p>
        ) : product.freeQuantity === 0 ? (
          <p className="loading-territory-dialog__message">
            На складе нет доступного количества — передача заблокирована.
          </p>
        ) : draft && !valid ? (
          <p className="loading-territory-dialog__message">Можно передать не более {maximum} шт.</p>
        ) : null}
      </form>
    </div>
  );
}

function Status({ value }: { value: string }) {
  const labels: Record<string, string> = {
    CONFIRMED: "Принято водителем",
    DISPUTED: "Есть расхождение",
    SENT_TO_DRIVER: "Ждём приёмку",
  };
  return (
    <span className={`loading-status is-${value.toLocaleLowerCase()}`}>
      {labels[value] ?? value}
    </span>
  );
}
