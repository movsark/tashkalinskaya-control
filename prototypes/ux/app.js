const state = {
  mode: "phone",
  online: true,
  qrSeconds: 5,
  selectedBatch: "napoleon",
  loadingQty: 24,
  driverConfirmed: false,
};

const batchData = {
  napoleon: { name: "Наполеон", count: 48, workshop: "Цех 1", worker: "Ночная смена", plan: "48 шт." },
  prague: { name: "Прага", count: 24, workshop: "Цех 2", worker: "Анна Крылова", plan: "24 шт." },
  honey: { name: "Медовик", count: 30, workshop: "Цех 2", worker: "Сергей Петров", plan: "32 шт." },
};

const controlData = {
  inventory: {
    badge: "Критично",
    title: "Нет физического пересчета",
    text: "Кладовщик не отправил ежедневную инвентаризацию. Через 3 минуты план будет рассчитан по системным данным.",
    rows: [["Расчетный остаток", "1 284 шт."], ["Последний пересчет", "Вчера, 09:46"], ["Ответственный", "Иван Соколов"]],
    action: "Открыть пересчет",
  },
  loading: {
    badge: "Требует действия",
    title: "Водитель отклонил 2 строки",
    text: "В территориях 4 и 7 количество не совпало с фактически принятым водителями.",
    rows: [["Территория 4", "Прага · 24 шт."], ["Территория 7", "Медовик · 18 шт."], ["Ответственный", "Группа №2"]],
    action: "Открыть погрузку",
  },
  attendance: {
    badge: "Проверить",
    title: "Четыре смены не закрыты",
    text: "Сотрудники отметили приход вчера, но не отметили уход. Автоматически смены не закрывались.",
    rows: [["Цех 1", "1 сотрудник"], ["Цех 2", "3 сотрудника"], ["Ответственный", "Бухгалтер"]],
    action: "Открыть табель",
  },
  writeoff: {
    badge: "Ожидает решения",
    title: "Три запроса на списание",
    text: "Физически принятая порча заблокирована и ожидает решения администратора.",
    rows: [["Запросов", "3"], ["Количество", "17 шт."], ["Есть фото", "2 запроса"]],
    action: "Открыть запросы",
  },
};

function showToast(message, isError = false) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.toggle("is-error", isError);
  toast.classList.add("is-visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

function requireNetwork(action) {
  if (state.online) return true;
  showToast("Нет связи с сервером. Операция не подтверждена.", true);
  return false;
}

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll(".mode-button").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.mode === mode);
  });
  document.querySelectorAll(".device-view").forEach((view) => {
    view.classList.toggle("is-active", view.id === `view-${mode}`);
  });
}

function setPhoneScreen(screenId) {
  document.querySelectorAll(".phone-screen").forEach((screen) => {
    screen.classList.toggle("is-active", screen.id === screenId);
  });
  document.querySelectorAll(".phone-nav-button[data-phone-screen]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.phoneScreen === screenId);
  });
}

function setTabletScreen(screenId) {
  document.querySelectorAll(".tablet-screen").forEach((screen) => {
    screen.classList.toggle("is-active", screen.id === screenId);
  });
  document.querySelectorAll(".tablet-tab[data-tablet-screen]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.tabletScreen === screenId);
  });
}

function toggleNetwork() {
  state.online = !state.online;
  document.body.classList.toggle("is-offline", !state.online);
  const toggle = document.querySelector("#network-toggle");
  toggle.classList.toggle("is-offline", !state.online);
  toggle.setAttribute("aria-pressed", String(!state.online));
  toggle.lastChild.textContent = state.online ? " Сеть есть" : " Нет сети";

  const phone = document.querySelector("#phone-network");
  phone.textContent = state.online ? "● В сети" : "● Нет сети";
  phone.classList.toggle("is-offline", !state.online);

  const tablet = document.querySelector("#tablet-network");
  tablet.textContent = state.online ? "● Сервер доступен" : "● Сервер недоступен";
  tablet.classList.toggle("is-offline", !state.online);

  showToast(state.online ? "Связь с сервером восстановлена." : "Демонстрация режима без сети.", !state.online);
}

function renderQr() {
  const qr = document.querySelector("#qr-grid");
  qr.innerHTML = "";
  const seed = Date.now() + state.qrSeconds;
  for (let index = 0; index < 441; index += 1) {
    const cell = document.createElement("i");
    const finder =
      (index % 21 < 7 && Math.floor(index / 21) < 7) ||
      (index % 21 > 13 && Math.floor(index / 21) < 7) ||
      (index % 21 < 7 && Math.floor(index / 21) > 13);
    if (!finder && Math.sin(seed + index * 31) > -0.05) cell.style.opacity = "0";
    qr.append(cell);
  }
}

function tickQr() {
  state.qrSeconds -= 1;
  if (state.qrSeconds <= 0) {
    state.qrSeconds = 5;
    renderQr();
  }
  document.querySelector("#qr-seconds").textContent = state.qrSeconds;
}

function selectBatch(batchId) {
  state.selectedBatch = batchId;
  const batch = batchData[batchId];
  document.querySelectorAll("[data-batch]").forEach((row) => {
    row.classList.toggle("is-selected", row.dataset.batch === batchId);
  });
  document.querySelector("#batch-name").textContent = batch.name;
  document.querySelector("#batch-count").textContent = batch.count;
  document.querySelector("#batch-workshop").textContent = batch.workshop;
  document.querySelector("#batch-worker").textContent = batch.worker;
  document.querySelector("#batch-plan").textContent = batch.plan;
  document.querySelector('[data-action="accept-batch"]').textContent = `Принять ${batch.count} шт.`;
}

function changeQuantity(delta) {
  const input = document.querySelector("#loading-qty");
  const current = Number.parseInt(input.value, 10) || 0;
  state.loadingQty = Math.max(1, current + delta);
  input.value = state.loadingQty;
}

function driverConfirm() {
  if (!requireNetwork("Подтверждение")) return;
  state.driverConfirmed = true;
  const card = document.querySelector("#driver-line");
  card.innerHTML = `
    <div class="card-heading">
      <span class="sequence">Строка 8</span>
      <span class="badge action-chip">Подтверждено</span>
    </div>
    <h2>Торт «Прага»</h2>
    <div class="quantity">24 <small>шт.</small></div>
    <p class="success-text"><b>✓ Сервер сохранил подтверждение в 09:58</b></p>
  `;
  updateTabletConfirmation();
  showToast("Строка подтверждена сервером.");
}

function updateTabletConfirmation() {
  const line = document.querySelector("#tablet-pending-line");
  if (!line) return;
  line.className = "loading-line is-confirmed";
  line.querySelector("em").textContent = "✓ Водитель подтвердил";
  document.querySelector("#loading-blocker").textContent = "Все строки подтверждены";
  document.querySelector("#warehouse-finish").disabled = false;
}

function openRejectModal() {
  document.querySelector("#reject-modal").hidden = false;
}

function closeRejectModal() {
  document.querySelector("#reject-modal").hidden = true;
}

function rejectDriverLine() {
  if (!requireNetwork("Отклонение")) return;
  closeRejectModal();
  const card = document.querySelector("#driver-line");
  card.innerHTML = `
    <div class="card-heading">
      <span class="sequence">Строка 8</span>
      <span class="badge badge-danger">Отклонено</span>
    </div>
    <h2>Торт «Прага»</h2>
    <div class="quantity">24 <small>шт.</small></div>
    <p class="danger-text"><b>Количество не совпадает.</b></p>
    <p>Строка возвращена кладовщику на исправление.</p>
  `;
  showToast("Строка возвращена кладовщику.");
}

function renderControlDetail(key) {
  const data = controlData[key];
  const detail = document.querySelector("#control-detail");
  detail.innerHTML = `
    <span class="badge ${key === "inventory" ? "badge-danger" : "badge-warning"}">${data.badge}</span>
    <h2>${data.title}</h2>
    <p>${data.text}</p>
    <dl>${data.rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("")}</dl>
    <button class="primary-button" data-action="open-control">${data.action}</button>
    <button class="secondary-button" data-action="notify-owner">Отправить напоминание</button>
  `;
  document.querySelectorAll("[data-control]").forEach((row) => {
    row.classList.toggle("is-selected", row.dataset.control === key && row.classList.contains("issue-row"));
  });
}

document.addEventListener("click", (event) => {
  const modeButton = event.target.closest("[data-mode]");
  if (modeButton) setMode(modeButton.dataset.mode);

  const phoneButton = event.target.closest("[data-phone-screen]");
  if (phoneButton) setPhoneScreen(phoneButton.dataset.phoneScreen);

  const tabletButton = event.target.closest("[data-tablet-screen]");
  if (tabletButton) setTabletScreen(tabletButton.dataset.tabletScreen);

  const batchButton = event.target.closest("[data-batch]");
  if (batchButton) selectBatch(batchButton.dataset.batch);

  const controlButton = event.target.closest("[data-control]");
  if (controlButton) renderControlDetail(controlButton.dataset.control);

  const actionButton = event.target.closest("[data-action]");
  if (!actionButton) return;
  const action = actionButton.dataset.action;

  if (action === "driver-confirm") driverConfirm();
  if (action === "driver-reject") openRejectModal();
  if (action === "cancel-reject") closeRejectModal();
  if (action === "confirm-reject") rejectDriverLine();
  if (action === "qty-minus") changeQuantity(-1);
  if (action === "qty-plus") changeQuantity(1);
  if (action === "scan-product") showToast("Камера открылась бы на весь экран. Доступен и ручной поиск.");
  if (action === "send-driver") {
    if (!requireNetwork("Строка")) return;
    setMode("phone");
    setPhoneScreen("phone-driver");
    showToast("Строка отправлена водителю. Открыт его экран.");
  }
  if (action === "accept-batch") {
    if (!requireNetwork("Приемка партии")) return;
    showToast(`${batchData[state.selectedBatch].name}: партия принята на склад.`);
    actionButton.disabled = true;
    actionButton.textContent = "✓ Принято сервером";
  }
  if (action === "return-batch") {
    if (!requireNetwork("Возврат партии")) return;
    showToast("Партия возвращена в цех на исправление.");
  }
  if (action === "warehouse-finish") {
    if (!requireNetwork("Финал погрузки")) return;
    actionButton.disabled = true;
    actionButton.textContent = "✓ Кладовщик завершил";
    document.querySelector("#loading-blocker").textContent = "Теперь ожидается финал водителя";
    showToast("Финал кладовщика сохранен. Водитель получил итог.");
  }
  if (action === "show-notifications") showToast("3 события: приемка партии, изменение нормы, напоминание о табеле.");
  if (action === "show-inventory") showToast("Пересчет: 12 товаров заполнено, 4 ожидают ввода.");
  if (action === "show-returns") showToast("В общем пуле возврата сейчас 12 шт.");
  if (action === "print-control") showToast("Подготовлена печатная форма A4.");
  if (action === "open-inventory" || action === "open-control") showToast("Открыта рабочая карточка проблемы.");
  if (action === "notify-warehouse" || action === "notify-owner") showToast("Напоминание добавлено в ленту и очередь Web Push.");
});

document.querySelector("#network-toggle").addEventListener("click", toggleNetwork);
document.querySelector("#loading-qty").addEventListener("input", (event) => {
  state.loadingQty = Math.max(1, Number.parseInt(event.target.value, 10) || 1);
});
document.querySelector("#reject-modal").addEventListener("click", (event) => {
  if (event.target.id === "reject-modal") closeRejectModal();
});

renderQr();
window.setInterval(tickQr, 1000);
