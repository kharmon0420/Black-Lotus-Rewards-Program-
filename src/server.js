import { createServer } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { kvGet, kvSet } from './db.js';
import { exchangeCode, isConnected, registerWebhook, syncCustomers } from './ls.js';
import { lookup, processSale, redeem, setBirthday, signup } from './rewards.js';
import { renderReport } from './report.js';

const safeEq = (a, b) => {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
};

// A '+' in a link's query string is read as a space; accept both so copy/pasted keys just work.
const adminKeyOk = (v) => safeEq(String(v ?? '').replace(/ /g, '+'), config.adminKey);

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'content-type': type });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// ---- simple in-memory throttles ----
const hits = new Map();
function throttle(ip, bucket, max, windowMs) {
  const key = `${bucket}:${ip}`, now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  return arr.length <= max;
}
const pinFails = new Map();
const pinLocked = (ip) => {
  const f = pinFails.get(ip);
  return f && f.count >= 5 && Date.now() - f.last < 10 * 60_000;
};

function verifySignature(rawBody, header) {
  const m = /signature=([^,\s]+)/.exec(header || '');
  if (!m) return false;
  const mac = () => createHmac('sha256', config.ls.clientSecret).update(rawBody);
  const hex = mac().digest('hex'), b64 = mac().digest('base64');
  return safeEq(m[1], hex) || safeEq(m[1], b64);
}

function parseWebhook(raw) {
  const text = raw.toString('utf8');
  if (text.trim().startsWith('{')) return JSON.parse(text);
  const p = new URLSearchParams(text).get('payload');
  return p ? JSON.parse(p) : null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = req.socket.remoteAddress || '?';
  try {
    if (url.pathname === '/health') return send(res, 200, { ok: true, connected: isConnected() });

    // ----- Connect Lightspeed (admin only) -----
    if (url.pathname === '/auth/start') {
      if (!adminKeyOk(url.searchParams.get('key'))) return send(res, 403, { error: 'forbidden' });
      const state = randomBytes(16).toString('hex');
      kvSet('oauth_state', { state, at: Date.now() });
      const q = new URLSearchParams({
        response_type: 'code',
        client_id: config.ls.clientId,
        redirect_uri: `${config.publicUrl}/auth/callback`,
        state,
        scope: config.ls.scopes.join(' '),
      });
      res.writeHead(302, { location: `${config.ls.connectUrl}?${q}` });
      return res.end();
    }
    if (url.pathname === '/auth/callback') {
      const saved = kvGet('oauth_state');
      const state = url.searchParams.get('state');
      if (!saved || !safeEq(state, saved.state) || Date.now() - saved.at > 15 * 60_000) {
        return send(res, 400, 'Bad or expired state. Start again at /auth/start.', 'text/plain');
      }
      kvSet('oauth_state', null);
      const code = url.searchParams.get('code');
      if (!code) return send(res, 400, 'Access was not granted.', 'text/plain');
      await exchangeCode(code, `${config.publicUrl}/auth/callback`, url.searchParams.get('domain_prefix'));
      let note = '';
      try {
        await registerWebhook(`${config.publicUrl}/webhook/${config.webhookToken}`);
        note = 'Webhook registered.';
      } catch (e) {
        note = `Connected, but could not register the webhook automatically (${e.message}). Add it by hand at https://${config.ls.prefix}.retail.lightspeed.app/setup/api : type sale.update, URL ${config.publicUrl}/webhook/${config.webhookToken}`;
      }
      syncCustomers().catch((e) => console.error('initial sync failed', e.message));
      return send(res, 200, `Connected to Lightspeed. ${note}`, 'text/plain');
    }

    // ----- Owner report (admin only) -----
    if (url.pathname === '/admin/report') {
      if (!adminKeyOk(url.searchParams.get('key'))) return send(res, 403, { error: 'forbidden' });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(renderReport());
    }

    // ----- Lightspeed webhook -----
    if (url.pathname === `/webhook/${config.webhookToken}` && req.method === 'POST') {
      const raw = await readBody(req);
      const sig = req.headers['x-signature'];
      if (sig && !verifySignature(raw, sig)) return send(res, 401, { error: 'bad signature' });
      const payload = parseWebhook(raw);
      if (payload && process.env.DEBUG_SALE_HOOKS === '1') {
        // Diagnostic only: shape of each sale event (no names/contact details).
        const items = payload.register_sale_products || payload.line_items || [];
        console.log('sale-hook', JSON.stringify({
          id: String(payload.id || '').slice(0, 8), status: payload.status, state: payload.state,
          reason: payload.event_reason, keys: Object.keys(payload).slice(0, 40),
          hasCustomer: !!(payload.customer_id || payload.customer?.id), items: items.length,
          itemKeys: items[0] ? Object.keys(items[0]) : [],
        }));
      }
      const result = payload ? processSale(payload) : { ignored: 'no payload' };
      return send(res, 200, { ok: true, result });
    }

    // ----- iPad app API -----
    if (url.pathname.startsWith('/api/')) {
      if (!throttle(ip, 'api', 120, 60_000)) return send(res, 429, { error: 'slow down' });
      if (!safeEq(req.headers['x-app-key'], config.appKey)) return send(res, 401, { error: 'unauthorized' });
      const body = req.method === 'POST' ? JSON.parse((await readBody(req)).toString() || '{}') : {};

      if (url.pathname === '/api/config' && req.method === 'GET') {
        return send(res, 200, { pointsPerDollar: config.pointsPerDollar, signupBonus: config.signupBonus, birthdayBonus: config.birthdayBonus, tiers: config.tiers });
      }
      if (url.pathname === '/api/member' && req.method === 'GET') {
        return send(res, 200, lookup(url.searchParams.get('phone')));
      }
      if (url.pathname === '/api/signup' && req.method === 'POST') {
        if (!throttle(ip, 'signup', 20, 60 * 60_000)) return send(res, 429, { error: 'too many sign-ups' });
        return send(res, 200, await signup(body));
      }
      if (url.pathname === '/api/birthday' && req.method === 'POST') {
        if (!throttle(ip, 'birthday', 30, 60 * 60_000)) return send(res, 429, { error: 'slow down' });
        return send(res, 200, setBirthday(body));
      }
      if (url.pathname === '/api/redeem' && req.method === 'POST') {
        if (!throttle(ip, 'redeem', 30, 60 * 60_000)) return send(res, 429, { error: 'too many attempts' });
        if (config.requirePin) {
          if (pinLocked(ip)) return send(res, 429, { error: 'PIN locked for 10 minutes' });
          if (!safeEq(req.headers['x-staff-pin'], config.staffPin)) {
            const f = pinFails.get(ip) || { count: 0 };
            pinFails.set(ip, { count: f.count + 1, last: Date.now() });
            return send(res, 403, { error: 'wrong PIN' });
          }
          pinFails.delete(ip);
        }
        // Without a PIN, limit how often any one phone number can be redeemed.
        if (!throttle(String(body.phone || ''), 'redeem-phone', 10, 60 * 60_000)) return send(res, 429, { error: 'too many redemptions for this number; ask a team member' });
        return send(res, 200, await redeem(body));
      }
    }
    return send(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(err);
    return send(res, err.status || 500, { error: err.status ? err.message : 'server error' });
  }
});

server.listen(config.port, () => console.log(`Rewards service on :${config.port} (connected: ${isConnected()})`));

// Keep the local customer list (for phone matching) fresh.
const sync = () => isConnected() && syncCustomers().catch((e) => console.error('customer sync failed:', e.message));
setTimeout(sync, 5_000);
setInterval(sync, 10 * 60_000);
