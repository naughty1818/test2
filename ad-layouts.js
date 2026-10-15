'use strict';

const DEVICES = ['desktop', 'mobile'];
const PLACEMENTS = ['feed', 'watch_sidebar', 'channel', 'sticky_banner', 'postroll'];
const MIN_PX = 20;
const MAX_PX = 4096;
const MAX_MONTHLY_CAP = 2147483647;

const DEFAULT_AD_LAYOUTS = Object.freeze({
  feed: { desktop: { width: 640, height: 360 }, mobile: { width: 360, height: 203 } },
  watch_sidebar: { desktop: { width: 184, height: 138 }, mobile: { width: 92, height: 69 } },
  channel: { desktop: { width: 720, height: 405 }, mobile: { width: 360, height: 203 } },
  sticky_banner: { desktop: { width: 960, height: 320 }, mobile: { width: 360, height: 120 } },
  postroll: { desktop: { width: 720, height: 405 }, mobile: { width: 360, height: 203 } },
  l_banner: {
    desktop: { right: { width: 150, height: 642 }, bottom: { width: 320, height: 78 } },
    mobile: { right: { width: 40, height: 167 }, bottom: { width: 160, height: 39 } }
  }
});

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSize(value, fallback, label) {
  if (value === undefined || value === null) return { ...fallback };
  if (!isRecord(value)) throw new Error(`${label} size must contain width and height.`);
  const width = Number(value.width);
  const height = Number(value.height);
  if (!Number.isInteger(width) || width < MIN_PX || width > MAX_PX || !Number.isInteger(height) || height < MIN_PX || height > MAX_PX) {
    throw new Error(`${label} width and height must be whole CSS pixels from ${MIN_PX} to ${MAX_PX}.`);
  }
  return { width, height };
}

function normalizeAdLayouts(value) {
  if (value === undefined || value === null) return structuredClone(DEFAULT_AD_LAYOUTS);
  if (!isRecord(value)) throw new Error('Ad layouts must be an object.');
  const layouts = {};
  for (const placement of PLACEMENTS) {
    layouts[placement] = {};
    for (const device of DEVICES) {
      layouts[placement][device] = normalizeSize(value[placement]?.[device], DEFAULT_AD_LAYOUTS[placement][device], `${placement} ${device}`);
    }
  }
  layouts.l_banner = {};
  for (const device of DEVICES) {
    const fallback = DEFAULT_AD_LAYOUTS.l_banner[device];
    const sizeSet = value.l_banner?.[device];
    if (sizeSet !== undefined && !isRecord(sizeSet)) throw new Error(`l_banner ${device} must define right and bottom image sizes.`);
    layouts.l_banner[device] = {
      right: normalizeSize(sizeSet?.right, fallback.right, `L-shape ${device} right image`),
      bottom: normalizeSize(sizeSet?.bottom, fallback.bottom, `L-shape ${device} bottom image`)
    };
  }
  return layouts;
}

function normalizeMonthlyImpressionCap(value) {
  if (value === undefined || value === null || value === '') return null;
  const cap = Number(value);
  if (!Number.isInteger(cap) || cap < 1 || cap > MAX_MONTHLY_CAP) {
    throw new Error(`Monthly cap must be a whole number from 1 to ${MAX_MONTHLY_CAP}, or blank for unlimited.`);
  }
  return cap;
}

function normalizeFeedAdEveryRows(value) {
  const rows = Number(value);
  if (!Number.isInteger(rows) || rows < 1 || rows > 20) throw new Error('Feed ad interval must be a whole number from 1 to 20 rows.');
  return rows;
}

function ratioLabel(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return '—';
  const ratio = width / height;
  return ratio >= 1 ? `${ratio.toFixed(2)}:1` : `1:${(1 / ratio).toFixed(2)}`;
}

module.exports = {
  DEFAULT_AD_LAYOUTS,
  normalizeAdLayouts,
  normalizeMonthlyImpressionCap,
  normalizeFeedAdEveryRows,
  ratioLabel,
  MIN_PX,
  MAX_PX,
  MAX_MONTHLY_CAP
};
