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
    detail: "Территории 1–9, машины, водители, рейсы и группы погрузки",
    state: "B08.1",
    title: "График логистики",
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
          <p className="eyebrow">Разработка MVP · B05–B08</p>
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
            <h2 id="foundation-title">От доступа до графика вывоза</h2>
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
          <h2>B08.1 · Ядро логистики</h2>
        </div>
        <p>
          Территории, машины, водители, постоянные закрепления, рейсы на дату и группы погрузки
          объединяются в один управляемый график. Следующий срез завершает ролевые сценарии водителя
          и кладовщика.
        </p>
      </section>

      <footer>
        <span>Ташкалинская кондитерская фабрика</span>
        <span>Рабочая версия 0.1.0</span>
      </footer>
    </main>
  );
}
