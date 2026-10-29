'use strict';

function requiredAdminPermission(method, path) {
  const route=String(path||'');
  if(route==='/api/admin/overview')return 'overview';
  if(route.startsWith('/api/admin/creator-withdrawals'))return String(method).toUpperCase()==='GET'?'withdrawals:view':'withdrawals:manage';
  if(route.startsWith('/api/admin/review-queue')||route.startsWith('/api/admin/reports')||route.startsWith('/api/admin/appeals')||route.startsWith('/api/admin/strikes'))return 'reports';
  if(route.startsWith('/api/admin/islamic-review'))return 'islamic';
  if(route.startsWith('/api/admin/content')||route.startsWith('/api/admin/actions'))return 'content';
  if(route.startsWith('/api/admin/channel-applications')||route.startsWith('/api/admin/shop-')||route.startsWith('/api/admin/verification-requests'))return 'creators';
  if(route.startsWith('/api/admin/campaigns')||route.startsWith('/api/admin/ad-analytics')||route.startsWith('/api/admin/wallet/'))return 'campaigns';
  if(route.startsWith('/api/admin/audit'))return 'audit';
  if(route.startsWith('/api/admin/settings'))return 'settings';
  if(route.startsWith('/api/admin/members'))return 'staff';
  return null;
}

function hasAdminPermission(permissions, required) {
  if(!Array.isArray(permissions)||!required)return false;
  return permissions.includes('*')||permissions.includes(required)||
    (required==='withdrawals:view'&&permissions.includes('withdrawals:manage'))||
    (required==='overview'&&permissions.some(permission=>permission!=='staff'&&permission!=='settings'));
}

function socketAdminModules(role, permissions=[]) {
  if(role==='owner'||role==='admin')return ['reports','withdrawals','islamic'];
  if(role==='moderator')return ['reports','islamic'];
  const modules=[];
  if(hasAdminPermission(permissions,'reports'))modules.push('reports');
  if(hasAdminPermission(permissions,'withdrawals:view'))modules.push('withdrawals');
  if(hasAdminPermission(permissions,'islamic'))modules.push('islamic');
  return modules;
}

module.exports={requiredAdminPermission,hasAdminPermission,socketAdminModules};
