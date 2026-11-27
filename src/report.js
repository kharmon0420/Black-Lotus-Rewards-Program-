import { config } from './config.js';
import { db } from './db.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (n) => Number(n || 0).toLocaleString('en-US');
const creditFor = (points) => config.tiers.find((t) => t.points === points)?.credit ?? points * 0.02;

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
const toLocalDay = (sqlUtc) => dayFmt.format(new Date(String(sqlUtc).replace(' ', 'T') + 'Z'));

export function buildReport() {
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const all = (sql, ...a) => db.prepare(sql).all(...a);

  const members = one('SELECT COUNT(*) c FROM members').c;
  const joined7 = one("SELECT COUNT(*) c FROM members WHERE created_at >= datetime('now','-7 days')").c;
  const joined30 = one("SELECT COUNT(*) c FROM members WHERE created_at >= datetime('now','-30 days')").c;
  const waiting = one('SELECT COUNT(*) c FROM members WHERE bonus_pending = 1').c;
  const outstanding = one('SELECT COALESCE(SUM(MAX(points,0)),0) s FROM members').s;
  const withBirthday = one('SELECT COUNT(*) c FROM members WHERE birth_month IS NOT NULL').c;
  const thisMonth = Number(new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, month: 'numeric' }).format(new Date()));
  const birthdaysNow = one('SELECT COUNT(*) c FROM members WHERE birth_month = ?', thisMonth).c;

  const byKind = Object.fromEntries(all('SELECT kind, SUM(delta) s, COUNT(*) c FROM ledger GROUP BY kind').map((r) => [r.kind, r]));
  const k = (name) => byKind[name]?.s || 0;
  const earned = k('earn') + k('return') + k('void');
  const signupBonus = k('bonus') + k('bonus_void');
  const birthdayBonus = k('birthday') + k('birthday_void');
  const salesDollars = (one('SELECT COALESCE(SUM(points_earned),0) s FROM sales WHERE voided = 0').s) / config.pointsPerDollar;
  const salesCount = one('SELECT COUNT(*) c FROM sales WHERE voided = 0').c;

  const redeems = all("SELECT delta, kind, created_at FROM ledger WHERE kind IN ('redeem','redeem_refund')");
  let redeemedPoints = 0, redeemedDollars = 0, redeemCount = 0;
  for (const r of redeems) {
    const sign = r.kind === 'redeem' ? 1 : -1;
    const pts = Math.abs(r.delta);
    redeemedPoints += sign * pts; redeemedDollars += sign * creditFor(pts); redeemCount += sign;
  }
  const liability = outstanding * 0.02;
  const costRate = salesDollars > 0 ? (redeemedDollars / salesDollars) * 100 : 0;

  // Last 14 days (store time)
  const days = [];
  for (let i = 0; i < 14; i++) days.push(dayFmt.format(new Date(Date.now() - i * 86_400_000)));
  const daily = Object.fromEntries(days.map((d) => [d, { joined: 0, earned: 0, redeemed: 0 }]));
  for (const r of all("SELECT created_at FROM members WHERE created_at >= datetime('now','-15 days')")) {
    const d = toLocalDay(r.created_at); if (daily[d]) daily[d].joined++;
  }
  for (const r of all("SELECT delta, kind, created_at FROM ledger WHERE created_at >= datetime('now','-15 days')")) {
    const d = toLocalDay(r.created_at); if (!daily[d]) continue;
    if (r.kind === 'earn') daily[d].earned += r.delta;
    if (r.kind === 'redeem') daily[d].redeemed += creditFor(Math.abs(r.delta));
    if (r.kind === 'redeem_refund') daily[d].redeemed -= creditFor(Math.abs(r.delta));
  }

  const top = all('SELECT first_name, phone, points FROM members ORDER BY points DESC, id LIMIT 10');

  return {
    members, joined7, joined30, waiting, outstanding, liability, withBirthday, birthdaysNow,
    earned, signupBonus, birthdayBonus, salesDollars, salesCount, redeemedPoints, redeemedDollars, redeemCount, costRate,
    days, daily, top,
  };
}

export function renderReport() {
  const r = buildReport();
  const stat = (label, value, sub = '') =>
    `<div class="card"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ''}</div>`;
  const rows = r.days.map((d) => {
    const x = r.daily[d];
    return `<tr><td>${esc(d)}</td><td>${x.joined}</td><td>${num(x.earned)}</td><td>${money(x.redeemed)}</td></tr>`;
  }).join('');
  const topRows = r.top.map((m) =>
    `<tr><td>${esc(m.first_name || '—')}</td><td>…${esc(String(m.phone).slice(-4))}</td><td>${num(m.points)}</td></tr>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Black Lotus Rewards report</title>
<style>
body{margin:0;background:#0b0b0d;color:#f2f2f5;font:16px/1.4 -apple-system,system-ui,sans-serif;padding:20px;max-width:860px;margin:auto}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 10px;color:#cdb0ff}.sub{color:#9a9aa5;font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px}
.card{background:#17171b;border-radius:12px;padding:14px}.v{font-size:26px;font-weight:700}.l{color:#b9b9c4;font-size:13px}.s{color:#8a8a95;font-size:12px;margin-top:2px}
table{width:100%;border-collapse:collapse;background:#17171b;border-radius:12px;overflow:hidden}
th,td{padding:9px 12px;text-align:left;border-bottom:1px solid #26262c;font-size:14px}th{color:#9a9aa5;font-weight:600}
</style></head><body>
<h1>Black Lotus Rewards</h1>
<div class="sub">Report generated ${esc(new Date().toLocaleString('en-US', { timeZone: config.timezone }))} (${esc(config.timezone)})</div>

<h2>Members</h2>
<div class="grid">
${stat('Total members', num(r.members))}
${stat('Joined last 7 days', num(r.joined7))}
${stat('Joined last 30 days', num(r.joined30))}
${stat('Waiting on first purchase', num(r.waiting), 'signed up, bonus not yet paid')}
${stat('Birthdays on file', num(r.withBirthday), `${r.birthdaysNow} this month`)}
</div>

<h2>Points and rewards</h2>
<div class="grid">
${stat('Points earned from purchases', num(r.earned))}
${stat('Sign-up bonus points', num(r.signupBonus))}
${stat('Birthday bonus points', num(r.birthdayBonus))}
${stat('Rewards redeemed', num(r.redeemCount), `${money(r.redeemedDollars)} in store credit`)}
${stat('Points outstanding', num(r.outstanding), `about ${money(r.liability)} if all redeemed`)}
</div>

<h2>Program cost</h2>
<div class="grid">
${stat('Sales from members (approx.)', money(r.salesDollars), `${num(r.salesCount)} sales, before tax`)}
${stat('Credit given vs sales', `${r.costRate.toFixed(1)}%`, 'redeemed credit / member sales')}
</div>

<h2>Last 14 days</h2>
<table><tr><th>Date</th><th>New members</th><th>Points earned</th><th>Credit redeemed</th></tr>${rows}</table>

<h2>Top members by points</h2>
<table><tr><th>Name</th><th>Phone</th><th>Points</th></tr>${topRows || '<tr><td colspan="3">No members yet</td></tr>'}</table>
<p class="sub">Sales and cost figures only count purchases made since the program started. Dollar values for outstanding points assume the best reward rate (2 cents per point).</p>
</body></html>`;
}
