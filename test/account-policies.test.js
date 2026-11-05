'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CHANNEL_TYPES, isAllowedChannelType, canSellPremium, canEarnAdRevenue, canReceiveCampaign } = require('../account-policies');

test('first-edition channel types exclude Other', () => {
  assert.deepEqual(CHANNEL_TYPES, ['personal', 'education', 'business', 'organization']);
  assert.equal(isAllowedChannelType('other'), false);
  assert.equal(isAllowedChannelType('education'), true);
});

test('only personal and education channels can sell Premium', () => {
  for (const type of ['personal', 'education']) assert.equal(canSellPremium(type), true);
  for (const type of ['business', 'organization', 'other']) assert.equal(canSellPremium(type), false);
});

test('ad earnings require approved monetization, an eligible channel, and non-premium content', () => {
  const base = { channelType: 'personal', monetizationEnabled: true, creatorStatus: 'enabled' };
  assert.equal(canEarnAdRevenue(base), true);
  assert.equal(canEarnAdRevenue({ ...base, channelType: 'business' }), false);
  assert.equal(canEarnAdRevenue({ ...base, isPremium: true }), false);
  assert.equal(canEarnAdRevenue({ ...base, creatorStatus: 'pending' }), false);
  assert.equal(canEarnAdRevenue({ ...base, monetizationEnabled: false }), false);
});

test('Islamic campaigns show in Islamic mode and both modes only when marked Islamic', () => {
  assert.equal(canReceiveCampaign({ viewerType: 'islamic', isIslamic: true }), true);
  assert.equal(canReceiveCampaign({ viewerType: 'normal', isIslamic: true }), true);
  assert.equal(canReceiveCampaign({ viewerType: 'normal', isIslamic: false }), true);
  assert.equal(canReceiveCampaign({ viewerType: 'islamic', isIslamic: false }), false);
});
