'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeViewerType,
  normalizeCreatorType,
  resolveIslamicFlag,
  isIslamicEligible
} = require('../content-policy');

test('viewer and creator account types accept only supported values', () => {
  assert.equal(normalizeViewerType('islamic'), 'islamic');
  assert.equal(normalizeViewerType('normal'), 'normal');
  assert.equal(normalizeViewerType('mixed'), null);
  assert.equal(normalizeCreatorType('mixed'), 'mixed');
  assert.equal(normalizeCreatorType('normal'), 'normal');
  assert.equal(normalizeCreatorType('other'), null);
});

test('Islamic and normal creators have fixed classifications; mixed creators choose', () => {
  assert.equal(resolveIslamicFlag('islamic', false), true);
  assert.equal(resolveIslamicFlag('normal', true), false);
  assert.equal(resolveIslamicFlag('mixed', true), true);
  assert.equal(resolveIslamicFlag('mixed', false), false);
  assert.equal(resolveIslamicFlag('mixed', undefined), null);
});

test('Islamic viewers only qualify for approved creator-declared Islamic videos', () => {
  assert.equal(isIslamicEligible({ is_islamic: true, islamic_certification_status: 'approved' }, 'islamic'), true);
  assert.equal(isIslamicEligible({ is_islamic: true, islamic_certification_status: 'pending' }, 'islamic'), false);
  assert.equal(isIslamicEligible({ is_islamic: false, islamic_certification_status: 'approved' }, 'islamic'), false);
  assert.equal(isIslamicEligible({ is_islamic: false, islamic_certification_status: 'not_applicable' }, 'normal'), true);
});
