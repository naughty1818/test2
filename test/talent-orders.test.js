'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const attachTalentMarketplace = require('../talent-marketplace');

test('My Talent purchases endpoint scopes results to the signed-in buyer', async () => {
  const routes = new Map();
  let queryText = '';
  let queryParams;
  const app = { get: (path, ...handlers) => routes.set(path, handlers.at(-1)), post: () => {}, patch: () => {}, put: () => {}, delete: () => {} };
  const pool = { query: async (sql, params) => {
    queryText = sql;
    queryParams = params;
    return { rows: [{
      id: 'order-1', status: 'awaiting_provider', amount_bdt: '1200.00',
      created_at: new Date('2026-01-01T00:00:00Z'), updated_at: new Date('2026-01-02T00:00:00Z'),
      contract_snapshot: { listingTitle: 'Web design', packageName: 'Basic', deliveryDays: 5, revisions: 1 },
      buyer_brief: 'Build a small landing page for my local business.', provider_name: 'Creator One',
      provider_handle: 'creator-one', latest_event_type: 'created', latest_event_details: 'Approval is pending.'
    }] };
  } };
  attachTalentMarketplace({
    app, pool, withTransaction: async fn => fn({}),
    requireAuth: (_req,_res,next) => next(), requireActive: (_req,_res,next) => next(),
    requireChannel: (_req,_res,next) => next(), validUuid: () => true
  });
  const handler = routes.get('/api/me/talent/purchases');
  assert.equal(typeof handler, 'function');
  let response;
  let nextError;
  await handler({ auth: { session: { sub: 'buyer-sub-123' } } }, { json: value => { response = value; } }, error => { nextError = error; });
  assert.equal(nextError, undefined);
  assert.match(queryText, /WHERE o\.buyer_sub=\$1/);
  assert.deepEqual(queryParams, ['buyer-sub-123']);
  assert.equal(response.purchases[0].status, 'awaiting_provider');
  assert.equal(response.purchases[0].providerName, 'Creator One');
  assert.equal(response.purchases[0].latestEvent.details, 'Approval is pending.');
});
