'use strict';

const CHANNEL_TYPES = Object.freeze(['personal', 'education', 'business', 'organization']);
const PREMIUM_SELLER_CHANNEL_TYPES = new Set(['personal', 'education']);
const AD_REVENUE_CHANNEL_TYPES = new Set(['personal', 'education']);

function isAllowedChannelType(value) {
  return CHANNEL_TYPES.includes(String(value || '').trim().toLowerCase());
}
function canSellPremium(channelType) {
  return PREMIUM_SELLER_CHANNEL_TYPES.has(String(channelType || '').trim().toLowerCase());
}
function canEarnAdRevenue({ channelType, isPremium = false, monetizationEnabled = false, creatorStatus = '' } = {}) {
  return !isPremium && AD_REVENUE_CHANNEL_TYPES.has(String(channelType || '').trim().toLowerCase()) &&
    Boolean(monetizationEnabled) && creatorStatus === 'enabled';
}
function canReceiveCampaign({ viewerType = 'normal', isIslamic = false } = {}) {
  return viewerType !== 'islamic' || Boolean(isIslamic);
}

module.exports = { CHANNEL_TYPES, isAllowedChannelType, canSellPremium, canEarnAdRevenue, canReceiveCampaign };
