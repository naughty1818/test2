'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseSms, bangladeshDateToUtc } = require('../sms-payments');

for (const provider of ['bkash', 'nagad']) {
  const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'sms', 'unverified', provider + '.json')));
  for (const fixture of fixtures) {
    test(`${fixture.id} parser fixture`, () => {
      const parsed = parseSms(fixture.sender, fixture.body);
      if (fixture.id.startsWith('X')) assert.equal(parsed, null);
      else assert.ok(parsed, `${fixture.id} should parse`);
    });
  }
}

test('parser captures comma amounts, optional Ref and provider details', () => {
  const parsed = parseSms('bKASH', 'You   have received Tk 1,200.00 from +8801800000002.\nFee Tk 0.00. Balance Tk 3,450.00. TrxID GH56IJ78KL at 30/10/2026 15:20');
  assert.deepEqual({ trxId: parsed.trxId, senderPhone: parsed.senderPhone, amountBdt: parsed.amountBdt, balanceBdt: parsed.balanceBdt }, { trxId: 'GH56IJ78KL', senderPhone: '01800000002', amountBdt: 1200, balanceBdt: 3450 });
});

test('Bangladesh local time converts to UTC', () => {
  assert.equal(bangladeshDateToUtc('30/10/2026 14:05').toISOString(), '2026-10-30T08:05:00.000Z');
});
