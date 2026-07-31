import { SystemReadiness } from "../components/system-readiness";

const foundations = [
  {
    detail: "Персональный вход, роли, одно доверенное устройство и отзыв сессий",
    state: "B05",
    title: "Сотрудники и доступ",
  },
  {
    detail: "Динамический QR, фабричный терминал, ручная отметка и контроль смен",
    state: "B06",
    title: "Электронный табель",
  },
  {
    detail: "Безопасный preview Excel, справочник товаров и версионируемые нормы",
    state: "B07",
    title: "Товары и нормы",
  },
  {
    detail: "Территории 1–9, машины, ролевые экраны и допуск по табелю",
    state: "B08.2",
    title: "График логистики",
  },
  {
    detail: "Недельные версии норм, календарные исключения и согласование водителя",
    state: "B09.2",
    title: "Нормы и календарь",
  },
  {
    detail: "Заказ до 10:00, нулевая версия, позднее согласование и включение в план",
    state: "B10.1",
    title: "Фирменный магазин",
  },
  {
    detail: "Задания цехов, исполнители, выпуск партиями, сверхплан, брак и невыполнение",
    state: "B11.1",
    title: "Производство",
  },
];

export default function HomePage() {
  return (
    <main>
      <header className="topbar">
        <a className="brand" href="/" aria-label="Ташкалинская — главная">
          <span className="brand-mark" aria-hidden="true">
            Т
          </span>
          <span>
            <strong>Ташкалинская</strong>
            <small>внутренний контроль</small>
          </span>
        </a>
        <span className="environment-label">LOCAL · 0.1.0</span>
      </header>

      <section className="hero">
        <div className="hero__copy">
          <p className="eyebrow">Разработка MVP · B05–B11</p>
          <h1>Рабочий контур внутреннего контроля</h1>
          <p className="hero__lead">
            Приложение развивается последовательными рабочими модулями. Реальные товары и сотрудники
            будут внесены владельцем перед пилотом через готовые интерфейсы.
          </p>
          <div className="hero__actions">
            <a className="primary-link" href="/login">
              Войти в систему
            </a>
            <a className="text-link" href="/activate">
              Активировать устройство
            </a>
            <a className="text-link" href="/logistics">
              Открыть логистику
            </a>
            <a className="text-link" href="/planning">
              Открыть нормы
            </a>
            <a className="text-link" href="/store">
              Заказ магазина
            </a>
            <a className="text-link" href="/production">
              Открыть производство
            </a>
          </div>
        </div>

        <aside className="status-panel">
          <p className="status-panel__label">Состояние окружения</p>
          <SystemReadiness />
          <dl className="status-list">
            <div>
              <dt>Интерфейс</dt>
              <dd>онлайн</dd>
            </div>
            <div>
              <dt>PostgreSQL</dt>
              <dd>подключается отдельно</dd>
            </div>
            <div>
              <dt>Режим</dt>
              <dd>разработка</dd>
            </div>
          </dl>
        </aside>
      </section>

      <section className="content-section" aria-labelledby="foundation-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Готовые рабочие срезы</p>
            <h2 id="foundation-title">От доступа до плана производства</h2>
          </div>
          <p>Каждый модуль использует серверные права, аудит и PostgreSQL-транзакции.</p>
        </div>

        <div className="foundation-grid">
          {foundations.map((foundation, index) => (
            <article className="foundation-card" key={foundation.title}>
              <span className="foundation-card__number">0{index + 1}</span>
              <span className="foundation-card__state">{foundation.state}</span>
              <h3>{foundation.title}</h3>
              <p>{foundation.detail}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="next-step">
        <div>
          <p className="eyebrow">Дальше</p>
          <h2>B12 · Приёмка готовой продукции и склад</h2>
        </div>
        <p>
          Цех уже передаёт заявленные партии в очередь склада. Следующий срез добавит физическую
          приёмку, неизменяемые складские движения и расчёт свободного остатка.
        </p>
      </section>

      <footer>
        <span>Ташкалинская кондитерская фабрика</span>
        <span>Рабочая версия 0.1.0</span>
      </footer>
    </main>
  );
}
