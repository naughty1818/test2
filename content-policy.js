'use strict';

const VIEWER_TYPES = new Set(['islamic', 'normal']);
const CREATOR_TYPES = new Set(['islamic', 'normal', 'mixed']);

function normalizeViewerType(value) {
  return VIEWER_TYPES.has(value) ? value : null;
}

function normalizeCreatorType(value) {
  return CREATOR_TYPES.has(value) ? value : null;
}

function resolveIslamicFlag(creatorType, requestedValue) {
  if (creatorType === 'islamic') return true;
  if (creatorType === 'normal') return false;
  if (creatorType === 'mixed' && typeof requestedValue === 'boolean') return requestedValue;
  return null;
}

function isIslamicEligible(video, viewerType = 'normal') {
  if (viewerType !== 'islamic') return true;
  return Boolean(video?.is_islamic) && video?.islamic_certification_status === 'approved';
}

module.exports = { normalizeViewerType, normalizeCreatorType, resolveIslamicFlag, isIslamicEligible };
