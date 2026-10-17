'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_AD_LAYOUTS,
  normalizeAdLayouts,
  normalizeMonthlyImpressionCap,
  normalizeFeedAdEveryRows,
  ratioLabel
} = require('../ad-layouts');

test('defaults include requested L-shape PC and mobile widths', () => {
  assert.deepEqual(DEFAULT_AD_LAYOUTS.l_banner.desktop.right, { width: 150, height: 642 });
  assert.deepEqual(DEFAULT_AD_LAYOUTS.l_banner.mobile.right, { width: 40, height: 167 });
});

test('legacy or empty layout settings receive a complete default configuration', () => {
  const layouts = normalizeAdLayouts({});
  assert.deepEqual(layouts.feed.desktop, DEFAULT_AD_LAYOUTS.feed.desktop);
  assert.deepEqual(layouts.l_banner.mobile.bottom, DEFAULT_AD_LAYOUTS.l_banner.mobile.bottom);
  assert.equal(layouts.sticky_banner.showSponsorDetails, true);
});

test('placement display settings use one master switch for all sponsor text', () => {
  const layouts = normalizeAdLayouts({ sticky_banner: { showSponsorDetails: false } });
  assert.equal(layouts.sticky_banner.showSponsorDetails, false);
  assert.equal(layouts.feed.showSponsorDetails, true);
  assert.equal(layouts.l_banner.showSponsorDetails, true);
});

test('legacy title/link visibility settings migrate to the master switch', () => {
  assert.equal(normalizeAdLayouts({ sticky_banner: { showTitle: false, showLandingLink: true } }).sticky_banner.showSponsorDetails, false);
  assert.equal(normalizeAdLayouts({ sticky_banner: { showTitle: true, showLandingLink: true } }).sticky_banner.showSponsorDetails, true);
});

test('placement display settings only accept boolean values', () => {
  assert.throws(() => normalizeAdLayouts({ feed: { showSponsorDetails: 'false' } }), /must be on or off/);
  assert.throws(() => normalizeAdLayouts({ l_banner: { showTitle: 0 } }), /must be on or off/);
});

test('layout settings reject non-integer, undersized, and oversized CSS pixels', () => {
  assert.throws(() => normalizeAdLayouts({ feed: { desktop: { width: 12, height: 180 } } }), /20 to 4096/);
  assert.throws(() => normalizeAdLayouts({ feed: { mobile: { width: 360.5, height: 203 } } }), /whole CSS pixels/);
  assert.throws(() => normalizeAdLayouts({ l_banner: { desktop: { right: { width: 5000, height: 642 } } } }), /20 to 4096/);
});

test('campaign monthly cap is optional or a positive integer', () => {
  assert.equal(normalizeMonthlyImpressionCap(''), null);
  assert.equal(normalizeMonthlyImpressionCap(25000), 25000);
  assert.throws(() => normalizeMonthlyImpressionCap(0), /whole number/);
  assert.throws(() => normalizeMonthlyImpressionCap(1.5), /whole number/);
});

test('feed ad interval is constrained to one through twenty rows', () => {
  assert.equal(normalizeFeedAdEveryRows(4), 4);
  assert.throws(() => normalizeFeedAdEveryRows(0), /1 to 20 rows/);
  assert.throws(() => normalizeFeedAdEveryRows(21), /1 to 20 rows/);
});

test('ratio labels use portrait and landscape orientation', () => {
  assert.equal(ratioLabel(150, 642), '1:4.28');
  assert.equal(ratioLabel(320, 78), '4.10:1');
});
