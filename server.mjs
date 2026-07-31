import "dotenv/config";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import nodemailer from "nodemailer";
import { initDb, query } from "./db.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === "production";
const jwtSecret = process.env.JWT_SECRET || "local-development-secret-change-me";

if (isProduction && jwtSecret.length < 32) throw new Error("JWT_SECRET must contain at least 32 characters");

app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      "img-src": ["'self'", "data:", "https://shared.cloudflare.steamstatic.com"],
      "script-src": ["'self'"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "connect-src": ["'self'"],
    },
  },
}));
app.use(express.json({ limit: "64kb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"], maxAge: isProduction ? "1h" : 0 }));

const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false });
const diagLimiter = rateLimit({ windowMs: 60_000, limit: 12, standardHeaders: "draft-8", legacyHeaders: false });

function normalizeEmail(value) { return String(value || "").trim().toLowerCase(); }
function safeName(value) { return String(value || "").trim().slice(0, 80); }
function tokenFor(user) { return jwt.sign({ sub: String(user.id), role: user.role }, jwtSecret, { expiresIn: "7d" }); }
function setAuthCookie(res, user) {
  res.cookie("nexus_session", tokenFor(user), { httpOnly: true, secure: isProduction, sameSite: "lax", maxAge: 7 * 24 * 60 * 60_000, path: "/" });
}
function auth(req, _res, next) {
  const token = req.cookies.nexus_session;
  if (token) {
    try { req.user = jwt.verify(token, jwtSecret); } catch { req.user = null; }
  }
  next();
}
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Сначала войдите в аккаунт" });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") return res.status(403).json({ error: "Доступ только для администратора" });
  next();
}
app.use(auth);

function analyzeSystem(input) {
  const text = `${input.cpu} ${input.gpu}`.toLowerCase();
  const ram = Number(input.ram);
  const refresh = Number(input.refreshRate);
  const currentFps = Math.max(20, Math.min(500, Number(input.currentFps) || 90));
  const ping = Math.max(1, Math.min(300, Number(input.ping) || 35));
  const highEndGpu = /(4090|4080|4070|7900|7800|6900|6800)/.test(text);
  const midGpu = /(4060|3070|3060|2080|2070|6700|6600)/.test(text);
  const strongCpu = /(i[579]-1[2345]|ryzen [579] [5789]|7800x3d|9800x3d)/.test(text);
  const oldCpu = /(i[357]-[4567]\d{3}|fx-|ryzen [35] [123]\d{3})/.test(text);
  const storagePenalty = input.storage === "hdd" ? 14 : input.storage === "sata" ? 6 : 0;
  const ramPenalty = ram < 16 ? 16 : ram < 32 ? 5 : 0;
  const coolingPenalty = input.cooling === "hot" ? 12 : input.cooling === "unknown" ? 5 : 0;
  const cpuPenalty = oldCpu ? 16 : strongCpu ? 0 : 6;
  const baseScore = Math.max(42, Math.min(96, 96 - storagePenalty - ramPenalty - coolingPenalty - cpuPenalty - (ping > 70 ? 7 : 0)));
  const maxGain = Math.max(4, Math.min(28, 8 + storagePenalty / 2 + ramPenalty / 2 + cpuPenalty / 2 + coolingPenalty / 3));
  const gainLow = Math.max(3, Math.round(maxGain * 0.42));
  const expectedLow = Math.round(currentFps * (1 + gainLow / 100));
  const expectedHigh = Math.round(currentFps * (1 + maxGain / 100));
  let bottleneck = "Смешанная нагрузка";
  if (oldCpu || (refresh >= 144 && currentFps < refresh * 0.65)) bottleneck = "Процессор и фоновые процессы";
  else if (!highEndGpu && input.resolution !== "1080p") bottleneck = "Видеокарта и качество графики";
  else if (ram < 16) bottleneck = "Оперативная память";
  else if (ping > 70) bottleneck = "Сеть и задержка";
  else if (highEndGpu && strongCpu) bottleneck = "Настройка frame time";

  const recommendations = [];
  if (ram < 16) recommendations.push({ title: "Освободить оперативную память", impact: "Высокий", detail: "Закрыть тяжёлые фоновые приложения и проверить автозагрузку. Для современных игр желательно 16 ГБ или больше." });
  if (input.storage === "hdd") recommendations.push({ title: "Перенести игру на SSD", impact: "Высокий", detail: "Снизит подгрузки, фризы и время запуска. Средний FPS может почти не измениться, но frame time станет ровнее." });
  if (input.cooling === "hot") recommendations.push({ title: "Проверить температуры", impact: "Высокий", detail: "При перегреве CPU/GPU снижают частоты. Сначала очистка, кривая вентиляторов и контроль троттлинга." });
  if (ping > 55) recommendations.push({ title: "Стабилизировать соединение", impact: "Средний", detail: "Проводное подключение, отключение фоновых загрузок и подбор ближайшего игрового региона." });
  if (refresh > currentFps * 1.25) recommendations.push({ title: "Настроить профиль под герцовку", impact: "Средний", detail: `Цель — приблизить стабильный FPS к ${refresh} Гц, снизив тяжёлые эффекты и задержку рендера.` });
  recommendations.push({ title: "Выровнять frame time", impact: "Безопасный", detail: "Проверить игровой режим Windows, план питания и процессы с периодическими пиками нагрузки." });
  recommendations.push({ title: `Профиль для ${input.game || "выбранной игры"}`, impact: "Персональный", detail: "Баланс качества и задержки с учётом разрешения, герцовки и вашей цели." });

  return {
    score: baseScore,
    bottleneck,
    expectedFps: { from: expectedLow, to: expectedHigh },
    gain: { from: gainLow, to: Math.round(maxGain) },
    latency: ping > 70 ? "Требует внимания" : ping > 40 ? "Можно улучшить" : "Хорошая",
    profile: highEndGpu && strongCpu ? "High-end / low latency" : midGpu ? "Balanced performance" : "Competitive efficiency",
    recommendations: recommendations.slice(0, 5),
    disclaimer: "Это персональный прогноз по указанным характеристикам. Точный результат требует замера телеметрии на вашем ПК.",
  };
}

app.get("/api/health", async (_req, res) => {
  try { await query("SELECT 1"); res.json({ ok: true, service: "nexus", time: new Date().toISOString() }); }
  catch { res.status(503).json({ ok: false }); }
});

app.get("/api/public-config", async (_req, res) => {
  const [settings, plans, games] = await Promise.all([
    query("SELECT key, value FROM settings"),
    query("SELECT slug, name, regular_price, first_month_price, features FROM plans WHERE active = TRUE ORDER BY regular_price"),
    query("SELECT name, genre, steam_app_id FROM games WHERE active = TRUE ORDER BY sort_order, name LIMIT 40"),
  ]);
  res.json({
    settings: Object.fromEntries(settings.rows.map((row) => [row.key, row.value])),
    plans: plans.rows,
    games: games.rows,
  });
});

app.post("/api/auth/register", authLimiter, async (req, res) => {
  const name = safeName(req.body.name);
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || "");
  if (name.length < 2 || !email.includes("@") || password.length < 8) return res.status(400).json({ error: "Укажите имя, корректный email и пароль от 8 символов" });
  const exists = await query("SELECT id FROM users WHERE email=$1", [email]);
  if (exists.rowCount) return res.status(409).json({ error: "Аккаунт с таким email уже существует" });
  const passwordHash = await bcrypt.hash(password, 12);
  const created = await query("INSERT INTO users(name,email,password_hash) VALUES($1,$2,$3) RETURNING id,name,email,role", [name, email, passwordHash]);
  setAuthCookie(res, created.rows[0]);
  res.status(201).json({ user: created.rows[0] });
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const user = await query("SELECT id,name,email,role,password_hash FROM users WHERE email=$1", [email]);
  if (!user.rowCount || !(await bcrypt.compare(String(req.body.password || ""), user.rows[0].password_hash))) return res.status(401).json({ error: "Неверный email или пароль" });
  const { password_hash: _, ...publicUser } = user.rows[0];
  setAuthCookie(res, publicUser);
  res.json({ user: publicUser });
});

app.get("/api/auth/me", requireAuth, async (req, res) => {
  const result = await query("SELECT id,name,email,role,created_at FROM users WHERE id=$1", [req.user.sub]);
  if (!result.rowCount) return res.status(401).json({ error: "Сессия недействительна" });
  res.json({ user: result.rows[0] });
});

app.post("/api/auth/logout", (_req, res) => {
  res.clearCookie("nexus_session", { path: "/" });
  res.json({ ok: true });
});

app.post("/api/auth/recover", authLimiter, async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const found = await query("SELECT id,email FROM users WHERE email=$1", [email]);
  let previewToken;
  if (found.rowCount) {
    const rawToken = crypto.randomBytes(32).toString("hex");
    if (!isProduction) previewToken = rawToken;
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    await query("INSERT INTO password_resets(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '30 minutes')", [tokenHash, found.rows[0].id]);
    if (process.env.SMTP_HOST) {
      const transport = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: Number(process.env.SMTP_PORT) === 465, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
      const resetUrl = `${process.env.APP_URL || `http://localhost:${port}`}/reset.html?token=${rawToken}`;
      await transport.sendMail({ from: process.env.SMTP_FROM, to: email, subject: "Восстановление Nexus", text: `Ссылка действует 30 минут: ${resetUrl}` });
    } else if (!isProduction) {
      console.info(`[dev] Password reset token for ${email}: ${rawToken}`);
    }
  }
  res.json({ message: "Если аккаунт существует, инструкция отправлена на email", ...(previewToken ? { previewToken } : {}) });
});

app.post("/api/auth/reset", authLimiter, async (req, res) => {
  const rawToken = String(req.body.token || "");
  const password = String(req.body.password || "");
  if (password.length < 8) return res.status(400).json({ error: "Пароль должен содержать минимум 8 символов" });
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const found = await query("SELECT user_id FROM password_resets WHERE token_hash=$1 AND used_at IS NULL AND expires_at>NOW()", [tokenHash]);
  if (!found.rowCount) return res.status(400).json({ error: "Ссылка недействительна или устарела" });
  await query("UPDATE users SET password_hash=$1 WHERE id=$2", [await bcrypt.hash(password, 12), found.rows[0].user_id]);
  await query("UPDATE password_resets SET used_at=NOW() WHERE token_hash=$1", [tokenHash]);
  res.json({ message: "Пароль обновлён" });
});

app.post("/api/diagnostics", diagLimiter, requireAuth, async (req, res) => {
  const input = {
    cpu: String(req.body.cpu || "").slice(0, 120), gpu: String(req.body.gpu || "").slice(0, 120),
    ram: Number(req.body.ram), storage: String(req.body.storage || ""), cooling: String(req.body.cooling || "unknown"),
    resolution: String(req.body.resolution || "1080p"), refreshRate: Number(req.body.refreshRate),
    game: String(req.body.game || "").slice(0, 120), currentFps: Number(req.body.currentFps), ping: Number(req.body.ping),
  };
  if (input.cpu.length < 2 || input.gpu.length < 2 || ![8, 16, 32, 64, 128].includes(input.ram)) return res.status(400).json({ error: "Заполните характеристики системы" });
  const output = analyzeSystem(input);
  const saved = await query("INSERT INTO diagnostics(user_id,input,output) VALUES($1,$2::jsonb,$3::jsonb) RETURNING id,created_at", [req.user.sub, JSON.stringify(input), JSON.stringify(output)]);
  res.status(201).json({ id: saved.rows[0].id, createdAt: saved.rows[0].created_at, input, result: output });
});

app.get("/api/diagnostics/latest", requireAuth, async (req, res) => {
  const found = await query("SELECT id,input,output,created_at FROM diagnostics WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1", [req.user.sub]);
  res.json({ diagnostic: found.rows[0] || null });
});

app.post("/api/subscriptions", requireAuth, async (req, res) => {
  const slug = String(req.body.plan || "").toLowerCase();
  const plan = await query("SELECT slug,name,regular_price,first_month_price FROM plans WHERE slug=$1 AND active=TRUE", [slug]);
  if (!plan.rowCount) return res.status(404).json({ error: "Тариф не найден" });
  await query("INSERT INTO subscriptions(user_id,plan_slug,status) VALUES($1,$2,'pending')", [req.user.sub, slug]);
  const paymentUrl = process.env[`PAYMENT_URL_${slug.toUpperCase()}`] || null;
  res.status(201).json({ plan: plan.rows[0], checkoutUrl: paymentUrl, message: paymentUrl ? "Переходим к оплате" : "Выбор сохранён. Подключите ссылку оплаты в настройках Render." });
});

app.get("/api/admin/stats", requireAdmin, async (_req, res) => {
  const stats = await query("SELECT (SELECT COUNT(*) FROM users)::int users, (SELECT COUNT(*) FROM diagnostics)::int diagnostics, (SELECT COUNT(*) FROM subscriptions)::int subscriptions");
  res.json(stats.rows[0]);
});

app.use("/api", (_req, res) => res.status(404).json({ error: "Метод не найден" }));
app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "Внутренняя ошибка сервера" });
});

await initDb();
const server = app.listen(port, "0.0.0.0", () => console.log(`Nexus listening on :${port}`));
if (process.env.NODE_ENV === "test") server.unref();

export { app, server, analyzeSystem };
