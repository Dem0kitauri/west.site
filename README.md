# Nexus Performance

Полноценный Node.js-сайт для Render: серверная авторизация, PostgreSQL, персональные диагностики, каталог игр, тарифы и администраторские команды.

## Что работает

- регистрация, вход, выход и восстановление пароля;
- безопасная cookie-сессия, хеширование паролей и ограничение частоты запросов;
- отдельная страница `/diagnostics.html`;
- персональный расчёт по CPU, GPU, RAM, накопителю, температурам, разрешению, герцовке, FPS и пингу;
- сохранение последнего отчёта в аккаунте;
- 20 игр с поиском, фильтрами и раскрытием каталога;
- тарифы из базы, акция **−70% только на первый месяц**;
- создание заявки на подписку и переход на платёжную ссылку, если она задана;
- управление контентом и пользователями через CMD;
- health check `/api/health` для Render.

## Локальный запуск

Нужен Node.js 20 или новее.

```bash
npm ci
cp .env.example .env
npm run dev
```

Без `DATABASE_URL` в development используется временная база в памяти. Для сохранения данных между перезапусками укажите PostgreSQL.

## Развёртывание на Render

Вариант 1 — Blueprint:

1. Загрузите эту папку в GitHub/GitLab.
2. В Render выберите **New → Blueprint** и подключите репозиторий.
3. Render прочитает `render.yaml`, создаст Web Service и PostgreSQL.
4. В Environment задайте `APP_URL` равным публичному адресу сервиса.

Вариант 2 — существующий Web Service:

- Build Command: `npm ci`
- Start Command: `npm start`
- Health Check Path: `/api/health`
- Node: 20+

Обязательные переменные:

```text
NODE_ENV=production
DATABASE_URL=<Internal Database URL из Render Postgres>
JWT_SECRET=<случайная строка минимум 32 символа>
APP_URL=https://ваш-сервис.onrender.com
```

Для восстановления пароля добавьте SMTP:

```text
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=Nexus <no-reply@ваш-домен.ru>
```

Для оплаты добавьте готовые ссылки платёжного провайдера:

```text
PAYMENT_URL_START=
PAYMENT_URL_PRO=
PAYMENT_URL_ULTIMATE=
```

Пока эти ссылки не заданы, выбор тарифа сохраняется как заявка без списания денег.

## Управление через CMD

Команды можно запускать в Render Shell или локально, предварительно задав `DATABASE_URL`.

```bash
npm run admin -- stats
npm run admin -- settings list
npm run admin -- discount set --percent=70
npm run admin -- plan set --slug=pro --regular=11.99 --first=3.60
npm run admin -- game add --name="Новая игра" --genre=FPS --steam=730
npm run admin -- game disable --name="Новая игра"
npm run admin -- user create-admin --name="Owner" --email=owner@example.com --password="длинный-пароль"
npm run admin -- user promote --email=owner@example.com
npm run admin -- diagnostics list --limit=20
```

`discount set` одновременно обновляет процент на сайте и пересчитывает цену первого месяца для всех тарифов.

## Проверка

```bash
npm run smoke
```

Smoke-тест проверяет health endpoint, регистрацию, сессию, персональную диагностику, 20 игр и скидку 70%.
