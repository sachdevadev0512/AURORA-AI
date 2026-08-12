# Aurora Backend

Node.js / Express API for Aurora. Syncs Amazon Seller Central data (listings, orders, shipments, ads) into MongoDB and exposes authenticated REST + Socket.IO updates to the Aurora frontend.

## Architecture

| Area | Location |
|------|----------|
| HTTP app factory (routes, CORS, webhook raw-body) | `src/app.js` |
| Process bootstrap + background workers | `src/index.js` |
| Amazon SP-API façade | `src/utils/amazonAPI.js` → `src/utils/amazon/*` |
| Persisted sync jobs (inventory / orders / shipments) | `src/services/*SyncService.js` |
| Per-user live schedulers (fees, repricer, ads) | `src/services/*LiveSync.js`, `src/services/adsSyncService.js` |
| Shared sync primitives | `src/services/sync/` |
| Models | `src/models/` |

**Guarantees for maintainability refactors:** route paths, response envelopes, Mongo schemas/indexes, env var names, Socket.IO event names, and sync timing semantics stay stable unless intentionally changed in a feature PR.

## Runtime

```bash
npm install
cp .env.example .env   # if present; otherwise copy from staging secrets
npm run dev            # nodemon src/index.js
npm start              # node src/index.js
```

Health check: `GET /api/health` → `{ success: true, message: "Aurora Backend API is running", ... }`.

### Important middleware order

1. Amazon SNS webhook (`POST /api/notifications/webhook/amazon`) uses `express.raw` **before** `express.json`.
2. JSON body parser and authenticated API routes follow.
3. Global `errorHandler` is last.

### Background workers (env-gated)

Started from `src/index.js` after listen:

- Ads live sync / report queue (`ADS_LIVE_SYNC_ENABLED`, queue poller)
- Product index ensure (`ensureProductIndexes`)
- Resume interrupted inventory / order sync jobs
- Order notifications + SQS poller (`ORDER_NOTIFICATIONS_ENABLED`)
- Product fee live sync / repricer live sync
- Shipment job recovery + live tracking (`SHIPMENT_LIVE_TRACKING_ENABLED`)

## Tests and verification

```bash
npm run check:syntax   # node --check on src/**/*.js
npm test               # Jest (characterization + unit)
npm run test:node      # node:test suites (listing prices, SNS verifier)
npm run test:all       # both runners
```

Golden fixtures live under `test/fixtures/` (orders, products, shipments, ads, Amazon reports).

## Operational scripts

Scripts under `scripts/` should:

1. Scope work to a seller (`--email` / `--sellerId`) when mutating data
2. Default to dry-run; require `--apply` (or `--write`) to persist
3. Batch large updates and print a JSON summary

Shared helpers: `scripts/lib/scriptRunner.js`.

Example pattern:

```js
const { parseArgs, isDryRun, resolveSellerUser, printSummary } = require('./lib/scriptRunner');
```

## API surface (high level)

- `/api/auth` — login, Amazon connect
- `/api/products` — inventory list/export, sync control, repricer
- `/api/orders` — orders list/export/sync
- `/api/shipments` — FBA/AWD shipments + sync
- `/api/ads` — campaigns + metrics sync
- `/api/sp-api` — thin SP-API proxies (performance, financial events, reports)
- `/api/notifications`, `/api/user-notifications` — SNS webhook + in-app inbox

Socket rooms: `user_<userId>`. Sync progress events include `inventorySyncStatus`, `orderSyncStatus`, `productFeeLiveSyncStatus`, and ads/shipment equivalents.

## Environment

Required vars are validated by `src/config/validateEnv.js` at boot (Mongo URI, JWT secret, Amazon LWA client credentials, etc.). Do not commit `.env` or `.sqs-local.json`.
