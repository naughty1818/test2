'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { encryptPayoutDetails } = require('./payout-security');

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
  // Encrypt any legacy plaintext destinations before serving payout-review APIs. Keep historic columns for rollback, but clear their values after ciphertext verification.
  await withTransaction(async client => {
    const legacy = await client.query(`SELECT id,account_number,payment_method,payout_method FROM creator_withdrawal_requests WHERE account_number IS NOT NULL AND payout_details_ciphertext IS NULL FOR UPDATE`);
    for (const row of legacy.rows) {
      const cipher = encryptPayoutDetails({ accountName:'Legacy payout destination', accountNumber:row.account_number });
      await client.query(`UPDATE creator_withdrawal_requests SET payout_details_ciphertext=$2,payout_method=COALESCE(payout_method,payment_method),account_number=NULL WHERE id=$1`, [row.id,cipher]);
    }
    // If an earlier rollout populated ciphertext but retained the legacy column, ciphertext is now the canonical copy.
    await client.query(`UPDATE creator_withdrawal_requests SET account_number=NULL WHERE account_number IS NOT NULL AND payout_details_ciphertext IS NOT NULL`);
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
