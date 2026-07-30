import { SystemReadiness } from "../components/system-readiness";

const foundations = [
  {
    detail: "Next.js PWA · телефон, iPad, офис",
    state: "Создано",
    title: "Рабочий интерфейс",
  },
  {
    detail: "NestJS · REST/OpenAPI · health-check",
    state: "Создано",
    title: "Прикладной API",
  },
  {
    detail: "PostgreSQL 18 · миграции · outbox",
    state: "Подготовлено",
    title: "Надёжные данные",
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
          <p className="eyebrow">Первый программный срез · B04.1</p>
          <h1>Основа приложения работает</h1>
          <p className="hero__lead">
            Созданы отдельные процессы интерфейса, API и фоновых заданий. Следующий функциональный
            модуль — авторизация и управление сотрудниками.
          </p>
          <div className="hero__actions">
            <a className="primary-link" href="http://localhost:4000/api/docs">
              Открыть API
            </a>
            <span className="secondary-note">Данные пока только тестовые</span>
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
            <p className="eyebrow">Технический фундамент</p>
            <h2 id="foundation-title">Три процесса, одна версия</h2>
          </div>
          <p>Все части собираются и проверяются вместе до попадания в main.</p>
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
          <h2>B05 · Авторизация и сотрудники</h2>
        </div>
        <p>
          Вход по телефону и PIN, роли, области доступа, одно личное устройство и административное
          управление сотрудниками.
        </p>
      </section>

      <footer>
        <span>Ташкалинская кондитерская фабрика</span>
        <span>Рабочая версия 0.1.0</span>
      </footer>
    </main>
  );
}
