'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { encryptPayoutDetails } = require('./payout-security');

// CONCURRENTLY avoids blocking normal reads/writes while existing tables are indexed. Keep each statement standalone.
const PERFORMANCE_INDEX_MIGRATIONS = [
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS premium_orders_playlist_buyer_recent_idx ON premium_playlist_orders (playlist_id,buyer_sub,created_at DESC) WHERE status IN ('pending','paid')`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS premium_orders_video_buyer_recent_idx ON premium_playlist_orders (video_id,buyer_sub,created_at DESC) WHERE video_id IS NOT NULL AND status IN ('pending','paid')`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS premium_orders_provider_reference_idx ON premium_playlist_orders (provider_reference) WHERE provider_reference IS NOT NULL`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS ad_events_created_idx ON ad_events (created_at DESC)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS talent_orders_buyer_updated_idx ON talent_orders (buyer_sub,updated_at DESC)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS talent_orders_provider_created_idx ON talent_orders (provider_sub,created_at DESC)`
];

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required. Add the Neon pooled connection string to the hosting environment.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
  application_name: 'clipnest-video-hub'
});

pool.on('error', error => {
  console.error('Unexpected idle PostgreSQL client error:', error.message);
});

async function initializeDatabase() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  for (const statement of PERFORMANCE_INDEX_MIGRATIONS) await pool.query(statement);
  // These two legacy definitions were equivalent; keep the review index and drop the duplicate without blocking writes.
  await pool.query('DROP INDEX CONCURRENTLY IF EXISTS creator_withdrawals_status_idx');
  // Encrypt any legacy plaintext destinations before serving payout-review APIs. Keep historic columns for rollback, but clear their values after ciphertext verification.
  await withTransaction(async client => {
    const columns = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='creator_withdrawal_requests'`);
    const present = new Set(columns.rows.map(row => row.column_name));
    // The repository has existed with both plaintext and encrypted-only table layouts.
    if (present.has('account_number')) {
      const methodExpr = present.has('payment_method') ? 'payment_method' : 'NULL::text';
      const legacy = await client.query(`SELECT id,account_number,${methodExpr} AS payment_method,payout_method FROM creator_withdrawal_requests WHERE account_number IS NOT NULL AND payout_details_ciphertext IS NULL FOR UPDATE`);
      for (const row of legacy.rows) {
        const cipher = encryptPayoutDetails({ accountName:'Legacy payout destination', accountNumber:row.account_number });
        await client.query(`UPDATE creator_withdrawal_requests SET payout_details_ciphertext=$2,payout_method=COALESCE(payout_method,$3),account_number=NULL WHERE id=$1`, [row.id,cipher,row.payment_method]);
      }
      // Once encrypted, remove cleartext from the legacy column.
      await client.query(`UPDATE creator_withdrawal_requests SET account_number=NULL WHERE account_number IS NOT NULL AND payout_details_ciphertext IS NOT NULL`);
    }
  });
  await pool.query('SELECT 1');
}

async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { pool, initializeDatabase, withTransaction };
