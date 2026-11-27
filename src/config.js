const env = process.env;

function required(name) {
  const v = env[name];
  if (!v) throw new Error(`Missing required setting ${name}. See .env.example`);
  return v;
}

const prefix = env.LS_DOMAIN_PREFIX || '';

export const config = {
  port: Number(env.PORT) || 3000,
  dbPath: env.DB_PATH || './data/rewards.db',
  publicUrl: (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || '').replace(/\/$/, ''),
  appKey: required('APP_KEY'),
  adminKey: required('ADMIN_KEY'),
  webhookToken: required('WEBHOOK_TOKEN'),
  // Optional staff PIN for redeeming. Off by default: customers redeem on the iPad themselves.
  requirePin: env.REQUIRE_STAFF_PIN === 'true',
  staffPin: env.STAFF_PIN || '',
  ls: {
    prefix,
    clientId: required('LS_CLIENT_ID'),
    clientSecret: required('LS_CLIENT_SECRET'),
    base: env.LS_BASE_URL || `https://${prefix}.retail.lightspeed.app`,
    apiVersion: env.LS_API_VERSION || '2026-10',
    connectUrl: env.LS_CONNECT_URL || 'https://secure.retail.lightspeed.app/connect',
    scopes: [
      'customers:read',
      'customers:write',
      'sales:read',
      'store_credits:read',
      'store_credits:write:issue',
      'webhooks',
    ],
  },
  // Program rules
  pointsPerDollar: 2,
  signupBonus: 100,
  minFirstSale: Number(env.MIN_FIRST_SALE) || 0,
  tiers: [
    { points: 100, credit: 2 },
    { points: 200, credit: 4 },
    { points: 300, credit: 6 },
    { points: 400, credit: 8 },
    { points: 500, credit: 10 },
    { points: 800, credit: 16 },
    { points: 1200, credit: 24 },
  ],
};
