import { config } from './config.js';
import { db, kvGet, kvSet, normalizePhone } from './db.js';

const L = config.ls;

export class LsError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function tokenUrl(base = L.base) {
  return `${base}/api/1.0/token`;
}

async function tokenRequest(params, base) {
  const res = await fetch(tokenUrl(base), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ client_id: L.clientId, client_secret: L.clientSecret, ...params }),
  });
  const text = await res.text();
  if (!res.ok) throw new LsError(`Token request failed (${res.status})`, res.status, text);
  return JSON.parse(text);
}

function saveTokens(t) {
  kvSet('ls_tokens', {
    access: t.access_token,
    refresh: t.refresh_token, // refresh tokens rotate: always keep the newest
    expires: t.expires || Math.floor(Date.now() / 1000) + (t.expires_in || 3600),
    domainPrefix: t.domain_prefix || L.prefix,
    scope: t.scope,
  });
}

export async function exchangeCode(code, redirectUri, domainPrefix) {
  const base = domainPrefix && L.base === `https://${L.prefix}.retail.lightspeed.app`
    ? `https://${domainPrefix}.retail.lightspeed.app`
    : L.base;
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }, base);
  saveTokens({ ...t, domain_prefix: t.domain_prefix || domainPrefix });
}

let refreshing = null;
async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const cur = kvGet('ls_tokens');
    if (!cur) throw new LsError('Not connected to Lightspeed yet. Visit /auth/start', 401);
    const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: cur.refresh });
    saveTokens({ ...t, domain_prefix: t.domain_prefix || cur.domainPrefix });
    return kvGet('ls_tokens');
  })().finally(() => { refreshing = null; });
  return refreshing;
}

export function isConnected() {
  return !!kvGet('ls_tokens');
}

async function accessToken(force = false) {
  let cur = kvGet('ls_tokens');
  if (!cur) throw new LsError('Not connected to Lightspeed yet. Visit /auth/start', 401);
  if (force || cur.expires - 300 < Date.now() / 1000) cur = await refresh();
  return cur.access;
}

export async function lsFetch(path, { method = 'GET', json, form } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = { authorization: `Bearer ${await accessToken(attempt > 0)}`, accept: 'application/json' };
    let body;
    if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
    if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form); }
    const res = await fetch(`${L.base}${path}`, { method, headers, body });
    if (res.status === 401 && attempt === 0) continue;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) throw new LsError(`Lightspeed ${method} ${path} -> ${res.status}`, res.status, data);
    return data;
  }
}

const api = (p) => `/api/${L.apiVersion}${p}`;

/** Issue store credit; client_id makes retries safe. */
export function issueStoreCredit(customerId, amount, clientId, notes) {
  return lsFetch(api(`/store_credits/${customerId}/transactions`), {
    method: 'POST',
    json: { type: 'ISSUE', amount, client_id: clientId, notes },
  });
}

export async function createCustomer({ firstName, lastName, phone, email }) {
  const res = await lsFetch(api('/customers'), {
    method: 'POST',
    json: {
      first_name: firstName,
      last_name: lastName || null,
      mobile: phone,
      email: email || null,
      enable_promotional_sms: false,
    },
  });
  const c = res?.data ?? res;
  if (!c?.id) throw new LsError('Lightspeed did not return a customer id', 502, res);
  return c;
}

export async function registerWebhook(url, type = 'sale.update') {
  return lsFetch('/api/webhooks', { method: 'POST', form: { url, type, active: 'true' } });
}

// ---- Customer cache (so we can match phone numbers locally) ----

function cacheCustomer(c) {
  if (!c?.id || c.deleted_at) return;
  const phone = normalizePhone(c.mobile) || normalizePhone(c.phone) ||
    normalizePhone(c.contact?.mobile) || normalizePhone(c.contact?.phone);
  db.prepare(`INSERT INTO ls_customers (id, first_name, last_name, email, phone, version)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET first_name=excluded.first_name, last_name=excluded.last_name,
      email=excluded.email, phone=excluded.phone, version=excluded.version`)
    .run(c.id, c.first_name ?? null, c.last_name ?? null,
      c.email ? String(c.email).toLowerCase() : null, phone, c.version ?? null);
}
export { cacheCustomer };

/** Pulls customers changed since the last sync (version-based, per Lightspeed's `after` parameter). */
export async function syncCustomers() {
  let after = kvGet('customer_sync_version') ?? 0;
  let total = 0;
  for (let page = 0; page < 500; page++) {
    const res = await lsFetch(api(`/customers?after=${after}&page_size=1000`));
    const rows = res?.data ?? (Array.isArray(res) ? res : []);
    if (!rows.length) break;
    let maxV = after;
    for (const c of rows) {
      cacheCustomer(c);
      if (typeof c.version === 'number' && c.version > maxV) maxV = c.version;
    }
    total += rows.length;
    const next = res?.version?.max ?? maxV;
    if (!(next > after)) break;
    after = next;
    kvSet('customer_sync_version', after);
  }
  return total;
}
