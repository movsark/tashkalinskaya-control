export default function OfflinePage() {
  return (
    <main className="offline-page">
      <section className="offline-card">
        <div className="brand-mark" aria-hidden="true">
          Т
        </div>
        <p className="eyebrow">Нет связи</p>
        <h1>Операция не подтверждена</h1>
        <p>
          Проверьте интернет и откройте экран снова. Производственные и складские операции считаются
          выполненными только после ответа сервера.
        </p>
        <a className="primary-link" href="/">
          Повторить подключение
        </a>
      </section>
    </main>
  );
}
