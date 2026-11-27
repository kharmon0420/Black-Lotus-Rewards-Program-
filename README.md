# Black Lotus Rewards: backend service

Keeps the points ledger, talks to Lightspeed X-Series, and serves the iPad app.

## Rules built in
- 2 points per pre-tax dollar. The part of a sale paid with Store Credit earns nothing.
- Sign-up: phone number + first name. Matches an existing Lightspeed customer by phone, then by email; otherwise creates one.
- 100-point sign-up bonus is credited only after the first closed sale (optional minimum: `MIN_FIRST_SALE`).
- Voiding the first sale removes its points and the bonus. Returns take points back.
- Redeem tiers: 100 -> $2, 200 -> $4, 300 -> $6, 400 -> $8, 500 -> $10, 800 -> $16, 1200 -> $24.
  Redeeming issues Store Credit in Lightspeed; the cashier takes "Store Credit" as payment.

## Lightspeed Developer Portal settings
- Redirect URL: `<PUBLIC_URL>/auth/callback`
- Scopes: customers:read, customers:write, sales:read, store_credits:read, store_credits:write:issue, webhooks

## Setup
1. Needs Node 22.5 or newer. No packages to install.
2. `cp .env.example .env`, fill it in, then `export $(grep -v '^#' .env | xargs)` and `npm start`.
   (Most hosts let you paste the settings into a dashboard instead.)
3. Host it somewhere with https and a permanent disk for `DB_PATH`.
4. Visit `<PUBLIC_URL>/auth/start?key=<ADMIN_KEY>` once and approve in Lightspeed.
   If the webhook can't be created automatically, the page tells you how to add it by hand
   (Lightspeed `/setup/api`, type `sale.update`, URL `<PUBLIC_URL>/webhook/<WEBHOOK_TOKEN>`).
5. `npm test` runs a full simulated store (fake Lightspeed) to prove the rules.

## iPad API (header `x-app-key` on everything)
- GET  /api/config
- GET  /api/member?phone=...        -> member | existing_customer | new
- POST /api/signup  {phone, firstName, lastName?, email?}
- POST /api/birthday {phone, month, day}  (month/day only; can be set once)
- POST /api/redeem  {phone, points, clientId}   (clientId = new UUID per tap; header `x-staff-pin` only needed if REQUIRE_STAFF_PIN=true)

## Not yet verified against a live store
Tested against a simulated Lightspeed built from its public docs. These details come from
docs that were incomplete, so check them on first real run: customer list response shape,
the automatic webhook-creation request, and whether the sale's `status` is exactly `CLOSED`.

## Birthday bonus
Members can add a birthday (month and day only, set once, then locked). BIRTHDAY_BONUS points (default 100) are credited with their first purchase in their birthday month, once per year. A voided sale takes the bonus back. TZ_NAME (default America/Chicago) decides what "this month" means.

## Owner report
Open `https://<your-service>.onrender.com/admin/report?key=<ADMIN_KEY>` for members, points, redemptions, estimated program cost, the last 14 days, and top members.
