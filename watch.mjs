#!/usr/bin/env node
// The outside watcher of a web shop.
//
// A shop's own notifications live INSIDE the shop: when its hosting switches the site off, they
// are switched off with it, and nobody is told. This script runs somewhere else, on a schedule,
// opens the shop the way a customer does, and writes to a Telegram chat when something is wrong
// — what is wrong, and what to do about it. It also reminds the chat the day before the hosting
// is charged, and before the domain's registration runs out.
//
// No dependencies; Node 20+. It never exits with an error: its own failure must not look like
// the site's. Everything it remembers between runs is one small JSON file (STATE_FILE).
// Which site, which chat and every name in the messages come from the environment — nothing
// about the shop is written in this file.
//
//   SITE_URL        the shop to watch (required)
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID   where to write (without them it only prints)
//   SITE_COOKIE     a cookie to send with every check, e.g. one that keeps the watcher out of
//                   the shop's own visit statistics
//   HOSTING_PROJECT the project's name at the hosting, for the "what to do" lines
//   DOMAIN_REGISTRAR where the domain is paid for, for the same lines
//   BILLING_DAY     the day of the month the hosting is charged, default 21
//   BILLING_AMOUNT  what is charged, default "20 $"
//   STATE_FILE      default ./state.json
//   DRY_RUN=1       print the messages instead of sending them
//   ANNOUNCE=1      send a one-off "the watcher is on" message
//   SELF_CHECK=1    ask Telegram whether the chat can be written to, without writing to it
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const TIMEOUT_MS = 15_000;
const RETRY_AFTER_MS = 20_000;
/** While the site stays down, say so again this often — once is easy to scroll past. */
const REMIND_EVERY_MS = 6 * 60 * 60 * 1000;
const DOMAIN_NOTICE_DAYS = [30, 7, 1];
const ZONE = "Europe/Kyiv";
const PROJECT = process.env.HOSTING_PROJECT ? `проєкт ${process.env.HOSTING_PROJECT}` : "проєкт сайту";
const REGISTRAR = process.env.DOMAIN_REGISTRAR ? ` (${process.env.DOMAIN_REGISTRAR})` : "";

const PAGE_NAMES = { home: "головна", catalog: "каталог", product: "сторінка товару", checkout: "оформлення замовлення", search: "пошук", orders: "приймання замовлень" };

/** One request, the way every check makes it. Never throws: a failure is a result too. */
export async function probe(url, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS, cookie = process.env.SITE_COOKIE || "" } = {}) {
  const started = Date.now();
  try {
    const response = await fetchImpl(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "site-watch/1.0", accept: "text/html,application/json;q=0.9,*/*;q=0.8", ...(cookie ? { cookie } : {}) },
    });
    const body = await response.text();
    return { status: response.status, vercelError: response.headers.get("x-vercel-error") || "", body, ms: Date.now() - started, error: "" };
  } catch (error) {
    const code = error?.cause?.code || error?.code || error?.cause?.name || error?.name || "ERROR";
    return { status: 0, vercelError: "", body: "", ms: Date.now() - started, error: String(code) };
  }
}

/** What the shop must answer, page by page. `optional` checks are skipped where the site has no such address yet. */
export const CHECKS = [
  { name: "home", path: "/", looksRight: (body) => /<main/i.test(body) && /<a /i.test(body) },
  { name: "catalog", path: "/catalog", looksRight: (body) => /<article/i.test(body) },
  { name: "checkout", path: "/checkout", looksRight: (body) => /<main/i.test(body) },
  // Built by the server's code on every request, unlike the pages above, which are kept ready.
  { name: "search", path: "/search?q=test", looksRight: (body) => /<main/i.test(body) },
  // Whether an order can be stored right now: the shop reads and writes its own database and says so here.
  { name: "orders", path: "/api/health/live", optional: true, looksRight: (body) => { try { return JSON.parse(body).ok === true; } catch { return false; } } },
];

/**
 * Why a check failed, in words the shop's owner can act on — or null when it passed.
 * The order of the tests is the order of how much each explains: the hosting's own verdict
 * first, then the network, then the page.
 */
export function diagnose(check, result) {
  const page = PAGE_NAMES[check.name] ?? check.name;
  const vercel = result.vercelError;
  if (result.status === 402 || vercel === "DEPLOYMENT_DISABLED") {
    return { key: "payment", severity: 100, text: "Vercel вимкнув сайт: не пройшла оплата хостингу або вичерпано ліміт тарифу (код 402).", advice: "Зайдіть на vercel.com → Settings → Billing: перевірте картку та оплату." };
  }
  if (vercel === "DEPLOYMENT_PAUSED") {
    return { key: "paused", severity: 95, text: "Vercel поставив сайт на паузу: спрацювала межа витрат або паузу ввімкнули вручну.", advice: "vercel.com → Settings → Billing → Spend Management, або кнопка Resume у проєкті." };
  }
  if (result.error) {
    const code = result.error;
    if (/ENOTFOUND|EAI_AGAIN/.test(code)) {
      return { key: "dns", severity: 90, text: "Адреса сайту не знаходиться (DNS).", advice: `Перевірте в реєстратора домену${REGISTRAR}, чи оплачено домен і чи не змінювались DNS-записи.` };
    }
    if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) {
      return { key: "tls", severity: 85, text: "Сертифікат безпеки сайту недійсний — браузери показують попередження замість сайту.", advice: `vercel.com → ${PROJECT} → Domains: перевірте стан домену й сертифіката.` };
    }
    if (/Timeout|ETIMEDOUT|ABORT/i.test(code)) {
      return { key: "timeout", severity: 80, text: `Сайт не відповідає: за ${TIMEOUT_MS / 1000} секунд відповіді немає.`, advice: `Перевірте vercel.com → ${PROJECT} і vercel-status.com.` };
    }
    return { key: "connection", severity: 75, text: `З'єднання із сайтом не встановлюється (${code}).`, advice: `Перевірте vercel.com → ${PROJECT} і vercel-status.com.` };
  }
  if (check.optional && (result.status === 404 || result.status === 429)) return null;
  if (check.name === "orders" && result.status !== 200) {
    let problem = "";
    try { problem = JSON.parse(result.body).problem || ""; } catch { /* not the answer of the check itself */ }
    if (problem === "orders_counter") {
      return { key: "orders", severity: 70, text: "Сайт відкривається, але нові замовлення не створюються: пошкоджено лічильник номерів замовлень.", advice: "Напишіть розробнику — це виправляється в базі даних." };
    }
    if (problem === "database" || problem === "not_configured") {
      return { key: "orders", severity: 70, text: "Сайт відкривається, але база даних не відповідає — замовлення не зберігаються.", advice: "Перевірте console.firebase.google.com: стан проєкту та чи не вичерпано денний ліміт." };
    }
  }
  if (vercel) {
    return { key: "platform", severity: 65, text: `Vercel відповідає помилкою ${vercel} (код ${result.status}) — ${page}.`, advice: `vercel.com → ${PROJECT} → Deployments і Logs.` };
  }
  if (result.status >= 500) {
    return { key: "server", severity: 60, text: `Сервер відповідає помилкою ${result.status} — ${page}. Збій у коді сайту або в базі даних.`, advice: `vercel.com → ${PROJECT} → Logs; якщо перед цим була викладка — відкотіть її (Deployments → попередня → Promote).` };
  }
  if (result.status !== 200) {
    return { key: "missing", severity: 50, text: `Не відкривається ${page}: код ${result.status}.`, advice: `Перевірте останню викладку: vercel.com → ${PROJECT} → Deployments.` };
  }
  if (!check.looksRight(result.body)) {
    return { key: "content", severity: 40, text: `${page[0].toUpperCase()}${page.slice(1)}: сторінка відкривається, але вміст порожній або зламаний.`, advice: `Перевірте останню викладку: vercel.com → ${PROJECT} → Deployments.` };
  }
  return null;
}

/** The first product the catalogue links to — checked as a page of its own. */
export function firstProductPath(catalogHtml) {
  return /href="(\/products\/[^"?#]+)/.exec(catalogHtml)?.[1] ?? null;
}

/** Runs every check once. Returns the failures: [{ name, ...diagnosis }]. */
export async function inspect(site, options = {}) {
  const failures = [];
  let catalogBody = "";
  for (const check of CHECKS) {
    const result = await probe(site + check.path, options);
    if (check.name === "catalog") catalogBody = result.body;
    const problem = diagnose(check, result);
    if (problem) failures.push({ name: check.name, ...problem });
    // The hosting's own verdict covers every page: no point asking five more times.
    if (problem && problem.severity >= 75) break;
  }
  if (!failures.length) {
    const productPath = firstProductPath(catalogBody);
    if (productPath) {
      const check = { name: "product", path: productPath, looksRight: (body) => /"@type":"Product"|application\/ld\+json/i.test(body) };
      const problem = diagnose(check, await probe(site + productPath, options));
      if (problem) failures.push({ name: check.name, ...problem });
    }
  }
  return failures;
}

/** One verdict from the failures of a run: the one that explains the most. */
export function verdict(failures) {
  if (!failures.length) return { ok: true };
  const worst = [...failures].sort((a, b) => b.severity - a.severity)[0];
  return { ok: false, key: worst.key, text: worst.text, advice: worst.advice, failing: failures.map((failure) => failure.name) };
}

const kyiv = (ms, options) => new Intl.DateTimeFormat("uk-UA", { timeZone: ZONE, ...options }).format(new Date(ms));
const clock = (ms) => kyiv(ms, { hour: "2-digit", minute: "2-digit" });
const dayAndClock = (ms) => kyiv(ms, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
/** { year, month, day, hour } in Kyiv. */
export function kyivParts(ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), date: `${parts.year}-${parts.month}-${parts.day}` };
}

export function duration(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} хв`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} год ${minutes % 60} хв`;
  return `${Math.floor(hours / 24)} дн ${hours % 24} год`;
}

const host = (site) => site.replace(/^https?:\/\//, "");
/** The headline says how bad it is: the whole site, the orders, or one page. */
const headline = (key) => (key === "orders" ? "Сайт не приймає замовлення" : key === "content" || key === "missing" ? "На сайті несправність" : "Сайт не працює");

/**
 * What to say, given what was known before this run and what it found.
 * Returns the new memory and the messages — it sends nothing itself, so it can be tested whole.
 */
export function step(state, outcome, nowMs, { site = "сайт" } = {}) {
  const next = { ...state };
  const messages = [];
  const down = state.status === "down";
  if (!outcome.ok) {
    const where = outcome.failing?.length ? `\n<b>Не працює:</b> ${outcome.failing.map((name) => PAGE_NAMES[name] ?? name).join(", ")}.` : "";
    if (!down) {
      next.status = "down"; next.since = nowMs; next.reasonKey = outcome.key; next.lastAlertAt = nowMs;
      messages.push(`🔴 <b>${headline(outcome.key)}</b>\n${host(site)} — з ${clock(nowMs)}.\n\n<b>Причина:</b> ${outcome.text}${where}\n<b>Що робити:</b> ${outcome.advice}`);
    } else if (state.reasonKey !== outcome.key) {
      next.reasonKey = outcome.key; next.lastAlertAt = nowMs;
      messages.push(`🔴 <b>Несправність триває — причина змінилась</b>\nТриває вже ${duration(nowMs - state.since)}.\n\n<b>Причина тепер:</b> ${outcome.text}${where}\n<b>Що робити:</b> ${outcome.advice}`);
    } else if (nowMs - (state.lastAlertAt ?? 0) >= REMIND_EVERY_MS) {
      next.lastAlertAt = nowMs;
      messages.push(`🔴 <b>${headline(outcome.key)} — досі</b>, вже ${duration(nowMs - state.since)} (з ${dayAndClock(state.since)}).\n\n<b>Причина:</b> ${outcome.text}\n<b>Що робити:</b> ${outcome.advice}`);
    }
  } else if (down) {
    messages.push(`🟢 <b>Сайт знову працює</b>\nНесправність тривала ${duration(nowMs - state.since)}: з ${dayAndClock(state.since)} до ${dayAndClock(nowMs)}.`);
    next.status = "up"; next.since = nowMs; next.reasonKey = ""; next.lastAlertAt = 0;
  } else if (state.status !== "up") {
    next.status = "up"; next.since = nowMs;
  }
  return { state: next, messages };
}

/** The day before the hosting is charged, from ten in the morning, once a month. */
export function paymentReminder(state, nowMs, { billingDay = 21, amount = "20 $" } = {}) {
  const today = kyivParts(nowMs);
  const tomorrow = kyivParts(nowMs + 24 * 60 * 60 * 1000);
  const month = `${tomorrow.year}-${String(tomorrow.month).padStart(2, "0")}`;
  if (tomorrow.day !== billingDay || today.hour < 10 || state.paymentReminder === month) return { state, messages: [] };
  return {
    state: { ...state, paymentReminder: month },
    messages: [`⏰ <b>Завтра оплата хостингу</b>\n${billingDay}-го числа Vercel спише ${amount} з картки за сайт.\nПеревірте, що на картці є гроші: якщо оплата не пройде, сайт вимкнуть.`],
  };
}

/**
 * Where the public registry answers for a domain. `.com` and `.net` are asked at their own
 * registry: the general-purpose rdap.org turns away anything that is not a browser (403).
 */
function registryUrls(domain) {
  const tld = domain.split(".").pop();
  const own = tld === "com" || tld === "net" ? [`https://rdap.verisign.com/${tld}/v1/domain/${domain}`] : [];
  return [...own, `https://rdap.org/domain/${domain}`];
}

/** When the domain's registration ends, from the public registry. Null when it cannot be read. */
export async function domainExpiry(domain, { fetchImpl = fetch } = {}) {
  for (const url of registryUrls(domain)) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/rdap+json, application/json" } });
      if (!response.ok) continue;
      const event = (await response.json()).events?.find((item) => item.eventAction === "expiration");
      const at = Date.parse(event?.eventDate ?? "");
      if (Number.isFinite(at)) return at;
    } catch {
      /* the next registry address, or none */
    }
  }
  return null;
}

/** Thirty, seven and one day before the domain runs out — each once per expiry date. */
export function domainReminder(state, expiresAtMs, nowMs, { domain = "домен" } = {}) {
  if (!expiresAtMs) return { state, messages: [] };
  const expiry = new Date(expiresAtMs).toISOString().slice(0, 10);
  const daysLeft = Math.ceil((expiresAtMs - nowMs) / (24 * 60 * 60 * 1000));
  const sent = state.domain?.expiry === expiry ? state.domain.sent ?? [] : [];
  const due = DOMAIN_NOTICE_DAYS.filter((days) => daysLeft <= days && !sent.includes(days));
  if (!due.length || daysLeft < 0) return { state: { ...state, domain: { expiry, sent } }, messages: [] };
  const until = kyiv(expiresAtMs, { day: "2-digit", month: "2-digit", year: "numeric" });
  const left = daysLeft <= 0 ? "сьогодні останній день" : daysLeft === 1 ? "залишився 1 день" : `залишилось ${daysLeft} дн.`;
  return {
    // Everything this run has passed is marked, so a watcher switched on late does not send three messages in a row.
    state: { ...state, domain: { expiry, sent: [...new Set([...sent, ...due])] } },
    messages: [`📅 <b>Закінчується оплата домену</b>\n${domain} оплачено до ${until} — ${left}.\nПродовжіть його в реєстратора${REGISTRAR}: без домену сайт перестане відкриватися.`],
  };
}

async function send(message, { token, chat, dryRun }) {
  if (dryRun || !token || !chat) {
    console.log(`--- message${dryRun ? " (dry run)" : " (no Telegram settings)"} ---\n${message}\n---`);
    return true;
  }
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: message, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) console.error("telegram refused the message:", response.status, (await response.text()).slice(0, 200));
    return response.ok;
  } catch (error) {
    console.error("telegram could not be reached:", error?.cause?.code || error?.name);
    return false;
  }
}

/** Whether the chat can be written to — asked of Telegram, with nothing sent to the chat. */
async function canWrite({ token, chat }) {
  if (!token || !chat) return "no Telegram settings";
  try {
    const ask = async (method, body) => (await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) })).json();
    const me = await ask("getMe", {});
    if (!me.ok) return "the bot token is refused";
    const member = await ask("getChatMember", { chat_id: chat, user_id: me.result.id });
    if (!member.ok) return "the chat is not found, or the bot is not in it";
    const status = member.result.status;
    return status === "administrator" || status === "creator" || status === "member" || (status === "restricted" && member.result.can_send_messages) ? "ok" : `the bot is "${status}" in the chat and may not write`;
  } catch (error) {
    return `Telegram could not be reached (${error?.cause?.code || error?.name})`;
  }
}

async function main() {
  const site = (process.env.SITE_URL || "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(site)) { console.error("SITE_URL is not set — nothing to watch"); return; }
  const stateFile = process.env.STATE_FILE || "state.json";
  const telegram = { token: process.env.TELEGRAM_BOT_TOKEN, chat: process.env.TELEGRAM_CHAT_ID, dryRun: process.env.DRY_RUN === "1" };
  if (process.env.SELF_CHECK === "1") console.log("telegram:", await canWrite(telegram));
  let state = {};
  try { state = JSON.parse(await readFile(stateFile, "utf8")); } catch { /* the first run */ }
  const before = JSON.stringify(state);
  const messages = [];

  // 1. the shop itself — a failure is confirmed by a second look before anyone is woken up
  let failures = await inspect(site);
  if (failures.length) {
    console.log("first look failed:", failures.map((failure) => `${failure.name}:${failure.key}`).join(", "), "— looking again");
    await new Promise((resolve) => setTimeout(resolve, RETRY_AFTER_MS));
    failures = await inspect(site);
  }
  const outcome = verdict(failures);
  console.log(outcome.ok ? "site: ok" : `site: DOWN (${outcome.key}) ${outcome.failing.join(", ")}`);
  const now = Date.now();
  let result = step(state, outcome, now, { site });
  state = result.state; messages.push(...result.messages);

  // 2. the day before the hosting is charged
  result = paymentReminder(state, now, { billingDay: Number(process.env.BILLING_DAY) || 21, amount: process.env.BILLING_AMOUNT || "20 $" });
  state = result.state; messages.push(...result.messages);

  // 3. the domain — asked once a day
  const today = kyivParts(now).date;
  if (state.domainCheckedOn !== today) {
    const domain = host(site).replace(/^www\./, "");
    const expiresAt = await domainExpiry(domain);
    if (expiresAt) {
      result = domainReminder(state, expiresAt, now, { domain });
      state = { ...result.state, domainCheckedOn: today }; messages.push(...result.messages);
    }
  }
  state.lastRunOn = today;

  if (process.env.ANNOUNCE === "1") {
    messages.unshift(`🛡 <b>Сторож сайту підключено</b>\nКожні кілька хвилин перевіряю ${host(site)}: чи відкриваються сторінки і чи приймаються замовлення. Якщо щось зламається — напишу сюди причину і що робити.\nЗа день до оплати хостингу (${(Number(process.env.BILLING_DAY) || 21) - 1}-го числа) нагадаю про гроші на картці.`);
  }
  let delivered = true;
  for (const message of messages) delivered = (await send(message, telegram)) && delivered;
  // What was not delivered is not remembered as said: the next run says it again.
  if (delivered && JSON.stringify(state) !== before) await writeFile(stateFile, `${JSON.stringify(state, null, 1)}\n`);
  console.log(`messages: ${messages.length}${delivered ? "" : " (NOT all delivered — state left unchanged)"}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => { console.error("the watcher itself failed:", error); }).finally(() => process.exit(0));
}
