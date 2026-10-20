'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { encryptPayoutDetails, decryptPayoutDetails } = require('../payout-security');

test('payout destination round-trips encrypted and never appears in ciphertext', () => {
  const previous = process.env.PAYOUT_ENCRYPTION_KEY;
  process.env.PAYOUT_ENCRYPTION_KEY = 'test-only-stable-payout-encryption-key-32';
  try {
    const details = { accountName: 'Test Creator', accountNumber: '01700000000' };
    const ciphertext = encryptPayoutDetails(details);
    assert.equal(decryptPayoutDetails(ciphertext).accountNumber, details.accountNumber);
    assert.equal(ciphertext.includes(details.accountNumber), false);
  } finally {
    if (previous === undefined) delete process.env.PAYOUT_ENCRYPTION_KEY;
    else process.env.PAYOUT_ENCRYPTION_KEY = previous;
  }
});

test('tampered payout ciphertext fails authentication', () => {
  const previous = process.env.PAYOUT_ENCRYPTION_KEY;
  process.env.PAYOUT_ENCRYPTION_KEY = 'test-only-stable-payout-encryption-key-32';
  try {
    const ciphertext = encryptPayoutDetails({ accountName: 'Test', accountNumber: '01700000000' });
    const parts = ciphertext.split('.');
    parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
    assert.throws(() => decryptPayoutDetails(parts.join('.')));
  } finally {
    if (previous === undefined) delete process.env.PAYOUT_ENCRYPTION_KEY;
    else process.env.PAYOUT_ENCRYPTION_KEY = previous;
  }
});
