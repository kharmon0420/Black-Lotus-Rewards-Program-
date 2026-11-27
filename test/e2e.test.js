// End-to-end test against a fake Lightspeed. Run: npm test
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { rmSync } from 'node:fs';
import assert from 'node:assert/strict';

const MOCK = 4511, APP = 4512;
const calls = { credit: [], created: [], tokens: [], webhooks: [] };
let creditFail = false;

const mock = createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString();
  const json = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/1.0/token') {
    const p = new URLSearchParams(body); calls.tokens.push(p.get('grant_type'));
    return json({ access_token: 'acc' + calls.tokens.length, refresh_token: 'ref' + calls.tokens.length, expires_in: 1, token_type: 'Bearer', domain_prefix: 'test' });
  }
  if (u.pathname.endsWith('/customers') && req.method === 'GET') {
    const after = Number(u.searchParams.get('after'));
    const all = [
      { id: 'c-old', first_name: 'Olive', last_name: 'Old', email: 'olive@example.com', mobile: '(214) 555-0101', version: 5 },
      { id: 'c-email', first_name: 'Eli', last_name: 'Mail', email: 'eli@example.com', mobile: null, version: 6 },
    ];
    return json({ data: all.filter((c) => c.version > after) });
  }
  if (u.pathname.endsWith('/customers') && req.method === 'POST') {
    const b = JSON.parse(body); calls.created.push(b);
    return json({ data: { id: 'c-new-' + calls.created.length, ...b, version: 100 } }, 201);
  }
  if (u.pathname.includes('/store_credits/') && req.method === 'POST') {
    if (creditFail) return json({ error: 'nope' }, 400);
    const b = JSON.parse(body); calls.credit.push({ customer: u.pathname.split('/')[4], ...b });
    return json({ id: 't1' }, 201);
  }
  if (u.pathname === '/api/webhooks') { calls.webhooks.push(body); return json({ id: 'w1' }); }
  json({ error: 'unmocked ' + u.pathname }, 404);
});
await new Promise((r) => mock.listen(MOCK, r));

rmSync('/tmp/rw-test', { recursive: true, force: true });
const env = {
  ...process.env, PORT: APP, DB_PATH: '/tmp/rw-test/db.sqlite', PUBLIC_URL: `http://localhost:${APP}`,
  APP_KEY: 'appkey', ADMIN_KEY: 'adminkey', WEBHOOK_TOKEN: 'whtok', STAFF_PIN: '123456', REQUIRE_STAFF_PIN: process.env.NOPIN === '1' ? 'false' : 'true',
  LS_DOMAIN_PREFIX: 'test', LS_CLIENT_ID: 'cid', LS_CLIENT_SECRET: 'csecret', LS_BASE_URL: `http://localhost:${MOCK}`,
};
const svc = spawn('node', ['--disable-warning=ExperimentalWarning', 'src/server.js'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => svc.stdout.on('data', (d) => String(d).includes('Rewards service') && r()));

const base = `http://localhost:${APP}`;
const H = { 'x-app-key': 'appkey', 'content-type': 'application/json' };
const get = async (p, h = H) => (await fetch(base + p, { headers: h })).json();
const post = async (p, b, h = H) => { const r = await fetch(base + p, { method: 'POST', headers: h, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
const sale = (o) => ({
  id: 's1', status: 'CLOSED', event_reason: 'closed', invoice_number: '1', customer_id: 'c-old',
  totals: { total_price: '50.00', total_tax: '4.00' }, register_sale_payments: [{ amount: 54, payment_type: { name: 'Cash' } }], ...o,
});
const webhook = (payload, { sign = true, token = 'whtok' } = {}) => {
  const raw = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (sign) headers['x-signature'] = `signature=${createHmac('sha256', 'csecret').update(raw).digest('hex')},algorithm=HMAC-SHA256`;
  return fetch(`${base}/webhook/${token}`, { method: 'POST', headers, body: raw }).then(async (r) => ({ status: r.status, body: await r.json() }));
};

let failed = 0;
const t = async (name, fn) => { try { await fn(); console.log('  ok  ', name); } catch (e) { failed++; console.log('  FAIL', name, '\n      ', e.message); } };

try {
  await t('API rejects missing app key', async () => assert.equal((await fetch(base + '/api/config')).status, 401));
  await t('connect flow: start -> callback stores tokens + registers webhook', async () => {
    const r = await fetch(`${base}/auth/start?key=adminkey`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    const loc = new URL(r.headers.get('location'));
    assert.equal(loc.searchParams.get('client_id'), 'cid');
    assert.match(loc.searchParams.get('scope'), /store_credits:write:issue/);
    const cb = await fetch(`${base}/auth/callback?code=abc&domain_prefix=test&state=${loc.searchParams.get('state')}`);
    assert.equal(cb.status, 200);
    assert.equal(calls.webhooks.length, 1);
    await new Promise((r) => setTimeout(r, 400)); // initial customer sync
  });
  await t('bad state is refused', async () => assert.equal((await fetch(`${base}/auth/callback?code=x&state=nope`)).status, 400));

  await t('lookup: unknown number is "new"', async () => assert.equal((await get('/api/member?phone=9725550000')).status, 'new'));
  await t('lookup: existing Lightspeed customer found by phone', async () => assert.equal((await get('/api/member?phone=214-555-0101')).status, 'existing_customer'));

  await t('sign up an existing customer (links, no duplicate created)', async () => {
    const r = await post('/api/signup', { phone: '2145550101', firstName: 'Olive' });
    assert.equal(r.body.status, 'signed_up'); assert.equal(r.body.linkedExisting, true);
    assert.equal(calls.created.length, 0);
    assert.equal((await post('/api/signup', { phone: '(214) 555-0101', firstName: 'Olive' })).body.status, 'already_member');
  });
  await t('sign up links an email-only customer by email', async () => {
    const r = await post('/api/signup', { phone: '4695550102', firstName: 'Eli', email: 'ELI@example.com' });
    assert.equal(r.body.linkedExisting, true); assert.equal(calls.created.length, 0);
  });
  await t('sign up a brand-new customer creates them in Lightspeed', async () => {
    const r = await post('/api/signup', { phone: '9725550199', firstName: 'Nina' });
    assert.equal(r.body.status, 'signed_up'); assert.equal(calls.created.length, 1);
    assert.equal(calls.created[0].mobile, '9725550199');
    assert.equal(calls.created[0].enable_promotional_sms, false);
  });
  await t('new member starts at 0 points with bonus pending', async () => {
    const m = await get('/api/member?phone=2145550101');
    assert.equal(m.points, 0); assert.equal(m.bonusPending, true);
  });

  await t('webhook: wrong token 404, bad signature 401', async () => {
    assert.equal((await webhook(sale(), { token: 'wrong' })).status, 404);
    const raw = 'payload=%7B%7D';
    const r = await fetch(`${base}/webhook/whtok`, { method: 'POST', headers: { 'x-signature': 'signature=deadbeef,algorithm=HMAC-SHA256' }, body: raw });
    assert.equal(r.status, 401);
  });
  await t('first sale ($50 pre-tax) earns 100 + 100 sign-up bonus = 200', async () => {
    const r = await webhook(sale());
    assert.equal(r.body.result.points, 100); assert.equal(r.body.result.bonus, 100);
    assert.equal((await get('/api/member?phone=2145550101')).points, 200);
  });
  await t('same sale delivered twice does not double count', async () => {
    await webhook(sale());
    assert.equal((await get('/api/member?phone=2145550101')).points, 200);
  });
  await t('second sale earns 2 pts/$ with no new bonus', async () => {
    await webhook(sale({ id: 's2', totals: { total_price: '10.49', total_tax: '0.86' } }));
    assert.equal((await get('/api/member?phone=2145550101')).points, 220); // floor(10.49 * 2) = 20
  });
  await t('paying with store credit does not earn points on the credit portion', async () => {
    // $10 pre-tax + $0 tax, fully paid with store credit -> nothing eligible
    await webhook(sale({ id: 's3', totals: { total_price: '10.00', total_tax: '0.00' },
      register_sale_payments: [{ amount: 10, payment_type: { name: 'Store Credit' } }] }));
    assert.equal((await get('/api/member?phone=2145550101')).points, 220);
  });
  await t('walk-in / un-enrolled customers are ignored', async () => {
    const r = await webhook(sale({ id: 's4', customer_id: 'someone-else' }));
    assert.match(r.body.result.ignored, /not enrolled/);
  });
  await t('open (unpaid) sales are ignored', async () => {
    const r = await webhook(sale({ id: 's5', status: 'SAVED', event_reason: 'created' }));
    assert.match(r.body.result.ignored, /status/);
  });

  if (process.env.NOPIN !== '1') await t('redeem needs the staff PIN', async () => {
    const r = await post('/api/redeem', { phone: '2145550101', points: 200, clientId: 'r-1' });
    assert.equal(r.status, 403);
  });
  const PIN = { ...H, 'x-staff-pin': '123456' };
  await t('redeem 200 points -> $4 store credit issued once, even if retried', async () => {
    const a = await post('/api/redeem', { phone: '2145550101', points: 200, clientId: 'r-2' }, PIN);
    assert.equal(a.body.status, 'redeemed'); assert.equal(a.body.credit, 4); assert.equal(a.body.pointsLeft, 20);
    const b = await post('/api/redeem', { phone: '2145550101', points: 200, clientId: 'r-2' }, PIN);
    assert.equal(b.body.status, 'redeemed'); assert.equal(b.body.pointsLeft, 20); // not charged twice
    assert.equal(calls.credit.length, 2); // app retried the call; same client_id lets Lightspeed dedupe
    assert.ok(calls.credit.every((c) => c.client_id === 'r-2' && c.amount === 4 && c.type === 'ISSUE' && c.customer === 'c-old'));
  });
  await t('cannot redeem more than the balance', async () => {
    const r = await post('/api/redeem', { phone: '2145550101', points: 100, clientId: 'r-3' }, PIN);
    assert.equal(r.body.status, 'insufficient_points');
  });
  await t('only real tiers are accepted', async () => {
    const r = await post('/api/redeem', { phone: '2145550101', points: 150, clientId: 'r-4' }, PIN);
    assert.equal(r.body.status, 'invalid_tier');
  });
  await t('if Lightspeed rejects the credit, points are given back', async () => {
    await webhook(sale({ id: 's6', totals: { total_price: '100.00', total_tax: '8.00' } })); // +200 -> 220
    creditFail = true;
    const r = await post('/api/redeem', { phone: '2145550101', points: 200, clientId: 'r-5' }, PIN);
    creditFail = false;
    assert.equal(r.body.status, 'lightspeed_error');
    assert.equal((await get('/api/member?phone=2145550101')).points, 220);
  });

  await t('voiding the first sale removes its points AND the sign-up bonus', async () => {
    // fresh member: Nina
    await webhook(sale({ id: 'n1', customer_id: 'c-new-1', totals: { total_price: '20.00', total_tax: '1.60' } }));
    assert.equal((await get('/api/member?phone=9725550199')).points, 140); // 40 + 100
    await webhook(sale({ id: 'n1', customer_id: 'c-new-1', status: 'VOIDED', event_reason: 'voided', totals: { total_price: '20.00', total_tax: '1.60' } }));
    const m = await get('/api/member?phone=9725550199');
    assert.equal(m.points, 0); assert.equal(m.bonusPending, true);
  });
  await t('a return (negative sale) takes points back', async () => {
    await webhook(sale({ id: 'n2', customer_id: 'c-new-1', totals: { total_price: '30.00', total_tax: '2.40' } })); // +60 +100 bonus
    await webhook(sale({ id: 'n3', customer_id: 'c-new-1', totals: { total_price: '-10.00', total_tax: '-0.80' } })); // -20
    assert.equal((await get('/api/member?phone=9725550199')).points, 140);
  });
  await t('token refresh happens when the access token expires', async () => {
    await new Promise((r) => setTimeout(r, 1200));
    const r = await post('/api/redeem', { phone: '2145550101', points: 100, clientId: 'r-6' }, PIN);
    assert.equal(r.body.status, 'redeemed');
    assert.ok(calls.tokens.includes('refresh_token'));
  });
  if (process.env.NOPIN !== '1') await t('PIN locks after 5 wrong tries', async () => {
    for (let i = 0; i < 5; i++) await post('/api/redeem', { phone: '2145550101', points: 100, clientId: 'x' + i }, { ...H, 'x-staff-pin': '000000' });
    const r = await post('/api/redeem', { phone: '2145550101', points: 100, clientId: 'x9' }, PIN);
    assert.equal(r.status, 429);
  });
} finally {
  svc.kill(); mock.close();
  console.log(failed ? `\n${failed} FAILED` : '\nAll passed');
  process.exit(failed ? 1 : 0);
}
