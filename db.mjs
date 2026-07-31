import pg from "pg";

const { Pool } = pg;
let pool;

function createPool() {
  if (pool) return pool;
  if (process.env.DATABASE_URL) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
      max: 8,
      idleTimeoutMillis: 30_000,
    });
    return pool;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL is required in production");
  }
  return null;
}

async function getPool() {
  const existing = createPool();
  if (existing) return existing;
  const { newDb } = await import("pg-mem");
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = memory.adapters.createPg();
  pool = new adapter.Pool();
  return pool;
}

export async function query(text, params = []) {
  const db = await getPool();
  return db.query(text, params);
}

const defaultSettings = {
  discount_percent: 70,
  promo_label: "−70% в первый месяц",
  hero_title: "Играй на максимуме. Без компромиссов.",
  support_email: "support@nexus.local",
};

const defaultPlans = [
  ["start", "START", 6.99, 2.1, ["Диагностика одного ПК", "Профили для 8 игр", "Точка безопасного отката"]],
  ["pro", "PRO", 11.99, 3.6, ["Полная персональная диагностика", "Все 20 игровых профилей", "История замеров", "Приоритетные обновления"]],
  ["ultimate", "ULTIMATE", 17.99, 5.4, ["Всё из Pro", "До 3 компьютеров", "Расширенная аналитика", "Приоритетная поддержка"]],
];

const defaultGames = [
  ["Counter-Strike 2", "FPS", "730"], ["PUBG: Battlegrounds", "Battle Royale", "578080"],
  ["Apex Legends", "Battle Royale", "1172470"], ["Dota 2", "MOBA", "570"],
  ["Rust", "Survival", "252490"], ["Grand Theft Auto V", "Open World", "271590"],
  ["Cyberpunk 2077", "RPG", "1091500"], ["Elden Ring", "RPG", "1245620"],
  ["Baldur's Gate 3", "RPG", "1086940"], ["Red Dead Redemption 2", "Open World", "1174180"],
  ["The Witcher 3", "RPG", "292030"], ["Forza Horizon 5", "Racing", "1551360"],
  ["Helldivers 2", "Action", "553850"], ["Dead by Daylight", "Horror", "381210"],
  ["Rainbow Six Siege", "FPS", "359550"], ["Destiny 2", "FPS", "1085660"],
  ["Warframe", "Action", "230410"], ["Palworld", "Survival", "1623730"],
  ["Hogwarts Legacy", "RPG", "990080"], ["Monster Hunter Wilds", "Action", "2246340"],
];

export async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(80) NOT NULL,
      email VARCHAR(180) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'user',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS diagnostics (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      input JSONB NOT NULL,
      output JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS settings (
      key VARCHAR(80) PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS plans (
      slug VARCHAR(40) PRIMARY KEY,
      name VARCHAR(80) NOT NULL,
      regular_price NUMERIC(10,2) NOT NULL,
      first_month_price NUMERIC(10,2) NOT NULL,
      features JSONB NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS games (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(120) UNIQUE NOT NULL,
      genre VARCHAR(80) NOT NULL,
      steam_app_id VARCHAR(32),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 100
    );
    CREATE TABLE IF NOT EXISTS subscriptions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan_slug VARCHAR(40) NOT NULL REFERENCES plans(slug),
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS password_resets (
      token_hash VARCHAR(64) PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ
    );
  `);

  for (const [key, value] of Object.entries(defaultSettings)) {
    await query("INSERT INTO settings(key, value) VALUES($1, $2::jsonb) ON CONFLICT (key) DO NOTHING", [key, JSON.stringify(value)]);
  }
  for (const plan of defaultPlans) {
    await query(
      "INSERT INTO plans(slug, name, regular_price, first_month_price, features) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT (slug) DO NOTHING",
      [plan[0], plan[1], plan[2], plan[3], JSON.stringify(plan[4])],
    );
  }
  for (let i = 0; i < defaultGames.length; i += 1) {
    const game = defaultGames[i];
    await query(
      "INSERT INTO games(name, genre, steam_app_id, sort_order) VALUES($1,$2,$3,$4) ON CONFLICT (name) DO NOTHING",
      [game[0], game[1], game[2], i],
    );
  }
}

export async function closeDb() {
  if (pool) await pool.end();
}
