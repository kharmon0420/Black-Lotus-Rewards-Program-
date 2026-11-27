import { config } from './config.js';
import { db, tx, addLedger, normalizePhone } from './db.js';
import { createCustomer, issueStoreCredit, cacheCustomer } from './ls.js';

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export const memberByPhone = (phone) => db.prepare('SELECT * FROM members WHERE phone = ?').get(phone);
const memberByCustomer = (id) => db.prepare('SELECT * FROM members WHERE ls_customer_id = ?').get(id);

export function tiersFor(points) {
  return config.tiers.map((t) => ({ ...t, available: points >= t.points }));
}

// ---------- Lookup ----------
export function lookup(rawPhone) {
  const phone = normalizePhone(rawPhone);
  if (!phone) return { status: 'invalid_phone' };
  const m = memberByPhone(phone);
  if (m) {
    return {
      status: 'member',
      firstName: m.first_name,
      points: Math.max(0, m.points),
      bonusPending: !!m.bonus_pending,
      signupBonus: config.signupBonus,
      birthdaySet: m.birth_month != null,
      birthdayBonus: config.birthdayBonus,
      tiers: tiersFor(m.points),
    };
  }
  const c = db.prepare('SELECT * FROM ls_customers WHERE phone = ?').get(phone);
  if (c) return { status: 'existing_customer', firstName: c.first_name };
  return { status: 'new' };
}

// ---------- Sign up ----------
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const validBirthday = (m, d) => Number.isInteger(m) && Number.isInteger(d) && m >= 1 && m <= 12 && d >= 1 && d <= DAYS_IN_MONTH[m - 1];

/** Month + day only (no year). Can be set once; after that it is locked. */
export function setBirthday({ phone: rawPhone, month, day }) {
  const phone = normalizePhone(rawPhone);
  if (!phone) return { status: 'invalid_phone' };
  const m = Number(month), d = Number(day);
  if (!validBirthday(m, d)) return { status: 'invalid_birthday' };
  const member = memberByPhone(phone);
  if (!member) return { status: 'not_member' };
  const r = db.prepare('UPDATE members SET birth_month = ?, birth_day = ? WHERE id = ? AND birth_month IS NULL').run(m, d, member.id);
  return r.changes ? { status: 'saved', birthdayBonus: config.birthdayBonus } : { status: 'already_set' };
}

export async function signup({ phone: rawPhone, firstName, lastName, email, birthMonth, birthDay }) {
  const phone = normalizePhone(rawPhone);
  if (!phone) return { status: 'invalid_phone' };
  firstName = String(firstName || '').trim();
  if (!firstName) return { status: 'missing_name' };
  email = email ? String(email).trim().toLowerCase() : null;

  if (memberByPhone(phone)) return { status: 'already_member' };

  // Use an existing Lightspeed customer when we can find one (by phone, then by email).
  let existing = db.prepare('SELECT * FROM ls_customers WHERE phone = ?').get(phone);
  if (!existing && email) existing = db.prepare('SELECT * FROM ls_customers WHERE email = ?').get(email);

  let customerId;
  if (existing) {
    customerId = existing.id;
    if (memberByCustomer(customerId)) return { status: 'already_member' };
  } else {
    const created = await createCustomer({ firstName, lastName, phone, email });
    customerId = created.id;
    cacheCustomer({ ...created, mobile: created.mobile ?? phone, first_name: created.first_name ?? firstName, email });
  }

  db.prepare('INSERT INTO members (ls_customer_id, phone, first_name, email) VALUES (?, ?, ?, ?)')
    .run(customerId, phone, existing?.first_name || firstName, email);
  if (validBirthday(Number(birthMonth), Number(birthDay))) setBirthday({ phone, month: birthMonth, day: birthDay });
  return { status: 'signed_up', linkedExisting: !!existing, signupBonus: config.signupBonus, bonusPending: true };
}

// ---------- Sales (from webhook) ----------
const isClosed = (s) => /(^|_)CLOSED$/.test(String(s || '').toUpperCase());
const isVoided = (s, reason) => /VOID/i.test(String(s || '')) || reason === 'voided';

function eligibleDollars(sale) {
  const price = num(sale.totals?.total_price);
  if (price <= 0) return price; // returns come through as negative sales
  const tax = num(sale.totals?.total_tax);
  const storeCredit = (sale.register_sale_payments || [])
    .filter((p) => /store credit/i.test(p.payment_type?.name || p.retailer_payment_type?.name || ''))
    .reduce((s, p) => s + num(p.amount), 0);
  const gross = price + tax;
  const share = gross > 0 ? Math.min(1, storeCredit / gross) : 0;
  return price * (1 - share);
}

export function processSale(sale) {
  const saleId = sale?.id;
  const customerId = sale?.customer_id || sale?.customer?.id;
  if (!saleId || !customerId) return { ignored: 'no sale or customer' };
  const member = memberByCustomer(customerId);
  if (!member) return { ignored: 'customer not enrolled' };

  if (isVoided(sale.status, sale.event_reason)) return reverseSale(member, saleId);
  if (!isClosed(sale.status)) return { ignored: `status ${sale.status}` };

  return tx(() => {
    if (db.prepare('SELECT 1 FROM sales WHERE sale_id = ?').get(saleId)) return { ignored: 'already processed' };

    const eligible = eligibleDollars(sale);
    const raw = eligible * config.pointsPerDollar;
    const points = raw >= 0 ? Math.floor(raw) : Math.ceil(raw);

    db.prepare('INSERT INTO sales (sale_id, member_id, points_earned) VALUES (?, ?, ?)').run(saleId, member.id, points);
    if (points !== 0) addLedger(member.id, points, points > 0 ? 'earn' : 'return', saleId, `sale ${sale.invoice_number ?? ''}`);

    let bonus = 0;
    const fresh = db.prepare('SELECT bonus_pending FROM members WHERE id = ?').get(member.id);
    if (fresh.bonus_pending && points > 0 && eligible >= config.minFirstSale) {
      if (addLedger(member.id, config.signupBonus, 'bonus', `${member.id}:${saleId}`, 'sign-up bonus after first sale')) {
        db.prepare('UPDATE members SET bonus_pending = 0, bonus_sale_id = ? WHERE id = ?').run(saleId, member.id);
        bonus = config.signupBonus;
      }
    }

    // Birthday bonus: first purchase in the member's birthday month (store time), once per year.
    let birthday = 0;
    const bm = db.prepare('SELECT birth_month FROM members WHERE id = ?').get(member.id).birth_month;
    if (bm && points > 0) {
      const when = localParts(sale.sale_date);
      if (when.month === bm && addLedger(member.id, config.birthdayBonus, 'birthday', `${member.id}:${when.year}`, `sale ${saleId}`)) {
        birthday = config.birthdayBonus;
      }
    }
    return { member: member.id, points, bonus, ...(birthday ? { birthday } : {}) };
  });
}

function localParts(saleDate) {
  let d = saleDate ? new Date(saleDate) : new Date();
  if (Number.isNaN(d.getTime())) d = new Date();
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, year: 'numeric', month: 'numeric' }).formatToParts(d);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { year: get('year'), month: get('month') };
}

function reverseSale(member, saleId) {
  return tx(() => {
    const s = db.prepare('SELECT * FROM sales WHERE sale_id = ?').get(saleId);
    if (!s || s.voided) return { ignored: 'nothing to reverse' };
    if (s.points_earned) addLedger(member.id, -s.points_earned, 'void', saleId, 'sale voided');
    const fresh = db.prepare('SELECT * FROM members WHERE id = ?').get(member.id);
    if (fresh.bonus_sale_id === saleId) {
      addLedger(member.id, -config.signupBonus, 'bonus_void', `${member.id}:${saleId}`, 'first sale voided');
      db.prepare('UPDATE members SET bonus_pending = 1, bonus_sale_id = NULL WHERE id = ?').run(member.id);
    }
    const bday = db.prepare("SELECT * FROM ledger WHERE kind = 'birthday' AND note = ?").get(`sale ${saleId}`);
    if (bday) addLedger(member.id, -bday.delta, 'birthday_void', bday.ref, 'sale voided');
    db.prepare('UPDATE sales SET voided = 1 WHERE sale_id = ?').run(saleId);
    return { reversed: s.points_earned };
  });
}

// ---------- Redeem ----------
export async function redeem({ phone: rawPhone, points, clientId }) {
  const phone = normalizePhone(rawPhone);
  const tier = config.tiers.find((t) => t.points === Number(points));
  if (!phone) return { status: 'invalid_phone' };
  if (!tier) return { status: 'invalid_tier' };
  if (!clientId || String(clientId).length > 36) return { status: 'invalid_client_id' };
  const member = memberByPhone(phone);
  if (!member) return { status: 'not_member' };

  const had = db.prepare("SELECT 1 FROM ledger WHERE kind = 'redeem' AND ref = ?").get(clientId);
  const refunded = db.prepare("SELECT 1 FROM ledger WHERE kind = 'redeem_refund' AND ref = ?").get(clientId);
  if (had && refunded) return { status: 'failed_earlier', message: 'That attempt failed; start a new one.' };

  if (!had) {
    const ok = tx(() => {
      const fresh = db.prepare('SELECT points FROM members WHERE id = ?').get(member.id);
      if (fresh.points < tier.points) return false;
      addLedger(member.id, -tier.points, 'redeem', clientId, `$${tier.credit} store credit`);
      return true;
    });
    if (!ok) return { status: 'insufficient_points' };
  }

  try {
    // Same client_id on every retry: Lightspeed ignores duplicates, so credit is issued once.
    await issueStoreCredit(member.ls_customer_id, tier.credit, clientId, `Rewards: ${tier.points} pts`);
  } catch (err) {
    if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) {
      tx(() => addLedger(member.id, tier.points, 'redeem_refund', clientId, 'store credit failed'));
    }
    return { status: 'lightspeed_error', message: String(err.message) };
  }
  const after = db.prepare('SELECT points FROM members WHERE id = ?').get(member.id);
  return { status: 'redeemed', credit: tier.credit, pointsLeft: Math.max(0, after.points), tiers: tiersFor(after.points) };
}
