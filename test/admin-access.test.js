'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {requiredAdminPermission,hasAdminPermission,socketAdminModules}=require('../admin-access');

test('withdrawal viewing and decision rights are separate capabilities',()=>{
  assert.equal(requiredAdminPermission('GET','/api/admin/creator-withdrawals'),'withdrawals:view');
  assert.equal(requiredAdminPermission('POST','/api/admin/creator-withdrawals/abc/decision'),'withdrawals:manage');
  assert.equal(hasAdminPermission(['withdrawals:view'],'withdrawals:view'),true);
  assert.equal(hasAdminPermission(['withdrawals:view'],'withdrawals:manage'),false);
  assert.equal(hasAdminPermission(['withdrawals:manage'],'withdrawals:view'),true);
});

test('custom duties map to the correct protected modules and unknown routes fail closed',()=>{
  assert.equal(requiredAdminPermission('POST','/api/admin/reports/abc/status'),'reports');
  assert.equal(requiredAdminPermission('GET','/api/admin/islamic-review'),'islamic');
  assert.equal(requiredAdminPermission('POST','/api/admin/creators/abc/monetization'),null);
  assert.equal(requiredAdminPermission('POST','/api/admin/unknown-action'),null);
  assert.equal(hasAdminPermission([], 'reports'),false);
});

test('overview access is available to assigned operators without granting other modules',()=>{
  assert.equal(hasAdminPermission(['withdrawals:view'],'overview'),true);
  assert.equal(hasAdminPermission(['settings'],'overview'),false);
  assert.deepEqual(socketAdminModules('custom',['withdrawals:manage']),['withdrawals']);
  assert.deepEqual(socketAdminModules('custom',['reports','islamic']),['reports','islamic']);
  assert.deepEqual(socketAdminModules('moderator',[]),['reports','islamic']);
});
