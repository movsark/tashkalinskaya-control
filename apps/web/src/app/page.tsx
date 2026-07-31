import { SystemReadiness } from "../components/system-readiness";

const foundations = [
  {
    detail: "Парольная фраза · Argon2id · системный PIN или биометрия",
    state: "B05.2",
    title: "Персональный вход",
  },
  {
    detail: "9 ролей MVP · фабрика, цех, территория, склад, магазин",
    state: "B05",
    title: "Роли и области",
  },
  {
    detail: "Samsung, iPhone или iPad · WebAuthn · замена через администратора",
    state: "B05.2",
    title: "Одно устройство",
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
          <p className="eyebrow">Первый функциональный модуль · B05</p>
          <h1>Персональный доступ сотрудников</h1>
          <p className="hero__lead">
            У каждого сотрудника собственная учетная запись, назначенные роли и одно привязанное
            личное устройство. Общих аккаунтов цеха нет.
          </p>
          <div className="hero__actions">
            <a className="primary-link" href="/login">
              Войти в систему
            </a>
            <a className="text-link" href="/activate">
              Активировать устройство
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
            <p className="eyebrow">Контур доступа</p>
            <h2 id="foundation-title">Сотрудник, роль и устройство</h2>
          </div>
          <p>Права проверяются сервером при каждом запросе и меняются немедленно.</p>
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
          <h2>B05.2 · Защищенные устройства готово</h2>
        </div>
        <p>
          Криптографический challenge устройства, системный PIN/биометрия, замена телефона и
          регистрация фабричного iPad вошли в рабочий контур. Следующий блок — B06, табель и
          динамический QR.
        </p>
      </section>

      <footer>
        <span>Ташкалинская кондитерская фабрика</span>
        <span>Рабочая версия 0.1.0</span>
      </footer>
    </main>
  );
}
