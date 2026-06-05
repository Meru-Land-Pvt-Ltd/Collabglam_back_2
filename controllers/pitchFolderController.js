'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const PitchFolder = require('../models/pitchFolder');
const { AdminModel, ROLES } = require('../models/master');
const InfluencerProfile = require('../models/youtube');

const Campaign = require('../models/campaign');
const ApplyCampaign = require('../models/applyCampaign');
const { InfluencerModel } = require('../models/influencer');
const saveErrorLog = require('../services/errorLog.service');

let BookmarkFolder = null;
try {
  const bookmarkFolderModule = require('../models/bookmarkFolder');
  BookmarkFolder =
    bookmarkFolderModule?.BookmarkFolder ||
    bookmarkFolderModule?.BookmarkFolderModel ||
    bookmarkFolderModule?.default ||
    bookmarkFolderModule;
} catch (err) {
  try {
    const bookmarkFolderModule = require('../models/bookmark');
    BookmarkFolder =
      bookmarkFolderModule?.BookmarkFolder ||
      bookmarkFolderModule?.BookmarkFolderModel ||
      bookmarkFolderModule?.default ||
      bookmarkFolderModule;
  } catch (innerErr) {
    BookmarkFolder = null;
  }
}


const ALLOWED_PROVIDERS = ['instagram', 'youtube', 'tiktok'];
const MEDIA_KIT_REQUEST_STATUSES = ['none', 'requested', 'approved', 'rejected'];

let s3ClientSingleton = null;

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function cleanStr(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function getAuthedBrandId(req = {}) {
  return cleanStr(
    req.brand?._id ||
    req.brand?.id ||
    req.brand?.brandId ||
    req.brandId ||
    req.user?.brandId ||
    req.user?.brand?._id ||
    req.user?.brand?.id ||
    req.user?._id ||
    req.user?.id
  );
}

function getRequestedBrandId(req = {}) {
  return (
    getAuthedBrandId(req) ||
    cleanStr(req.query?.brandId || req.body?.brandId || req.admin?.brandId)
  );
}

function buildBrandScopeOr(brandId) {
  const id = cleanStr(brandId);
  if (!id) return [];

  const or = [
    { brandId: id },
    { brandRef: id },
    { 'brand._id': id },
    { 'brand.id': id },
    { 'assignedCampaign.brandId': id },
  ];

  if (mongoose.Types.ObjectId.isValid(id)) {
    const objectId = new mongoose.Types.ObjectId(id);
    or.push(
      { brandId: objectId },
      { brandRef: objectId },
      { 'brand._id': objectId },
      { 'assignedCampaign.brandId': objectId }
    );
  }

  return or;
}

function applyBrandScopeToFilter(filter = {}, brandId = '') {
  const brandOr = buildBrandScopeOr(brandId);
  if (!brandOr.length) return filter;

  const nextFilter = { ...filter };
  const existingAnd = Array.isArray(nextFilter.$and) ? nextFilter.$and : [];
  nextFilter.$and = [...existingAnd, { $or: brandOr }];
  return nextFilter;
}

function buildBrandScopedPitchFolderFilter(brandId) {
  return applyBrandScopeToFilter({ archivedAt: null }, brandId);
}

function buildBrandScopedBookmarkFilter(brandId) {
  return applyBrandScopeToFilter({ archivedAt: null }, brandId);
}

function sameMongoIdLike(a, b) {
  const left = cleanStr(a?._id || a);
  const right = cleanStr(b?._id || b);
  return !!left && !!right && left === right;
}

function assertBrandCanUseCampaign(campaign, brandId) {
  const scopedBrandId = cleanStr(brandId);
  if (!scopedBrandId || !campaign) return true;

  return sameMongoIdLike(campaign.brandId, scopedBrandId);
}


async function findCampaignByAnyIdForAssignment(campaignId) {
  const id = cleanStr(campaignId);
  if (!id) return null;

  const or = [{ campaignsId: id }];

  if (mongoose.Types.ObjectId.isValid(id)) {
    or.push({ _id: new mongoose.Types.ObjectId(id) });
  }

  return Campaign.findOne({ $or: or })
    .select('_id campaignsId brandId brandName productOrServiceName campaignTitle applicantCount hasApplied')
    .lean();
}

function uniqStrings(values = []) {
  const out = [];
  const seen = new Set();

  for (const value of values) {
    const s = cleanStr(value);
    if (!s) continue;

    const key = s.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    out.push(s);
  }

  return out;
}


function buildAssignedCampaignMatchOr(rawCampaignId, campaign = null) {
  const values = uniqStrings([
    rawCampaignId,
    campaign?._id ? String(campaign._id) : '',
    campaign?.campaignsId,
  ]);

  const or = [];

  for (const value of values) {
    if (!value) continue;

    or.push({ 'assignedCampaign.campaignId': value });
    or.push({ 'assignedCampaign.campaignsId': value });

    if (mongoose.Types.ObjectId.isValid(value)) {
      or.push({
        'assignedCampaign.campaignId': new mongoose.Types.ObjectId(value),
      });
    }
  }

  return or;
}

function toNullableNumber(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toNullableInteger(v) {
  const n = toNullableNumber(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function slugify(value) {
  return cleanStr(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function getActorAdminId(actor) {
  return actor?.adminId || actor?._id || actor?.id || null;
}

function toDesignation(role) {
  const raw = cleanStr(role).toLowerCase();
  if (!raw) return '';
  return raw
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function isSuperAdmin(actor) {
  return cleanStr(actor?.role).toLowerCase() === ROLES.SUPER_ADMIN;
}

function isRevenueHead(actor) {
  return cleanStr(actor?.role).toLowerCase() === ROLES.REVENUE_HEAD;
}

function isIme(actor) {
  return cleanStr(actor?.role).toLowerCase() === ROLES.IME;
}

function canCreateOrManagePitchFolders(actor) {
  if (!actor) return false;
  return isSuperAdmin(actor) || isRevenueHead(actor) || isIme(actor);
}

function normalizeProvider(value) {
  const raw = cleanStr(value).toLowerCase();
  if (raw === 'insta' || raw === 'ig') return 'instagram';
  if (ALLOWED_PROVIDERS.includes(raw)) return raw;
  return 'instagram';
}

function hasStoredMediaKit(mediaKit) {
  return !!cleanStr(mediaKit?.s3Key);
}

function hasMediaKitLink(mediaKitLink) {
  return !!cleanStr(mediaKitLink?.url);
}

function getVisibleMediaKitSource(item) {
  const pdfVisible = hasStoredMediaKit(item?.mediaKit) && !!item?.mediaKit?.showToBrand;
  const linkVisible = hasMediaKitLink(item?.mediaKitLink) && !!item?.mediaKitLink?.showToBrand;

  if (pdfVisible) return 'pdf';
  if (linkVisible) return 'link';
  return '';
}

function getRequestedMediaKitSource(item) {
  const pdfRequested = cleanStr(item?.mediaKit?.requestStatus).toLowerCase() === 'requested';
  const linkRequested = cleanStr(item?.mediaKitLink?.requestStatus).toLowerCase() === 'requested';

  if (pdfRequested) return 'pdf';
  if (linkRequested) return 'link';
  return '';
}

function getPreferredMediaKitSource(item) {
  const visibleSource = getVisibleMediaKitSource(item);
  if (visibleSource) return visibleSource;

  const requestedSource = getRequestedMediaKitSource(item);
  if (requestedSource) return requestedSource;

  if (hasStoredMediaKit(item?.mediaKit)) return 'pdf';
  if (hasMediaKitLink(item?.mediaKitLink)) return 'link';
  return '';
}

function getGenericMediaKitRequestStatus(item) {
  const visibleSource = getVisibleMediaKitSource(item);
  if (visibleSource) return 'approved';

  const pdfStatus = cleanStr(item?.mediaKit?.requestStatus).toLowerCase();
  const linkStatus = cleanStr(item?.mediaKitLink?.requestStatus).toLowerCase();

  if (pdfStatus === 'requested' || linkStatus === 'requested') return 'requested';
  if (pdfStatus === 'rejected' || linkStatus === 'rejected') return 'rejected';
  return 'none';
}

function getGenericMediaKitRequestedAt(item) {
  const candidates = [item?.mediaKit?.requestedAt, item?.mediaKitLink?.requestedAt]
    .filter(Boolean)
    .map((value) => new Date(value))
    .filter((value) => !Number.isNaN(value.getTime()))
    .sort((a, b) => b.getTime() - a.getTime());

  return candidates.length ? candidates[0] : null;
}

function ensureSingleSharedMediaKit(item, preferredSource = '') {
  const hasPdf = hasStoredMediaKit(item?.mediaKit);
  const hasLink = hasMediaKitLink(item?.mediaKitLink);

  if (item?.mediaKit?.showToBrand && !hasPdf) {
    item.mediaKit.showToBrand = false;
  }

  if (item?.mediaKitLink?.showToBrand && !hasLink) {
    item.mediaKitLink.showToBrand = false;
  }

  const pdfVisible = hasPdf && !!item?.mediaKit?.showToBrand;
  const linkVisible = hasLink && !!item?.mediaKitLink?.showToBrand;

  if (pdfVisible && linkVisible) {
    if (preferredSource === 'link') {
      item.mediaKit.showToBrand = false;
      if (cleanStr(item?.mediaKit?.requestStatus).toLowerCase() === 'approved') {
        item.mediaKit.requestStatus = 'none';
      }
    } else {
      item.mediaKitLink.showToBrand = false;
      if (cleanStr(item?.mediaKitLink?.requestStatus).toLowerCase() === 'approved') {
        item.mediaKitLink.requestStatus = 'none';
      }
    }
  }
}

function ensureGenericRequestConsistency(item) {
  if (!item.mediaKit) {
    item.mediaKit = normalizeMediaKit(null, null);
  }

  if (!item.mediaKitLink) {
    item.mediaKitLink = normalizeMediaKitLink(null, null);
  }

  if (item.mediaKit.showToBrand) {
    item.mediaKit.requestStatus = 'approved';
  }

  if (item.mediaKitLink.showToBrand) {
    item.mediaKitLink.requestStatus = 'approved';
  }

  ensureSingleSharedMediaKit(item);
}

function setVisibleMediaKitSource(item, source, actorId = null) {
  const reviewedAt = new Date();

  if (!item.mediaKit) {
    item.mediaKit = normalizeMediaKit(null, actorId);
  }

  if (!item.mediaKitLink) {
    item.mediaKitLink = normalizeMediaKitLink(null, actorId);
  }

  if (source === 'pdf') {
    if (!hasStoredMediaKit(item.mediaKit)) {
      throw new Error('No MediaKit PDF uploaded for this influencer yet');
    }

    item.mediaKit.showToBrand = true;
    item.mediaKit.requestStatus = 'approved';
    item.mediaKit.reviewedAt = reviewedAt;
    item.mediaKit.reviewedByAdminId = actorId || null;

    item.mediaKitLink.showToBrand = false;
    item.mediaKitLink.requestStatus = 'none';
    item.mediaKitLink.reviewedAt = reviewedAt;
    item.mediaKitLink.reviewedByAdminId = actorId || null;

    return;
  }

  if (source === 'link') {
    if (!hasMediaKitLink(item.mediaKitLink)) {
      throw new Error('No media kit link generated for this influencer yet');
    }

    item.mediaKitLink.showToBrand = true;
    item.mediaKitLink.requestStatus = 'approved';
    item.mediaKitLink.reviewedAt = reviewedAt;
    item.mediaKitLink.reviewedByAdminId = actorId || null;

    item.mediaKit.showToBrand = false;
    item.mediaKit.requestStatus = 'none';
    item.mediaKit.reviewedAt = reviewedAt;
    item.mediaKit.reviewedByAdminId = actorId || null;

    return;
  }

  item.mediaKit.showToBrand = false;
  item.mediaKit.requestStatus = 'none';
  item.mediaKit.reviewedAt = reviewedAt;
  item.mediaKit.reviewedByAdminId = actorId || null;

  item.mediaKitLink.showToBrand = false;
  item.mediaKitLink.requestStatus = 'none';
  item.mediaKitLink.reviewedAt = reviewedAt;
  item.mediaKitLink.reviewedByAdminId = actorId || null;
}

function markSpecificMediaKitHidden(item, source, actorId = null) {
  const reviewedAt = new Date();

  if (source === 'pdf') {
    if (!item.mediaKit) item.mediaKit = normalizeMediaKit(null, actorId);
    item.mediaKit.showToBrand = false;
    if (cleanStr(item.mediaKit.requestStatus).toLowerCase() === 'approved') {
      item.mediaKit.requestStatus = 'none';
    }
    item.mediaKit.reviewedAt = reviewedAt;
    item.mediaKit.reviewedByAdminId = actorId || null;
    return;
  }

  if (source === 'link') {
    if (!item.mediaKitLink) item.mediaKitLink = normalizeMediaKitLink(null, actorId);
    item.mediaKitLink.showToBrand = false;
    if (cleanStr(item.mediaKitLink.requestStatus).toLowerCase() === 'approved') {
      item.mediaKitLink.requestStatus = 'none';
    }
    item.mediaKitLink.reviewedAt = reviewedAt;
    item.mediaKitLink.reviewedByAdminId = actorId || null;
  }
}

async function buildSharedMediaKitAccess(item) {
  const hasAdded = hasStoredMediaKit(item?.mediaKit) || hasMediaKitLink(item?.mediaKitLink);
  const allowedSource = getVisibleMediaKitSource(item);
  const allowed = !!allowedSource;

  let url = '';

  if (allowedSource === 'pdf') {
    try {
      url = await createMediaKitReadUrl(item.mediaKit.s3Key);
    } catch (err) {
      url = '';
    }
  } else if (allowedSource === 'link') {
    url = item?.mediaKitLink?.url || '';
  }

  const requestStatus = allowed ? 'approved' : getGenericMediaKitRequestStatus(item);

  return {
    hasAdded,
    allowed,
    availableOnRequest: !allowed,
    requestStatus,
    requestedAt: getGenericMediaKitRequestedAt(item),
    buttonLabel: allowed
      ? ''
      : requestStatus === 'requested'
        ? 'Requested'
        : 'Request',
    url: allowed ? url : '',
  };
}

function getS3Bucket() {
  return cleanStr(process.env.AWS_S3_BUCKET || process.env.S3_BUCKET);
}

function getMediaKitS3Client() {
  if (s3ClientSingleton) return s3ClientSingleton;

  const region = cleanStr(process.env.AWS_REGION || process.env.S3_REGION);
  const bucket = getS3Bucket();
  const accessKeyId = cleanStr(process.env.AWS_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID);
  const secretAccessKey = cleanStr(process.env.AWS_SECRET_ACCESS_KEY || process.env.S3_SECRET_ACCESS_KEY);

  if (!region || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'S3 is not configured. Please set AWS_REGION, AWS_S3_BUCKET, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY'
    );
  }

  s3ClientSingleton = new S3Client({
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  return s3ClientSingleton;
}

function sanitizeFileName(fileName) {
  const ext = cleanStr(fileName).toLowerCase().endsWith('.pdf') ? '.pdf' : '.pdf';
  const base =
    cleanStr(fileName)
      .replace(/\.pdf$/i, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/(^-|-$)/g, '') || 'media-kit';

  return `${base}${ext}`;
}

function buildMediaKitS3Key(folderId, fileName) {
  const safeName = sanitizeFileName(fileName);
  return `pitch-folders/${folderId}/media-kits/${Date.now()}-${crypto
    .randomBytes(8)
    .toString('hex')}-${safeName}`;
}

async function createMediaKitUploadUrl({ key, contentType }) {
  const bucket = getS3Bucket();
  const client = getMediaKitS3Client();

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
  });

  return getSignedUrl(client, command, { expiresIn: 900 });
}

async function createMediaKitReadUrl(key) {
  if (!cleanStr(key)) return '';

  const bucket = getS3Bucket();
  const client = getMediaKitS3Client();

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  return getSignedUrl(client, command, { expiresIn: 3600 });
}

function normalizeMediaKitLink(input, actorId, currentMediaKitLink = null) {
  if (input === null) {
    return {
      url: '',
      generatedAt: null,
      generatedByAdminId: null,
      showToBrand: false,
      requestStatus: 'none',
      requestedAt: null,
      reviewedAt: null,
      reviewedByAdminId: null,
    };
  }

  const source = input && typeof input === 'object' ? input : {};
  const current = currentMediaKitLink || {};

  const url = cleanStr(hasOwn(source, 'url') ? source.url : current.url);

  let generatedAt = hasOwn(source, 'generatedAt') ? source.generatedAt : current.generatedAt;
  generatedAt = generatedAt ? new Date(generatedAt) : null;

  const showToBrand = hasOwn(source, 'showToBrand') ? !!source.showToBrand : !!current.showToBrand;

  let requestStatus = cleanStr(
    hasOwn(source, 'requestStatus') ? source.requestStatus : current.requestStatus
  ).toLowerCase();

  if (!MEDIA_KIT_REQUEST_STATUSES.includes(requestStatus)) {
    requestStatus = 'none';
  }

  let requestedAt = hasOwn(source, 'requestedAt') ? source.requestedAt : current.requestedAt;
  requestedAt = requestedAt ? new Date(requestedAt) : null;

  let reviewedAt = hasOwn(source, 'reviewedAt') ? source.reviewedAt : current.reviewedAt;
  reviewedAt = reviewedAt ? new Date(reviewedAt) : null;

  const reviewedByAdminId =
    hasOwn(source, 'reviewedByAdminId') && mongoose.Types.ObjectId.isValid(String(source.reviewedByAdminId))
      ? new mongoose.Types.ObjectId(String(source.reviewedByAdminId))
      : current.reviewedByAdminId || null;

  if (!url) {
    return {
      url: '',
      generatedAt: null,
      generatedByAdminId: null,
      showToBrand: false,
      requestStatus: 'none',
      requestedAt: null,
      reviewedAt: null,
      reviewedByAdminId: null,
    };
  }

  if (showToBrand) {
    requestStatus = 'approved';
    if (!reviewedAt) reviewedAt = new Date();
  }

  if (requestStatus === 'requested' && !requestedAt) {
    requestedAt = new Date();
  }

  return {
    url,
    generatedAt: generatedAt || current.generatedAt || new Date(),
    generatedByAdminId:
      actorId && mongoose.Types.ObjectId.isValid(String(actorId))
        ? new mongoose.Types.ObjectId(String(actorId))
        : current.generatedByAdminId || null,
    showToBrand,
    requestStatus,
    requestedAt,
    reviewedAt,
    reviewedByAdminId,
  };
}

function escapeRegexValue(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exactRegex(value = '') {
  const cleaned = cleanStr(value);
  return cleaned ? new RegExp(`^${escapeRegexValue(cleaned)}$`, 'i') : null;
}

function normalizeLookupUsername(value) {
  const raw = cleanStr(value).trim();

  if (!raw) return '';

  return raw
    .replace(/^@+/, '')
    .replace(/^\/+/, '')
    .split('?')[0]
    .split('#')[0]
    .split('/')[0]
    .trim();
}

function normalizeLookupHandle(value) {
  const username = normalizeLookupUsername(value);
  return username ? `@${username.toLowerCase()}` : '';
}

function extractUsernameFromProfileUrl(url, provider = '') {
  const value = cleanStr(url);

  if (!value) return '';

  const absoluteUrl = /^https?:\/\//i.test(value) ? value : `https://${value}`;

  try {
    const parsed = new URL(absoluteUrl);
    const host = parsed.hostname.toLowerCase();
    const parts = parsed.pathname
      .split('/')
      .map((part) => part.trim())
      .filter(Boolean);

    if (!parts.length) return '';

    const normalizedProvider = normalizeProvider(provider);

    if (normalizedProvider === 'instagram' || host.includes('instagram.com')) {
      return normalizeLookupUsername(parts[0]);
    }

    if (normalizedProvider === 'tiktok' || host.includes('tiktok.com')) {
      return normalizeLookupUsername(parts[0]);
    }

    if (
      normalizedProvider === 'youtube' ||
      host.includes('youtube.com') ||
      host.includes('youtu.be')
    ) {
      const atPart = parts.find((part) => part.startsWith('@'));

      if (atPart) {
        return normalizeLookupUsername(atPart);
      }

      const channelIndex = parts.findIndex((part) =>
        ['channel', 'c', 'user'].includes(part.toLowerCase())
      );

      if (channelIndex >= 0 && parts[channelIndex + 1]) {
        return cleanStr(parts[channelIndex + 1]);
      }

      return normalizeLookupUsername(parts[0]);
    }

    return normalizeLookupUsername(parts[0]);
  } catch {
    return '';
  }
}

function getProviderUsernameLookupCandidates(source = {}) {
  const provider = normalizeProvider(source.provider || source.platform);

  const primaryLink = cleanStr(source.primaryLink || source.url || source.profileUrl || source.link);

  const rawLinks = Array.isArray(source.links)
    ? source.links
    : primaryLink
      ? [primaryLink]
      : [];

  const usernameCandidates = uniqStrings([
    normalizeLookupUsername(source.username),
    normalizeLookupUsername(source.handle),
    normalizeLookupUsername(source.handleId),
    normalizeLookupUsername(source.channelHandle),
    extractUsernameFromProfileUrl(primaryLink, provider),
    ...rawLinks.map((link) => extractUsernameFromProfileUrl(link, provider)),
  ]).filter(Boolean);

  const handleCandidates = uniqStrings(
    usernameCandidates.map((username) => normalizeLookupHandle(username))
  ).filter(Boolean);

  const idCandidates = uniqStrings([
    cleanStr(source.channelId),
    cleanStr(source.userId),
    cleanStr(source.sourceRefId),
    cleanStr(source.modashUserId),
  ]).filter(Boolean);

  const emailCandidates = uniqStrings([
    cleanStr(source.email).toLowerCase(),
    cleanStr(source.proxyEmail).toLowerCase(),
  ]).filter(Boolean);

  return {
    provider,
    usernameCandidates,
    handleCandidates,
    idCandidates,
    emailCandidates,
  };
}

function namedRefNames(values = []) {
  if (!Array.isArray(values)) return [];

  return uniqStrings(
    values
      .map((item) => {
        if (typeof item === 'string') return item;
        return item?.name || item?.title || item?.label || '';
      })
      .filter(Boolean)
  );
}

function getSignedUpInfluencerEmail(influencer = {}) {
  if (!influencer || typeof influencer !== 'object') return '';

  return cleanStr(
    influencer.email ||
    influencer.proxyEmail ||
    influencer.emailTo ||
    ''
  ).toLowerCase();
}

function getEmailFromInfluencerProfile(profile = {}) {
  if (!profile || typeof profile !== 'object') return '';

  return cleanStr(
    profile.email ||
    profile.businessEmail ||
    profile.contactEmail ||
    profile.publicEmail ||
    profile.profileEmail ||
    profile.emailTo ||
    ''
  ).toLowerCase();
}

function buildPageIdentityOr({ usernameCandidates = [], handleCandidates = [], idCandidates = [] }) {
  const identityOr = [];

  for (const username of usernameCandidates) {
    const rx = exactRegex(username);
    if (!rx) continue;

    identityOr.push({ username: rx });
    identityOr.push({ handle: rx });
    identityOr.push({ channelHandle: rx });
  }

  for (const handle of handleCandidates) {
    const rx = exactRegex(handle);
    if (!rx) continue;

    identityOr.push({ handle: rx });
    identityOr.push({ channelHandle: rx });
  }

  for (const id of idCandidates) {
    const rx = exactRegex(id);
    if (!rx) continue;

    identityOr.push({ channelId: rx });
    identityOr.push({ userId: rx });
    identityOr.push({ sourceRefId: rx });
    identityOr.push({ modashUserId: rx });
  }

  return identityOr;
}

function buildSignedUpInfluencerLookupQuery(source = {}) {
  const {
    provider,
    usernameCandidates,
    handleCandidates,
    idCandidates,
    emailCandidates,
  } = getProviderUsernameLookupCandidates(source);

  const or = [];

  for (const email of emailCandidates) {
    const rx = exactRegex(email);
    if (!rx) continue;

    or.push({ email: rx });
    or.push({ proxyEmail: rx });
  }

  const identityOr = buildPageIdentityOr({
    usernameCandidates,
    handleCandidates,
    idCandidates,
  });

  if (identityOr.length) {
    const pagePlatformOr = [
      { platform: provider },
      { provider },
    ];

    for (const pageField of ['page1', 'page2', 'page3']) {
      or.push({
        [pageField]: {
          $elemMatch: {
            $and: [
              { $or: pagePlatformOr },
              { $or: identityOr },
            ],
          },
        },
      });

      or.push({
        $and: [
          { primaryPlatform: provider },
          {
            [pageField]: {
              $elemMatch: {
                $or: identityOr,
              },
            },
          },
        ],
      });
    }
  }

  if (!or.length) return null;

  return { $or: or };
}

async function findSignedUpInfluencerForSource(source = {}) {
  const query = buildSignedUpInfluencerLookupQuery(source);

  if (!query) return null;

  return InfluencerModel.findOne(query)
    .select(
      '_id name email proxyEmail countryName country location categories languages primaryPlatform page1 page2 page3 isAdminCreated signupCompleted'
    )
    .lean();
}

async function findSavedInfluencerProfileEmail(source = {}) {
  const { provider, usernameCandidates, handleCandidates, idCandidates } =
    getProviderUsernameLookupCandidates(source);

  const lookupOr = [];

  for (const username of usernameCandidates) {
    const rx = exactRegex(username);
    if (!rx) continue;

    lookupOr.push({ username: rx });
    lookupOr.push({ handle: rx });
  }

  for (const handle of handleCandidates) {
    const rx = exactRegex(handle);
    if (!rx) continue;

    lookupOr.push({ handle: rx });
  }

  for (const id of idCandidates) {
    const rx = exactRegex(id);
    if (!rx) continue;

    lookupOr.push({ channelId: rx });
    lookupOr.push({ userId: rx });
    lookupOr.push({ sourceRefId: rx });
    lookupOr.push({ modashUserId: rx });
  }

  if (!lookupOr.length) return '';

  const profile = await InfluencerProfile.findOne({
    $and: [
      {
        $or: [
          { platform: provider },
          { provider },
        ],
      },
      {
        $or: lookupOr,
      },
    ],
  })
    .select(
      'platform provider username handle channelId userId sourceRefId modashUserId email businessEmail contactEmail publicEmail profileEmail emailTo'
    )
    .lean();

  if (!profile) return '';

  return getEmailFromInfluencerProfile(profile);
}

async function enrichPitchFolderItemBodyWithProfileEmail(body = {}, fallback = {}) {
  const source = {
    ...fallback,
    ...body,
  };

  const existingEmail = cleanStr(
    hasOwn(body, 'email') ? body.email : fallback.email
  ).toLowerCase();

  const signedUpInfluencer = await findSignedUpInfluencerForSource({
    ...source,
    email: existingEmail || source.email,
  });

  const signedUpEmail = getSignedUpInfluencerEmail(signedUpInfluencer);

  const profileEmail =
    !existingEmail && !signedUpEmail
      ? await findSavedInfluencerProfileEmail(source)
      : '';

  const resolvedEmail = existingEmail || signedUpEmail || profileEmail || '';

  const nextBody = {
    ...body,
    email: resolvedEmail,
  };

  if (signedUpInfluencer?._id) {
    if (!cleanStr(nextBody.name)) {
      nextBody.name = cleanStr(signedUpInfluencer.name);
    }

    if (!cleanStr(nextBody.country)) {
      nextBody.country = cleanStr(
        signedUpInfluencer.countryName ||
        signedUpInfluencer.country ||
        signedUpInfluencer.location
      );
    }

    const existingNiche = Array.isArray(nextBody.niche)
      ? nextBody.niche
      : uniqStrings(String(nextBody.niche || '').split(','));

    if (!existingNiche.length) {
      nextBody.niche = namedRefNames(signedUpInfluencer.categories);
    }

    if (!cleanStr(nextBody.provider)) {
      nextBody.provider = normalizeProvider(signedUpInfluencer.primaryPlatform);
    }

    nextBody.signedUpInfluencerId = String(signedUpInfluencer._id);
    nextBody.isSignedUpInfluencer = true;
  }

  return nextBody;
}


function compactAiText(value, maxLength = 1200) {
  const text = cleanStr(value).replace(/\s+/g, ' ');
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function formatSelectionReasonArray(value) {
  if (Array.isArray(value)) return uniqStrings(value).join(', ');
  return uniqStrings(String(value || '').split(',')).join(', ');
}

function buildSelectionReasonContext(body = {}) {
  const assignedCampaign = body.assignedCampaign || {};
  const campaignActivation = body.campaignActivation || {};
  const mediaKitAccess = body.mediaKitAccess || {};

  return {
    provider: normalizeProvider(body.provider || body.platform),
    name: cleanStr(body.name),
    handle: cleanStr(body.handle || body.username || body.channelHandle),
    followers: toNullableNumber(body.followers),
    niche: formatSelectionReasonArray(body.niche || body.categories),
    country: cleanStr(body.country || body.countryName),
    email: cleanStr(body.email).toLowerCase(),
    profileLink: cleanStr(body.profileLink || body.primaryLink || body.url || body.link),
    profileLinks: Array.isArray(body.links) ? uniqStrings(body.links).join(', ') : cleanStr(body.links),
    currentSelectionReason: compactAiText(body.currentSelectionReason || body.selectionReason, 1200),
    goodFit: body.goodFit === true,
    influencerRateCard: compactAiText(body.influencerRateCard, 1600),
    platformRateCard: compactAiText(body.platformRateCard, 1600),
    rateCardCurrency: cleanStr(body.rateCardCurrency || 'USD').toUpperCase(),
    ourFeePct: toNullableNumber(body.ourFeePct),
    shippingAddress: compactAiText(body.shippingAddress || body.comments, 900),
    mediaKitStatus: cleanStr(mediaKitAccess.requestStatus || body.mediaKitStatus),
    mediaKitVisibleSource: cleanStr(mediaKitAccess.visibleSource || body.mediaKitVisibleSource),
    hasMediaKit: body.hasMediaKit === true || mediaKitAccess.hasAdded === true,
    folderId: cleanStr(body.folderId),
    itemId: cleanStr(body.itemId),
    folderTitle: cleanStr(body.folderTitle),
    folderDescription: compactAiText(body.folderDescription, 800),
    campaignTitle: cleanStr(assignedCampaign.campaignTitle || body.campaignTitle),
    campaignId: cleanStr(assignedCampaign.campaignId || body.campaignId),
    brandName: cleanStr(assignedCampaign.brandName || body.brandName),
    productOrServiceName: cleanStr(
      assignedCampaign.productOrServiceName || body.productOrServiceName
    ),
    campaignActive: campaignActivation.active === true,
    campaignInvitationStatus: cleanStr(body.campaignInvitationStatus),
    influencerSource: cleanStr(body.influencerSource),
  };
}

function hasEnoughSelectionReasonContext(ctx = {}) {
  return !!(
    ctx.name ||
    ctx.handle ||
    ctx.profileLink ||
    ctx.niche ||
    ctx.followers ||
    ctx.country ||
    ctx.influencerRateCard ||
    ctx.platformRateCard ||
    ctx.campaignTitle ||
    ctx.productOrServiceName
  );
}

function buildFallbackSelectionReason(ctx = {}) {
  const creatorLabel = ctx.name || ctx.handle || 'This creator';
  const parts = [];

  if (ctx.niche) parts.push(`content focus in ${ctx.niche}`);
  if (ctx.followers) parts.push(`${Number(ctx.followers).toLocaleString('en-IN')} followers`);
  if (ctx.country) parts.push(`country/audience relevance in ${ctx.country}`);
  if (ctx.campaignTitle) parts.push(`alignment with ${ctx.campaignTitle}`);
  if (ctx.productOrServiceName) parts.push(`relevance to ${ctx.productOrServiceName}`);
  if (ctx.influencerRateCard || ctx.platformRateCard) parts.push('available rate-card context for commercial planning');
  if (ctx.goodFit) parts.push('already marked as a Good Fit in the pitch folder');

  const supportText = parts.length ? parts.join(', ') : 'profile relevance, creator context, and campaign suitability';

  return `${creatorLabel} is a strong campaign prospect based on ${supportText}. This profile gives the brand a useful creator option for outreach because the available information supports category relevance, collaboration readiness, and a clear basis for evaluating fit against the assigned campaign.`;
}

async function generateSelectionReasonWithAI(ctx = {}) {
  const apiKey = cleanStr(process.env.OPENAI_API_KEY);
  const model = cleanStr(process.env.OPENAI_SELECTION_REASON_MODEL || process.env.OPENAI_MODEL) || 'gpt-4o-mini';

  if (!apiKey || typeof fetch !== 'function') {
    return {
      source: 'fallback',
      selectionReason: buildFallbackSelectionReason(ctx),
    };
  }

  const prompt = [
    'Generate the strongest possible editable selection reason for a pitch folder influencer row.',
    'Write in a professional brand-pitch tone for an internal influencer shortlist.',
    'Use the maximum useful detail from the provided facts, but do not invent audience demographics, performance metrics, pricing, locations, or claims.',
    'Mention campaign/product relevance when available, creator/category fit, reach/followers when available, geography when useful, and collaboration readiness if rate-card or media-kit information exists.',
    'If an existing selection reason is provided, improve and expand it instead of ignoring it.',
    'Keep it detailed but practical: 90 to 150 words. Return only the final selection reason text, no bullets and no heading.',
    '',
    `Existing reason to improve: ${ctx.currentSelectionReason || 'Not provided'}`,
    `Creator name: ${ctx.name || 'Not provided'}`,
    `Provider: ${ctx.provider || 'Not provided'}`,
    `Handle: ${ctx.handle || 'Not provided'}`,
    `Followers: ${ctx.followers ?? 'Not provided'}`,
    `Niche/categories: ${ctx.niche || 'Not provided'}`,
    `Country: ${ctx.country || 'Not provided'}`,
    `Email present: ${ctx.email ? 'Yes' : 'No'}`,
    `Profile link: ${ctx.profileLink || 'Not provided'}`,
    `Other profile links: ${ctx.profileLinks || 'Not provided'}`,
    `Influencer rate card: ${ctx.influencerRateCard || 'Not provided'}`,
    `Platform/admin rate card: ${ctx.platformRateCard || 'Not provided'}`,
    `Rate card currency: ${ctx.rateCardCurrency || 'Not provided'}`,
    `Our fee percentage: ${ctx.ourFeePct ?? 'Not provided'}`,
    `Shipping/address notes: ${ctx.shippingAddress || 'Not provided'}`,
    `Media kit status: ${ctx.mediaKitStatus || 'Not provided'}`,
    `Media kit visible source: ${ctx.mediaKitVisibleSource || 'Not provided'}`,
    `Good Fit marked: ${ctx.goodFit ? 'Yes' : 'No'}`,
    `Influencer source: ${ctx.influencerSource || 'Not provided'}`,
    `Campaign invitation status: ${ctx.campaignInvitationStatus || 'Not provided'}`,
    `Already active on assigned campaign: ${ctx.campaignActive ? 'Yes' : 'No'}`,
    `Pitch folder: ${ctx.folderTitle || 'Not provided'}`,
    `Pitch folder description: ${ctx.folderDescription || 'Not provided'}`,
    `Campaign: ${ctx.campaignTitle || 'Not provided'}`,
    `Campaign ID: ${ctx.campaignId || 'Not provided'}`,
    `Brand: ${ctx.brandName || 'Not provided'}`,
    `Product/service: ${ctx.productOrServiceName || 'Not provided'}`,
  ].join('\n');

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.5,
      max_tokens: 320,
      messages: [
        {
          role: 'system',
          content:
            'You write concise influencer marketing selection reasons for internal pitch folders.',
        },
        { role: 'user', content: prompt },
      ],
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data?.error?.message || 'OpenAI selection reason generation failed';
    throw new Error(message);
  }

  const selectionReason = cleanStr(data?.choices?.[0]?.message?.content);

  return {
    source: 'openai',
    selectionReason: selectionReason || buildFallbackSelectionReason(ctx),
  };
}
function normalizeMediaKit(input, actorId, currentMediaKit = null) {
  if (input === null) {
    return {
      s3Key: '',
      fileName: '',
      mimeType: 'application/pdf',
      size: null,
      uploadedAt: null,
      uploadedByAdminId: null,
      showToBrand: false,
      requestStatus: 'none',
      requestedAt: null,
      reviewedAt: null,
      reviewedByAdminId: null,
    };
  }

  const source = input && typeof input === 'object' ? input : {};
  const current = currentMediaKit || {};

  const s3Key = cleanStr(hasOwn(source, 's3Key') ? source.s3Key : current.s3Key);
  const fileName = cleanStr(hasOwn(source, 'fileName') ? source.fileName : current.fileName);
  const mimeType = cleanStr(hasOwn(source, 'mimeType') ? source.mimeType : current.mimeType) || 'application/pdf';
  const size = hasOwn(source, 'size') ? toNullableNumber(source.size) : toNullableNumber(current.size);

  let uploadedAt = hasOwn(source, 'uploadedAt') ? source.uploadedAt : current.uploadedAt;
  uploadedAt = uploadedAt ? new Date(uploadedAt) : null;

  const showToBrand = hasOwn(source, 'showToBrand') ? !!source.showToBrand : !!current.showToBrand;

  let requestStatus = cleanStr(
    hasOwn(source, 'requestStatus') ? source.requestStatus : current.requestStatus
  ).toLowerCase();

  if (!MEDIA_KIT_REQUEST_STATUSES.includes(requestStatus)) {
    requestStatus = 'none';
  }

  let requestedAt = hasOwn(source, 'requestedAt') ? source.requestedAt : current.requestedAt;
  requestedAt = requestedAt ? new Date(requestedAt) : null;

  let reviewedAt = hasOwn(source, 'reviewedAt') ? source.reviewedAt : current.reviewedAt;
  reviewedAt = reviewedAt ? new Date(reviewedAt) : null;

  const reviewedByAdminId =
    hasOwn(source, 'reviewedByAdminId') && mongoose.Types.ObjectId.isValid(String(source.reviewedByAdminId))
      ? new mongoose.Types.ObjectId(String(source.reviewedByAdminId))
      : current.reviewedByAdminId || null;

  if (!s3Key) {
    return {
      s3Key: '',
      fileName: '',
      mimeType: 'application/pdf',
      size: null,
      uploadedAt: null,
      uploadedByAdminId: null,
      showToBrand: false,
      requestStatus: 'none',
      requestedAt: null,
      reviewedAt: null,
      reviewedByAdminId: null,
    };
  }

  if (showToBrand) {
    requestStatus = 'approved';
    if (!reviewedAt) reviewedAt = new Date();
  }

  if (requestStatus === 'requested' && !requestedAt) {
    requestedAt = new Date();
  }

  return {
    s3Key,
    fileName: fileName || 'media-kit.pdf',
    mimeType: mimeType || 'application/pdf',
    size,
    uploadedAt: uploadedAt || new Date(),
    uploadedByAdminId:
      actorId && mongoose.Types.ObjectId.isValid(String(actorId))
        ? new mongoose.Types.ObjectId(String(actorId))
        : current.uploadedByAdminId || null,
    showToBrand,
    requestStatus,
    requestedAt,
    reviewedAt,
    reviewedByAdminId,
  };
}

function pushRateCardHistory(item, field, previousValue, newValue, actorId) {
  const prev = cleanStr(previousValue);
  const next = cleanStr(newValue);

  if (prev === next) return;

  if (!Array.isArray(item.rateCardHistory)) {
    item.rateCardHistory = [];
  }

  item.rateCardHistory.push({
    field,
    previousValue: prev,
    newValue: next,
    changedAt: new Date(),
    changedByAdminId:
      actorId && mongoose.Types.ObjectId.isValid(String(actorId))
        ? new mongoose.Types.ObjectId(String(actorId))
        : null,
  });
}

function normalizeItem(body = {}, actorId = null) {
  const links = Array.isArray(body.links)
    ? uniqStrings(body.links)
    : uniqStrings(String(body.links || '').split(','));

  const primaryLink = cleanStr(body.primaryLink) || (links.length ? links[0] : '');

  const niche = Array.isArray(body.niche)
    ? uniqStrings(body.niche)
    : uniqStrings(String(body.niche || '').split(','));

  const item = {
    provider: normalizeProvider(body.provider),
    name: cleanStr(body.name),
    handle: cleanStr(body.handle).replace(/^@+/, '@'),
    followers: toNullableNumber(body.followers),
    primaryLink,
    links,
    niche,
    email: cleanStr(body.email).toLowerCase(),
    country: cleanStr(body.country),
    selectionReason: cleanStr(body.selectionReason),
    goodFit: !!body.goodFit,
    influencerRateCard: cleanStr(body.influencerRateCard),
    platformRateCard: cleanStr(body.platformRateCard),
    rateCardCurrency: cleanStr(body.rateCardCurrency || 'USD').toUpperCase(),
    rateCardHistory: [],
    ourFeePct: toNullableNumber(body.ourFeePct),
    shippingAddress: getPreferredShippingAddress(body),
    mediaKit: normalizeMediaKit(body.mediaKit, actorId),
    mediaKitLink: normalizeMediaKitLink(body.mediaKitLink, actorId),
    sourcePipelineId:
      body.sourcePipelineId && mongoose.Types.ObjectId.isValid(String(body.sourcePipelineId))
        ? new mongoose.Types.ObjectId(String(body.sourcePipelineId))
        : null,
    updatedByAdmin: actorId || null,
  };

  ensureGenericRequestConsistency(item);
  return item;
}

function applyItemMutations(item, body = {}, actorId = null) {
  if (hasOwn(body, 'provider')) item.provider = normalizeProvider(body.provider);
  if (hasOwn(body, 'name')) item.name = cleanStr(body.name);
  if (hasOwn(body, 'handle')) item.handle = cleanStr(body.handle).replace(/^@+/, '@');
  if (hasOwn(body, 'followers')) item.followers = toNullableNumber(body.followers);

  if (hasOwn(body, 'links')) {
    item.links = Array.isArray(body.links)
      ? uniqStrings(body.links)
      : uniqStrings(String(body.links || '').split(','));
  }

  if (hasOwn(body, 'primaryLink')) {
    item.primaryLink = cleanStr(body.primaryLink);
  } else if (hasOwn(body, 'links') && !cleanStr(item.primaryLink) && item.links.length) {
    item.primaryLink = item.links[0];
  }

  if (hasOwn(body, 'niche')) {
    item.niche = Array.isArray(body.niche)
      ? uniqStrings(body.niche)
      : uniqStrings(String(body.niche || '').split(','));
  }

  if (hasOwn(body, 'email')) item.email = cleanStr(body.email).toLowerCase();
  if (hasOwn(body, 'country')) item.country = cleanStr(body.country);
  if (hasOwn(body, 'selectionReason')) item.selectionReason = cleanStr(body.selectionReason);
  if (hasOwn(body, 'goodFit')) item.goodFit = !!body.goodFit;

  if (hasOwn(body, 'influencerRateCard')) {
    const next = cleanStr(body.influencerRateCard);
    pushRateCardHistory(item, 'influencerRateCard', item.influencerRateCard, next, actorId);
    item.influencerRateCard = next;
  }

  if (hasOwn(body, 'platformRateCard')) {
    const next = cleanStr(body.platformRateCard);
    pushRateCardHistory(item, 'platformRateCard', item.platformRateCard, next, actorId);
    item.platformRateCard = next;
  }

  if (hasOwn(body, 'rateCardCurrency')) {
    item.rateCardCurrency = cleanStr(body.rateCardCurrency || 'USD').toUpperCase();
  }

  if (hasOwn(body, 'ourFeePct')) item.ourFeePct = toNullableNumber(body.ourFeePct);

  if (hasOwn(body, 'shippingAddress') || hasOwn(body, 'comments')) {
    item.shippingAddress = getPreferredShippingAddress({
      shippingAddress: hasOwn(body, 'shippingAddress')
        ? body.shippingAddress
        : item.shippingAddress,
      comments: hasOwn(body, 'comments')
        ? body.comments
        : item.comments,
    });
  }

  if (hasOwn(body, 'sourcePipelineId')) {
    item.sourcePipelineId =
      body.sourcePipelineId && mongoose.Types.ObjectId.isValid(String(body.sourcePipelineId))
        ? new mongoose.Types.ObjectId(String(body.sourcePipelineId))
        : null;
  }

  if (hasOwn(body, 'mediaKit')) {
    item.mediaKit = normalizeMediaKit(body.mediaKit, actorId, item.mediaKit || null);
  }

  if (hasOwn(body, 'mediaKitLink')) {
    item.mediaKitLink = normalizeMediaKitLink(body.mediaKitLink, actorId, item.mediaKitLink || null);
  }

  if (hasOwn(body, 'removeMediaKit') && !!body.removeMediaKit) {
    item.mediaKit = normalizeMediaKit(null, actorId);
  }

  if (hasOwn(body, 'removeMediaKitLink') && !!body.removeMediaKitLink) {
    item.mediaKitLink = normalizeMediaKitLink(null, actorId);
  }

  const preferredSource =
    hasOwn(body, 'mediaKitLink') && body?.mediaKitLink?.showToBrand
      ? 'link'
      : hasOwn(body, 'mediaKit') && body?.mediaKit?.showToBrand
        ? 'pdf'
        : '';

  ensureSingleSharedMediaKit(item, preferredSource);
  ensureGenericRequestConsistency(item);

  item.updatedByAdmin = actorId || null;
}

function getShareBaseUrl() {
  return process.env.PITCH_FOLDER_SHARE_BASE_URL || 'https://collabglam.com/pitch-folder/shared';
}

function buildCreatorPopulate() {
  return {
    path: 'createdByAdmin',
    select: 'name email proxyEmail role teamType status parentAdmin rootAdmin createdBy',
    populate: [
      { path: 'parentAdmin', select: 'name email role teamType' },
      { path: 'rootAdmin', select: 'name email role teamType' },
      { path: 'createdBy', select: 'name email role teamType' },
    ],
  };
}

function buildUpdatedByPopulate() {
  return {
    path: 'updatedByAdmin',
    select: 'name email proxyEmail role teamType status parentAdmin rootAdmin createdBy',
    populate: [
      { path: 'parentAdmin', select: 'name email role teamType' },
      { path: 'rootAdmin', select: 'name email role teamType' },
      { path: 'createdBy', select: 'name email role teamType' },
    ],
  };
}

function buildSharedByPopulate() {
  return {
    path: 'share.sharedByAdminId',
    select: 'name email role teamType',
  };
}

function serializeMiniAdmin(admin) {
  if (!admin) return null;

  return {
    _id: String(admin._id),
    adminId: String(admin._id),
    name: admin.name || '',
    email: admin.email || '',
    role: cleanStr(admin.role).toLowerCase(),
    designation: toDesignation(admin.role),
    teamType: admin.teamType || null,
  };
}

function serializeAdmin(admin) {
  if (!admin) return null;

  return {
    _id: String(admin._id),
    adminId: String(admin._id),
    name: admin.name || '',
    email: admin.email || '',
    proxyEmail: admin.proxyEmail || '',
    role: cleanStr(admin.role).toLowerCase(),
    designation: toDesignation(admin.role),
    teamType: admin.teamType || null,
    status: cleanStr(admin.status).toLowerCase(),
    parentAdmin: serializeMiniAdmin(admin.parentAdmin),
    rootAdmin: serializeMiniAdmin(admin.rootAdmin),
    createdBy: serializeMiniAdmin(admin.createdBy),
  };
}


function hasAssignedCampaign(doc) {
  return !!doc?.assignedCampaign?.campaignId;
}

function buildAssignedCampaignPayload(campaign, actorId = null) {
  return {
    campaignId: campaign?._id || null,
    campaignsId: cleanStr(campaign?.campaignsId),
    campaignTitle: cleanStr(campaign?.campaignTitle),
    productOrServiceName: cleanStr(campaign?.productOrServiceName),
    brandId: campaign?.brandId || null,
    brandName: cleanStr(campaign?.brandName),
    assignedAt: new Date(),
    assignedByAdminId:
      actorId && mongoose.Types.ObjectId.isValid(String(actorId))
        ? new mongoose.Types.ObjectId(String(actorId))
        : null,
  };
}

function serializeAssignedCampaign(assignedCampaign) {
  if (!assignedCampaign?.campaignId) return null;

  const rawCampaignId = assignedCampaign.campaignId;
  const campaignId = rawCampaignId?._id ? rawCampaignId._id : rawCampaignId;

  return {
    campaignId: String(campaignId),
    campaignsId: assignedCampaign.campaignsId || '',
    campaignTitle: assignedCampaign.campaignTitle || '',
    productOrServiceName: assignedCampaign.productOrServiceName || '',
    brandId: assignedCampaign.brandId || null,
    brandName: assignedCampaign.brandName || '',
    assignedAt: assignedCampaign.assignedAt || null,
    assignedByAdminId: assignedCampaign.assignedByAdminId
      ? String(assignedCampaign.assignedByAdminId)
      : null,
  };
}

function getLegacyComments(source = {}) {
  if (!source) return '';

  const directComments = cleanStr(source.comments);
  if (directComments) return directComments;

  const docComments = cleanStr(source?._doc?.comments);
  if (docComments) return docComments;

  if (typeof source.get === 'function') {
    try {
      const getterComments = cleanStr(source.get('comments'));
      if (getterComments) return getterComments;
    } catch (err) {
      // ignore
    }
  }

  if (typeof source.toObject === 'function') {
    try {
      const obj = source.toObject({ virtuals: false, getters: false });
      const objectComments = cleanStr(obj?.comments);
      if (objectComments) return objectComments;
    } catch (err) {
      // ignore
    }
  }

  return '';
}

function getPreferredShippingAddress(source = {}) {
  const shippingAddress = cleanStr(source?.shippingAddress);
  if (shippingAddress) return shippingAddress;

  return getLegacyComments(source);
}

function buildFolderItemDedupeKey(source = {}) {
  const provider = normalizeProvider(source?.provider);

  const handle = cleanStr(source?.handle).replace(/^@+/, '').toLowerCase();
  if (handle) return `${provider}:handle:${handle}`;

  const primaryLink = cleanStr(
    source?.primaryLink ||
    (Array.isArray(source?.links) && source.links.length ? source.links[0] : '')
  ).toLowerCase();
  if (primaryLink) return `${provider}:link:${primaryLink}`;

  const email = cleanStr(source?.email).toLowerCase();
  if (email) return `${provider}:email:${email}`;

  return '';
}

function folderHasDuplicateItem(folder, candidate, excludeItemId = null) {
  const candidateKey = buildFolderItemDedupeKey(candidate);
  if (!candidateKey || !Array.isArray(folder?.items)) return false;

  return folder.items.some((item) => {
    if (excludeItemId && String(item?._id) === String(excludeItemId)) {
      return false;
    }
    return buildFolderItemDedupeKey(item) === candidateKey;
  });
}

function applyFolderSearch(filter, q) {
  if (!q) return filter;

  const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

  return {
    ...filter,
    $or: [{ title: rx }, { description: rx }, { slug: rx }, { 'items.name': rx }, { 'items.handle': rx }, { 'items.email': rx }],
  };
}

async function getAccessibleCreatorIds(actor) {
  if (!canCreateOrManagePitchFolders(actor)) return [];

  const actorId = getActorAdminId(actor);
  if (!actorId || !mongoose.Types.ObjectId.isValid(String(actorId))) return [];

  const actorObjectId = new mongoose.Types.ObjectId(String(actorId));

  if (isSuperAdmin(actor)) {
    const admins = await AdminModel.find({
      role: { $in: [ROLES.SUPER_ADMIN, ROLES.REVENUE_HEAD, ROLES.IME] },
      status: 'active',
    })
      .select('_id')
      .lean();

    return admins.map((a) => a._id);
  }

  if (isRevenueHead(actor)) {
    const imeAdmins = await AdminModel.find({
      role: ROLES.IME,
      status: 'active',
      parentAdmin: actorObjectId,
    })
      .select('_id')
      .lean();

    return [actorObjectId, ...imeAdmins.map((a) => a._id)];
  }

  if (isIme(actor)) {
    return [actorObjectId];
  }

  return [];
}

async function buildFolderAccessFilter(actor) {
  if (!canCreateOrManagePitchFolders(actor)) return null;

  if (isSuperAdmin(actor)) {
    return { archivedAt: null };
  }

  const creatorIds = await getAccessibleCreatorIds(actor);

  return {
    archivedAt: null,
    createdByAdmin: { $in: creatorIds },
  };
}

async function findAccessibleFolder(folderId, actor) {
  const scope = await buildFolderAccessFilter(actor);
  if (!scope) return null;

  return PitchFolder.findOne({
    _id: folderId,
    ...scope,
  })
    .populate(buildCreatorPopulate())
    .populate(buildUpdatedByPopulate())
    .populate(buildSharedByPopulate())
    .exec();
}

function serializeCampaignActivation(campaignActivation) {
  if (!campaignActivation?.campaignId && !campaignActivation?.activeAt) return null;

  const rawCampaignId = campaignActivation?.campaignId;
  const campaignId = rawCampaignId?._id ? rawCampaignId._id : rawCampaignId;
  const rawInfluencerId = campaignActivation?.influencerId;
  const influencerId = rawInfluencerId?._id ? rawInfluencerId._id : rawInfluencerId;

  return {
    active: !!campaignActivation?.activeAt,
    campaignId: campaignId ? String(campaignId) : null,
    campaignsId: campaignActivation?.campaignsId || '',
    influencerId: influencerId ? String(influencerId) : null,
    activeAt: campaignActivation?.activeAt || null,
    activatedByAdminId: campaignActivation?.activatedByAdminId
      ? String(campaignActivation.activatedByAdminId)
      : null,
  };
}

function getAssignedCampaignIdString(assignedCampaign = {}) {
  const rawCampaignId = assignedCampaign?.campaignId;
  const campaignId = rawCampaignId?._id ? rawCampaignId._id : rawCampaignId;
  return campaignId ? String(campaignId) : '';
}

function isActiveCampaignApplicant(applicant = {}) {
  if (Number(applicant?.isActive || 0) === 1) return true;

  return [
    applicant?.statusBrand,
    applicant?.statusInfluencer,
    applicant?.brandStatus,
    applicant?.influencerStatus,
    applicant?.lifecycleStatus,
  ]
    .filter(Boolean)
    .map((value) => cleanStr(value).toLowerCase())
    .includes('active');
}

async function getActiveApplicantMapForAssignedCampaign(folderDoc) {
  const assignedCampaign = folderDoc?.assignedCampaign || {};
  const campaignId = getAssignedCampaignIdString(assignedCampaign);

  if (!campaignId) return new Map();

  const applyRecord = await ApplyCampaign.findOne({ campaignId })
    .select('applicants')
    .lean();

  const activeMap = new Map();

  for (const applicant of applyRecord?.applicants || []) {
    if (!isActiveCampaignApplicant(applicant)) continue;

    const itemId = cleanStr(applicant?.pitchFolderItemId);
    if (!itemId) continue;

    activeMap.set(itemId, {
      active: true,
      campaignId,
      campaignsId: assignedCampaign?.campaignsId || '',
      influencerId: cleanStr(applicant?.influencerId) || null,
      activeAt: applicant?.activeAt || applicant?.appliedAt || null,
      activatedByAdminId: applicant?.assignedByAdminId || null,
    });
  }

  return activeMap;
}

async function serializeFolderDetailWithCampaignState(doc) {
  const base = serializeFolderDetail(doc);
  const activeMap = await getActiveApplicantMapForAssignedCampaign(doc);
  const assignedCampaignId = base?.assignedCampaign?.campaignId || '';

  base.items = (base.items || []).map((item) => {
    const activeFromApply = activeMap.get(String(item._id));

    if (activeFromApply) {
      return {
        ...item,
        campaignActivation: activeFromApply,
      };
    }

    const existing = item.campaignActivation;
    const existingCampaignId = existing?.campaignId ? String(existing.campaignId) : '';
    const isSameAssignedCampaign =
      !!existingCampaignId && !!assignedCampaignId && existingCampaignId === String(assignedCampaignId);

    return {
      ...item,
      campaignActivation:
        existing && isSameAssignedCampaign
          ? {
            ...existing,
            active: !!existing.activeAt,
          }
          : null,
    };
  });

  return base;
}

function serializeFolderItemForAdmin(item) {
  const resolvedShippingAddress = getPreferredShippingAddress(item);

  return {
    _id: item._id,
    provider: item.provider,
    name: item.name,
    handle: item.handle,
    followers: item.followers,
    primaryLink: item.primaryLink,
    links: item.links || [],
    niche: item.niche || [],
    email: item.email,
    country: item.country,
    selectionReason: item.selectionReason,
    goodFit: item.goodFit,
    influencerRateCard: item.influencerRateCard || '',
    platformRateCard: item.platformRateCard || '',
    rateCardCurrency: item.rateCardCurrency || 'USD',
    ourFeePct: item.ourFeePct,

    // main new field
    shippingAddress: resolvedShippingAddress,

    // keep legacy frontend compatibility
    comments: resolvedShippingAddress,

    mediaKitAccess: {
      hasAdded: hasStoredMediaKit(item.mediaKit) || hasMediaKitLink(item.mediaKitLink),
      allowed: !!getVisibleMediaKitSource(item),
      visibleSource: getVisibleMediaKitSource(item) || null,
      requestStatus: getGenericMediaKitRequestStatus(item),
      requestedAt: getGenericMediaKitRequestedAt(item),
    },

    mediaKitLink: item.mediaKitLink
      ? {
        url: item.mediaKitLink.url || '',
        generatedAt: item.mediaKitLink.generatedAt || null,
        showToBrand: !!item.mediaKitLink.showToBrand,
        requestStatus: item.mediaKitLink.requestStatus || 'none',
        requestedAt: item.mediaKitLink.requestedAt || null,
        reviewedAt: item.mediaKitLink.reviewedAt || null,
      }
      : null,

    mediaKit: item.mediaKit
      ? {
        s3Key: item.mediaKit.s3Key || '',
        fileName: item.mediaKit.fileName || '',
        mimeType: item.mediaKit.mimeType || 'application/pdf',
        size: item.mediaKit.size,
        uploadedAt: item.mediaKit.uploadedAt || null,
        showToBrand: !!item.mediaKit.showToBrand,
        requestStatus: item.mediaKit.requestStatus || 'none',
        requestedAt: item.mediaKit.requestedAt || null,
        reviewedAt: item.mediaKit.reviewedAt || null,
      }
      : null,

    campaignActivation: serializeCampaignActivation(item.campaignActivation),

    rateCardHistory: Array.isArray(item.rateCardHistory)
      ? item.rateCardHistory
        .slice()
        .sort((a, b) => new Date(b.changedAt).getTime() - new Date(a.changedAt).getTime())
        .map((entry) => ({
          _id: entry._id,
          field: entry.field,
          previousValue: entry.previousValue || '',
          newValue: entry.newValue || '',
          changedAt: entry.changedAt || null,
          changedByAdminId: entry.changedByAdminId ? String(entry.changedByAdminId) : null,
        }))
      : [],
    sourcePipelineId: item.sourcePipelineId || null,
    createdAt: item.createdAt || null,
    updatedAt: item.updatedAt || null,
  };
}

async function serializeFolderItemForShared(item) {
  ensureSingleSharedMediaKit(item);
  ensureGenericRequestConsistency(item);

  const mediaKitAccess = await buildSharedMediaKitAccess(item);
  const resolvedShippingAddress = getPreferredShippingAddress(item);

  return {
    _id: item._id,
    provider: item.provider,
    name: item.name,
    handle: item.handle,
    followers: item.followers,
    primaryLink: item.primaryLink,
    links: item.links || [],
    niche: item.niche || [],
    email: item.email,
    country: item.country,
    selectionReason: item.selectionReason,
    goodFit: item.goodFit,
    influencerRateCard: item.influencerRateCard || '',
    platformRateCard: item.platformRateCard || '',
    rateCardCurrency: item.rateCardCurrency || 'USD',
    shippingAddress: resolvedShippingAddress,
    comments: resolvedShippingAddress,
    mediaKitAccess,
  };
}

function serializeFolderListItem(doc) {
  return {
    _id: doc._id,
    title: doc.title,
    slug: doc.slug,
    description: doc.description,
    brandVisibleItemCount:
      doc.brandVisibleItemCount === null || doc.brandVisibleItemCount === undefined
        ? Array.isArray(doc.items)
          ? doc.items.length
          : 0
        : doc.brandVisibleItemCount,
    showFullListToBrand: !!doc.showFullListToBrand,
    share: doc.share
      ? {
        token: doc.share.token || '',
        url: doc.share.url || '',
        generatedAt: doc.share.generatedAt || null,
        sharedBy: serializeMiniAdmin(doc.share.sharedByAdminId),
      }
      : {},
    assignedCampaign: serializeAssignedCampaign(doc.assignedCampaign),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    itemCount: Array.isArray(doc.items) ? doc.items.length : 0,
    createdBy: serializeAdmin(doc.createdByAdmin),
    updatedBy: serializeAdmin(doc.updatedByAdmin),
  };
}

function serializeFolderDetail(doc) {
  const sortedItems = sortFolderItemsByMediaKitPriority(
    Array.isArray(doc.items) ? doc.items : []
  );

  return {
    _id: doc._id,
    title: doc.title,
    slug: doc.slug,
    description: doc.description,
    brandVisibleItemCount:
      doc.brandVisibleItemCount === null || doc.brandVisibleItemCount === undefined
        ? Array.isArray(doc.items)
          ? doc.items.length
          : 0
        : doc.brandVisibleItemCount,
    showFullListToBrand: !!doc.showFullListToBrand,
    share: doc.share
      ? {
        token: doc.share.token || '',
        url: doc.share.url || '',
        generatedAt: doc.share.generatedAt || null,
        sharedBy: serializeMiniAdmin(doc.share.sharedByAdminId),
      }
      : {},
    assignedCampaign: serializeAssignedCampaign(doc.assignedCampaign),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    createdBy: serializeAdmin(doc.createdByAdmin),
    updatedBy: serializeAdmin(doc.updatedByAdmin),
    items: sortedItems.map(serializeFolderItemForAdmin),
  };
}

async function saveAndHydrateFolder(doc) {
  await doc.save();

  return PitchFolder.findById(doc._id)
    .populate(buildCreatorPopulate())
    .populate(buildUpdatedByPopulate())
    .populate(buildSharedByPopulate())
    .lean();
}


function normalizeFolderKind(value = '') {
  const raw = cleanStr(value || 'all').toLowerCase().replace(/\s+/g, '_').replace(/-/g, '_');

  if (['pitch', 'pitchsheet', 'pitch_sheet', 'pitch_folder'].includes(raw)) {
    return 'pitch_sheet';
  }

  if (['bookmark', 'bookmarks', 'bookmark_folder', 'saved', 'saved_creators'].includes(raw)) {
    return 'bookmark';
  }

  if (['fully_managed', 'fullymanaged', 'campaign', 'campaign_specific', 'campaign_folder'].includes(raw)) {
    return 'fully_managed';
  }

  return 'all';
}

function hasAssignedCampaignForFolderList(folder = {}) {
  return Boolean(
    folder?.assignedCampaign?.campaignId ||
    folder?.assignedCampaign?.campaignsId ||
    folder?.assignedCampaign?.campaignTitle ||
    folder?.assignedCampaign?.productOrServiceName
  );
}

function getStoredFolderKind(folder = {}) {
  return cleanStr(
    folder.folderType ||
    folder.type ||
    folder.source ||
    folder.folderKind ||
    folder.category
  )
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/-/g, '_');
}

function isBookmarkPitchFolder(folder = {}) {
  const kind = getStoredFolderKind(folder);
  return ['bookmark', 'bookmarks', 'bookmark_folder', 'saved', 'saved_creators'].includes(kind);
}

function isFullyManagedPitchFolder(folder = {}) {
  const kind = getStoredFolderKind(folder);
  return (
    ['fully_managed', 'fullymanaged', 'campaign', 'campaign_specific', 'campaign_folder'].includes(kind) ||
    hasAssignedCampaignForFolderList(folder)
  );
}

function folderMatchesCampaign(folder = {}, rawCampaignId = '') {
  const campaignId = cleanStr(rawCampaignId);
  if (!campaignId) return true;

  const assignedCampaign = folder?.assignedCampaign || {};
  const assignedCampaignId = cleanStr(
    assignedCampaign?.campaignId?._id || assignedCampaign?.campaignId
  );
  const assignedCampaignsId = cleanStr(assignedCampaign?.campaignsId);

  return assignedCampaignId === campaignId || assignedCampaignsId === campaignId;
}

function folderMatchesBrand(folder = {}, rawBrandId = '') {
  const brandId = cleanStr(rawBrandId);
  if (!brandId) return true;

  const assignedCampaign = folder?.assignedCampaign || {};
  const directBrandId = cleanStr(folder?.brandId?._id || folder?.brandId || folder?.brandRef);
  const campaignBrandId = cleanStr(assignedCampaign?.brandId?._id || assignedCampaign?.brandId);

  return directBrandId === brandId || campaignBrandId === brandId;
}

function serializeFolderCardFromPitchFolder(folder = {}, overrideType = '') {
  const items = Array.isArray(folder.items) ? folder.items : [];
  const assignedCampaign = serializeAssignedCampaign(folder.assignedCampaign);
  const isBookmark = isBookmarkPitchFolder(folder);
  const isFullyManaged = isFullyManagedPitchFolder(folder);

  const resolvedType = overrideType || (isBookmark ? 'bookmark' : isFullyManaged ? 'fully_managed' : 'pitch_sheet');

  return {
    _id: String(folder._id || ''),
    type: resolvedType,
    title: folder.title || folder.name || '',
    name: folder.name || folder.title || '',
    slug: folder.slug || '',
    description: folder.description || '',
    itemCount: items.length,
    goodFitCount: items.filter((item) => item?.goodFit === true).length,
    brandVisibleItemCount:
      folder.brandVisibleItemCount === null || folder.brandVisibleItemCount === undefined
        ? items.length
        : Number(folder.brandVisibleItemCount || 0),
    showFullListToBrand: !!folder.showFullListToBrand,
    isCampaignSpecific: hasAssignedCampaignForFolderList(folder),
    isFullyManaged,
    assignedCampaign,
    share: folder.share
      ? {
        token: folder.share.token || '',
        url: folder.share.url || '',
        generatedAt: folder.share.generatedAt || null,
        sharedBy: serializeMiniAdmin(folder.share.sharedByAdminId),
      }
      : {},
    createdAt: folder.createdAt || null,
    updatedAt: folder.updatedAt || null,
    createdBy: serializeAdmin(folder.createdByAdmin),
    updatedBy: serializeAdmin(folder.updatedByAdmin),
  };
}

function serializeFolderCardFromBookmarkFolder(folder = {}) {
  const items = Array.isArray(folder.items)
    ? folder.items
    : Array.isArray(folder.bookmarks)
      ? folder.bookmarks
      : Array.isArray(folder.influencers)
        ? folder.influencers
        : Array.isArray(folder.creators)
          ? folder.creators
          : [];

  return {
    _id: String(folder._id || ''),
    type: 'bookmark',
    title: folder.title || folder.name || '',
    name: folder.name || folder.title || '',
    slug: folder.slug || '',
    description: folder.description || '',
    itemCount: items.length,
    goodFitCount: 0,
    brandVisibleItemCount: items.length,
    showFullListToBrand: true,
    isCampaignSpecific: false,
    isFullyManaged: false,
    assignedCampaign: null,
    share: {},
    createdAt: folder.createdAt || null,
    updatedAt: folder.updatedAt || null,
  };
}

function folderSearchMatches(folder = {}, search = '') {
  const q = cleanStr(search).toLowerCase();
  if (!q) return true;

  return [
    folder.title,
    folder.name,
    folder.slug,
    folder.description,
    folder.type,
    folder.assignedCampaign?.campaignTitle,
    folder.assignedCampaign?.productOrServiceName,
    folder.assignedCampaign?.brandName,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(q);
}

async function loadBookmarkFoldersForFolderList({ brandId = '', search = '' } = {}) {
  if (!BookmarkFolder || typeof BookmarkFolder.find !== 'function') {
    return [];
  }

  const filter = {};

  if (brandId) {
    filter.$or = [
      { brandId },
      { brandRef: brandId },
    ];

    if (mongoose.Types.ObjectId.isValid(brandId)) {
      filter.$or.push({ brandId: new mongoose.Types.ObjectId(brandId) });
      filter.$or.push({ brandRef: new mongoose.Types.ObjectId(brandId) });
    }
  }

  const archivedOr = [
    { archivedAt: null },
    { archivedAt: { $exists: false } },
  ];

  filter.$and = [{ $or: archivedOr }];

  const docs = await BookmarkFolder.find(filter).sort({ updatedAt: -1 }).lean();

  return docs
    .map(serializeFolderCardFromBookmarkFolder)
    .filter((folder) => folderSearchMatches(folder, search));
}

exports.getFolderList = async (req, res) => {
  try {
    const hasAdminScope = !!req.admin;
    const authedBrandId = getAuthedBrandId(req);
    const brandId = getRequestedBrandId(req);

    if (hasAdminScope && !canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({
        success: false,
        error: 'You are not allowed to access folders',
      });
    }

    if (!hasAdminScope && !authedBrandId) {
      return res.status(401).json({
        success: false,
        error: 'Brand authentication is required',
      });
    }

    const folderKind = normalizeFolderKind(req.query?.type || req.query?.folderType || 'all');
    const search = cleanStr(req.query?.search || req.query?.q);
    const campaignId = cleanStr(req.query?.campaignId);
    const hasGoodFitOnly = ['1', 'true', 'yes', 'on'].includes(
      cleanStr(req.query?.hasGoodFit || req.query?.onlyGoodFit || req.query?.goodFit).toLowerCase()
    );

    const includePitchSheets = folderKind === 'all' || folderKind === 'pitch_sheet';
    const includeBookmarks = folderKind === 'all' || folderKind === 'bookmark';
    const includeFullyManaged = folderKind === 'all' || folderKind === 'fully_managed';

    let baseFilter = hasAdminScope
      ? await buildFolderAccessFilter(req.admin)
      : buildBrandScopedPitchFolderFilter(authedBrandId);

    if (hasAdminScope && !baseFilter) {
      return res.status(403).json({
        success: false,
        error: 'You are not allowed to access folders',
      });
    }

    if (hasAdminScope && brandId) {
      baseFilter = applyBrandScopeToFilter(baseFilter, brandId);
    }

    const pitchQueryFilter = hasGoodFitOnly
      ? { ...baseFilter, 'items.goodFit': true }
      : baseFilter;

    const pitchDocs = includePitchSheets || includeFullyManaged || campaignId
      ? await PitchFolder.find(pitchQueryFilter)
        .populate(buildCreatorPopulate())
        .populate(buildUpdatedByPopulate())
        .populate(buildSharedByPopulate())
        .sort({ updatedAt: -1 })
        .lean()
      : [];

    const pitchCards = pitchDocs
      .filter((folder) => folderMatchesCampaign(folder, campaignId))
      .filter((folder) => folderMatchesBrand(folder, brandId))
      .filter((folder) => {
        if (!hasGoodFitOnly) return true;
        const items = Array.isArray(folder.items) ? folder.items : [];
        return items.some((item) => item?.goodFit === true);
      })
      .map((folder) => serializeFolderCardFromPitchFolder(folder));

    const pitchSheetFolders = includePitchSheets
      ? pitchCards
        .filter((folder) => folder.type === 'pitch_sheet')
        .filter((folder) => folderSearchMatches(folder, search))
      : [];

    const fullyManagedFolders = includeFullyManaged
      ? pitchCards
        .filter((folder) => folder.type === 'fully_managed' || folder.isCampaignSpecific)
        .map((folder) => ({ ...folder, type: 'fully_managed', isFullyManaged: true }))
        .filter((folder) => folderSearchMatches(folder, search))
      : [];

    const bookmarkPitchFolders = includeBookmarks
      ? pitchCards
        .filter((folder) => folder.type === 'bookmark')
        .filter((folder) => folderSearchMatches(folder, search))
      : [];

    const externalBookmarkFolders = includeBookmarks && !campaignId && !hasGoodFitOnly
      ? await loadBookmarkFoldersForFolderList({ brandId, search })
      : [];

    const bookmarkFolders = [...bookmarkPitchFolders, ...externalBookmarkFolders];

    const folders = [
      ...pitchSheetFolders,
      ...bookmarkFolders,
      ...fullyManagedFolders,
    ];

    return res.json({
      success: true,
      message: 'Folders fetched successfully',
      data: {
        totalCount: folders.length,
        pitchSheetCount: pitchSheetFolders.length,
        bookmarkCount: bookmarkFolders.length,
        fullyManagedCount: fullyManagedFolders.length,
        folders,
        groups: {
          pitchSheets: pitchSheetFolders,
          bookmarks: bookmarkFolders,
          fullyManagedCampaigns: fullyManagedFolders,
        },
      },
    });
  } catch (err) {
    console.error('[getFolderList] Error:', err);

    await saveErrorLog(req, err, err?.response?.status || err?.statusCode || err?.status || 500, 'GET_FOLDER_LIST_ERROR'); return res.status(500).json({
      success: false,
      error: err?.message || 'Internal error',
    });
  }
};


exports.generateSelectionReason = async (req, res) => {
  try {
    if (!canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({
        success: false,
        error: 'You are not allowed to generate selection reasons',
      });
    }

    const ctx = buildSelectionReasonContext(req.body || {});

    if (!hasEnoughSelectionReasonContext(ctx)) {
      return res.status(400).json({
        success: false,
        error:
          'Add at least one creator detail such as name, handle, followers, niche, country, rate card, or campaign before generating a selection reason.',
      });
    }

    const result = await generateSelectionReasonWithAI(ctx);
    const selectionReason = cleanStr(result.selectionReason);

    if (!selectionReason) {
      return res.status(500).json({
        success: false,
        error: 'Selection reason could not be generated',
      });
    }

    return res.json({
      success: true,
      message: 'Selection reason generated successfully',
      source: result.source,
      selectionReason,
      data: {
        selectionReason,
        source: result.source,
      },
    });
  } catch (err) {
    console.error('[generateSelectionReason] Error:', err);

    await saveErrorLog(req, err, err?.response?.status || err?.statusCode || err?.status || 500, 'GENERATE_SELECTION_REASON_ERROR'); return res.status(500).json({
      success: false,
      error: err?.message || 'Internal error',
    });
  }
};

exports.listFolders = async (req, res) => {
  try {
    if (!canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({ error: 'You are not allowed to access pitch folders' });
    }

    const q = cleanStr(req.query.q);
    const baseFilter = await buildFolderAccessFilter(req.admin);

    if (!baseFilter) {
      return res.status(403).json({ error: 'You are not allowed to access pitch folders' });
    }

    const filter = applyFolderSearch(baseFilter, q);

    const docs = await PitchFolder.find(filter)
      .populate(buildCreatorPopulate())
      .populate(buildUpdatedByPopulate())
      .populate(buildSharedByPopulate())
      .sort({ updatedAt: -1 })
      .lean();

    return res.json({
      success: true,
      data: docs.map(serializeFolderListItem),
    });
  } catch (err) {
    console.error('[listFolders] Error:', err);

    await saveErrorLog(req, err, err?.response?.status || err?.statusCode || err?.status || 500, 'LIST_FOLDERS_ERROR'); return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

async function buildUniqueFolderSlug(title, excludeFolderId = null) {
  const baseSlug = slugify(title) || `pitch-folder-${Date.now()}`;
  let slug = baseSlug;
  let counter = 1;

  while (
    await PitchFolder.exists({
      ...(excludeFolderId ? { _id: { $ne: excludeFolderId } } : {}),
      slug,
      archivedAt: null,
    })
  ) {
    counter += 1;
    slug = `${baseSlug}-${counter}`;
  }

  return slug;
}

function resetDuplicatedMediaKitState(mediaKit) {
  const next = normalizeMediaKit(mediaKit || null, null, mediaKit || null);

  if (!hasStoredMediaKit(next)) {
    return normalizeMediaKit(null, null);
  }

  next.showToBrand = false;
  next.requestStatus = 'none';
  next.requestedAt = null;
  next.reviewedAt = null;
  next.reviewedByAdminId = null;

  return next;
}

function resetDuplicatedMediaKitLinkState(mediaKitLink) {
  const next = normalizeMediaKitLink(mediaKitLink || null, null, mediaKitLink || null);

  if (!hasMediaKitLink(next)) {
    return normalizeMediaKitLink(null, null);
  }

  next.showToBrand = false;
  next.requestStatus = 'none';
  next.requestedAt = null;
  next.reviewedAt = null;
  next.reviewedByAdminId = null;

  return next;
}

function cloneFolderItemForTransfer(item, actorId = null) {
  const source = typeof item?.toObject === 'function' ? item.toObject() : item || {};

  const clonedItem = {
    provider: normalizeProvider(source.provider),
    name: cleanStr(source.name),
    handle: cleanStr(source.handle).replace(/^@+/, '@'),
    followers: toNullableNumber(source.followers),

    primaryLink: cleanStr(source.primaryLink),
    links: Array.isArray(source.links) ? uniqStrings(source.links) : [],

    niche: Array.isArray(source.niche) ? uniqStrings(source.niche) : [],
    email: cleanStr(source.email).toLowerCase(),
    country: cleanStr(source.country),

    selectionReason: cleanStr(source.selectionReason),
    goodFit: !!source.goodFit,

    influencerRateCard: cleanStr(source.influencerRateCard),
    platformRateCard: cleanStr(source.platformRateCard),
    rateCardCurrency: cleanStr(source.rateCardCurrency || 'USD').toUpperCase(),

    ourFeePct: toNullableNumber(source.ourFeePct),
    shippingAddress: getPreferredShippingAddress(source),

    mediaKit: normalizeMediaKit(source.mediaKit || null, actorId, source.mediaKit || null),
    mediaKitLink: normalizeMediaKitLink(
      source.mediaKitLink || null,
      actorId,
      source.mediaKitLink || null
    ),

    rateCardHistory: Array.isArray(source.rateCardHistory)
      ? source.rateCardHistory.map((entry) => ({
        field: cleanStr(entry.field),
        previousValue: cleanStr(entry.previousValue),
        newValue: cleanStr(entry.newValue),
        changedAt: entry?.changedAt ? new Date(entry.changedAt) : new Date(),
        changedByAdminId:
          entry?.changedByAdminId &&
            mongoose.Types.ObjectId.isValid(String(entry.changedByAdminId))
            ? new mongoose.Types.ObjectId(String(entry.changedByAdminId))
            : null,
      }))
      : [],

    sourcePipelineId:
      source?.sourcePipelineId &&
        mongoose.Types.ObjectId.isValid(String(source.sourcePipelineId))
        ? new mongoose.Types.ObjectId(String(source.sourcePipelineId))
        : null,

    createdByAdmin:
      actorId && mongoose.Types.ObjectId.isValid(String(actorId))
        ? new mongoose.Types.ObjectId(String(actorId))
        : null,
    updatedByAdmin:
      actorId && mongoose.Types.ObjectId.isValid(String(actorId))
        ? new mongoose.Types.ObjectId(String(actorId))
        : null,
  };

  ensureSingleSharedMediaKit(clonedItem);
  ensureGenericRequestConsistency(clonedItem);

  return clonedItem;
}

function cloneFolderItemForDuplicate(item, actorId = null) {
  const source = typeof item?.toObject === 'function' ? item.toObject() : item || {};

  const clonedItem = {
    provider: normalizeProvider(source.provider),
    name: cleanStr(source.name),
    handle: cleanStr(source.handle).replace(/^@+/, '@'),
    followers: toNullableNumber(source.followers),

    primaryLink: cleanStr(source.primaryLink),
    links: Array.isArray(source.links) ? uniqStrings(source.links) : [],

    niche: Array.isArray(source.niche) ? uniqStrings(source.niche) : [],
    email: cleanStr(source.email).toLowerCase(),
    country: cleanStr(source.country),

    selectionReason: cleanStr(source.selectionReason),
    goodFit: false,

    influencerRateCard: cleanStr(source.influencerRateCard),
    platformRateCard: cleanStr(source.platformRateCard),
    rateCardCurrency: cleanStr(source.rateCardCurrency || 'USD').toUpperCase(),

    ourFeePct: toNullableNumber(source.ourFeePct),
    shippingAddress: getPreferredShippingAddress(source),

    mediaKit: resetDuplicatedMediaKitState(source.mediaKit),
    mediaKitLink: resetDuplicatedMediaKitLinkState(source.mediaKitLink),

    rateCardHistory: Array.isArray(source.rateCardHistory)
      ? source.rateCardHistory.map((entry) => ({
        field: cleanStr(entry.field),
        previousValue: cleanStr(entry.previousValue),
        newValue: cleanStr(entry.newValue),
        changedAt: entry?.changedAt ? new Date(entry.changedAt) : new Date(),
        changedByAdminId:
          entry?.changedByAdminId &&
            mongoose.Types.ObjectId.isValid(String(entry.changedByAdminId))
            ? new mongoose.Types.ObjectId(String(entry.changedByAdminId))
            : null,
      }))
      : [],

    sourcePipelineId:
      source?.sourcePipelineId &&
        mongoose.Types.ObjectId.isValid(String(source.sourcePipelineId))
        ? new mongoose.Types.ObjectId(String(source.sourcePipelineId))
        : null,

    createdByAdmin:
      actorId && mongoose.Types.ObjectId.isValid(String(actorId))
        ? new mongoose.Types.ObjectId(String(actorId))
        : null,
    updatedByAdmin:
      actorId && mongoose.Types.ObjectId.isValid(String(actorId))
        ? new mongoose.Types.ObjectId(String(actorId))
        : null,
  };

  ensureSingleSharedMediaKit(clonedItem);
  ensureGenericRequestConsistency(clonedItem);

  return clonedItem;
}

exports.createFolder = async (req, res) => {
  try {
    const hasAdminScope = !!req.admin;
    const authedBrandId = getAuthedBrandId(req);

    if (hasAdminScope && !canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({ error: 'You are not allowed to create folders' });
    }

    if (!hasAdminScope && !authedBrandId) {
      return res.status(401).json({
        success: false,
        error: 'Brand authentication is required',
      });
    }

    const actorId = hasAdminScope ? getActorAdminId(req.admin) : null;
    const body = req.body || {};
    const brandId = authedBrandId || cleanStr(body.brandId || req.admin?.brandId);
    const brandRef = mongoose.Types.ObjectId.isValid(brandId)
      ? new mongoose.Types.ObjectId(brandId)
      : null;

    const requestedFolderKind = normalizeFolderKind(body.type || body.folderType || body.kind || 'pitch_sheet');

    const title = cleanStr(body.title || body.name);
    if (!title) {
      return res.status(400).json({ error: 'title is required' });
    }

    const description = cleanStr(body.description);

    if (requestedFolderKind === 'bookmark') {
      if (BookmarkFolder && typeof BookmarkFolder.create === 'function') {
        const bookmarkPayload = {
          title,
          name: title,
          slug: await buildUniqueFolderSlug(title),
          description,
          brandId,
          brandRef,
          createdByAdmin: actorId || null,
          updatedByAdmin: actorId || null,
          createdByRole: hasAdminScope ? cleanStr(req.admin?.role) : 'Brand',
        };

        const bookmarkDoc = await BookmarkFolder.create(bookmarkPayload);
        const bookmarkObject = typeof bookmarkDoc.toObject === 'function'
          ? bookmarkDoc.toObject()
          : bookmarkDoc;

        return res.json({
          success: true,
          message: 'Bookmark folder created successfully',
          data: serializeFolderCardFromBookmarkFolder(bookmarkObject),
        });
      }

      return res.status(500).json({
        success: false,
        error:
          'BookmarkFolder model was not found. Add ../models/bookmarkFolder or change the optional import path in this controller.',
      });
    }

    const rawCampaignId = cleanStr(body.campaignId || body.campaignsId);
    const shouldCreateCampaignFolder = requestedFolderKind === 'fully_managed' || !!rawCampaignId;

    let assignedCampaign = null;

    if (shouldCreateCampaignFolder) {
      if (!rawCampaignId) {
        return res.status(400).json({
          success: false,
          error: 'campaignId is required for fully managed campaign folders',
        });
      }

      const campaign = await findCampaignByAnyIdForAssignment(rawCampaignId);

      if (!campaign) {
        return res.status(404).json({
          success: false,
          error: 'Campaign not found',
        });
      }

      if (brandId && !assertBrandCanUseCampaign(campaign, brandId)) {
        return res.status(403).json({
          success: false,
          error: 'This campaign does not belong to the authenticated brand',
        });
      }

      assignedCampaign = buildAssignedCampaignPayload(campaign, actorId);
    }

    const slug = await buildUniqueFolderSlug(title);

    const rawItems = Array.isArray(body.items) ? body.items : [];
    const initialItems = [];
    const seenInitialKeys = new Set();

    for (const rawItem of rawItems) {
      const normalizedItem = {
        ...normalizeItem(rawItem, actorId),
        createdByAdmin: actorId || null,
      };

      const itemKey = buildFolderItemDedupeKey(normalizedItem);

      if (itemKey && seenInitialKeys.has(itemKey)) {
        continue;
      }

      if (itemKey) {
        seenInitialKeys.add(itemKey);
      }

      initialItems.push(normalizedItem);
    }

    const doc = await PitchFolder.create({
      title,
      slug,
      description,
      brandId,
      brandRef,
      folderType: shouldCreateCampaignFolder ? 'fully_managed' : 'pitch_sheet',
      source: hasAdminScope ? 'admin' : 'brand',
      brandVisibleItemCount: hasOwn(body, 'brandVisibleItemCount')
        ? toNullableInteger(body.brandVisibleItemCount)
        : null,
      showFullListToBrand: hasOwn(body, 'showFullListToBrand') ? !!body.showFullListToBrand : true,
      items: initialItems,
      assignedCampaign: assignedCampaign || {},
      createdByAdmin: actorId || null,
      updatedByAdmin: actorId || null,
    });

    const hydrated = await PitchFolder.findById(doc._id)
      .populate(buildCreatorPopulate())
      .populate(buildUpdatedByPopulate())
      .populate(buildSharedByPopulate())
      .lean();

    return res.json({
      success: true,
      message: shouldCreateCampaignFolder
        ? 'Fully managed campaign folder created successfully'
        : 'Pitch folder created successfully',
      data: serializeFolderDetail(hydrated),
    });
  } catch (err) {
    console.error('[createFolder] Error:', err);

    await saveErrorLog(req, err, err?.response?.status || err?.statusCode || err?.status || 500, 'CREATE_FOLDER_ERROR'); return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.getFolderByAssignedCampaign = async (req, res) => {
  try {
    const rawCampaignId = cleanStr(req.params?.campaignId || req.query?.campaignId || req.body?.campaignId);

    if (!rawCampaignId) {
      return res.status(400).json({ success: false, error: 'campaignId is required' });
    }

    const campaign = await findCampaignByAnyIdForAssignment(rawCampaignId);
    const or = [];

    or.push({ 'assignedCampaign.campaignsId': rawCampaignId });

    if (mongoose.Types.ObjectId.isValid(rawCampaignId)) {
      or.push({ 'assignedCampaign.campaignId': new mongoose.Types.ObjectId(rawCampaignId) });
    }

    if (campaign?._id) {
      or.push({ 'assignedCampaign.campaignId': campaign._id });
    }

    if (campaign?.campaignsId) {
      or.push({ 'assignedCampaign.campaignsId': cleanStr(campaign.campaignsId) });
    }

    const doc = await PitchFolder.findOne({
      archivedAt: null,
      $or: or,
    })
      .populate(buildCreatorPopulate())
      .populate(buildUpdatedByPopulate())
      .populate(buildSharedByPopulate())
      .sort({ updatedAt: -1 })
      .exec();

    if (!doc) {
      return res.status(404).json({
        success: false,
        error: 'No pitch folder is assigned to this campaign',
      });
    }

    return res.json({
      success: true,
      data: await serializeFolderDetailWithCampaignState(doc),
    });
  } catch (err) {
    console.error('[getFolderByAssignedCampaign] Error:', err);

    await saveErrorLog(req, err, err?.response?.status || err?.statusCode || err?.status || 500, 'GET_FOLDER_BY_ASSIGNED_CAMPAIGN_ERROR'); return res.status(500).json({ success: false, error: err?.message || 'Internal error' });
  }
};

exports.getFolderById = async (req, res) => {
  try {
    if (!canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({ error: 'You are not allowed to access pitch folders' });
    }

    const id = cleanStr(req.params.id);

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Valid folder id is required' });
    }

    const doc = await findAccessibleFolder(id, req.admin);

    if (!doc) {
      return res.status(404).json({ error: 'Pitch folder not found' });
    }

    return res.json({
      success: true,
      data: await serializeFolderDetailWithCampaignState(doc),
    });
  } catch (err) {
    console.error('[getFolderById] Error:', err);

    await saveErrorLog(req, err, err?.response?.status || err?.statusCode || err?.status || 500, 'GET_FOLDER_BY_ID_ERROR'); return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.updateFolder = async (req, res) => {
  try {
    if (!canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({ error: 'You are not allowed to update pitch folders' });
    }

    const actorId = getActorAdminId(req.admin);
    const body = req.body || {};
    const id = cleanStr(body.id || body.folderId || req.params?.id);

    const hasTitle = hasOwn(body, 'title');
    const hasDescription = hasOwn(body, 'description');
    const hasBrandVisibleItemCount = hasOwn(body, 'brandVisibleItemCount');
    const hasShowFullListToBrand = hasOwn(body, 'showFullListToBrand');

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Valid folder id is required' });
    }

    if (
      !hasTitle &&
      !hasDescription &&
      !hasBrandVisibleItemCount &&
      !hasShowFullListToBrand
    ) {
      return res.status(400).json({
        error:
          'At least one of title, description, brandVisibleItemCount, or showFullListToBrand must be provided',
      });
    }

    if (hasTitle && !cleanStr(body.title)) {
      return res.status(400).json({ error: 'Folder name is required' });
    }

    const doc = await findAccessibleFolder(id, req.admin);
    if (!doc) {
      return res.status(404).json({ error: 'Pitch folder not found' });
    }

    if (hasTitle) {
      const nextTitle = cleanStr(body.title);
      doc.title = nextTitle;
      doc.slug = await buildUniqueFolderSlug(nextTitle, doc._id);
    }

    if (hasDescription) {
      doc.description = cleanStr(body.description);
    }

    if (hasBrandVisibleItemCount) {
      const rawCount = body.brandVisibleItemCount;

      if (rawCount === '' || rawCount === null || rawCount === undefined) {
        doc.brandVisibleItemCount = null;
      } else {
        const parsedCount = toNullableInteger(rawCount);

        if (parsedCount === null) {
          return res.status(400).json({
            error: 'brandVisibleItemCount must be a non-negative integer or null',
          });
        }

        doc.brandVisibleItemCount = parsedCount;
      }
    }

    if (hasShowFullListToBrand) {
      doc.showFullListToBrand = !!body.showFullListToBrand;
    }

    doc.updatedByAdmin = actorId || null;

    const hydrated = await saveAndHydrateFolder(doc);

    return res.json({
      success: true,
      message: 'Pitch folder updated successfully',
      data: serializeFolderDetail(hydrated),
    });
  } catch (err) {
    console.error('[updateFolder] Error:', err);

    await saveErrorLog(req, err, err?.response?.status || err?.statusCode || err?.status || 500, 'UPDATE_FOLDER_ERROR'); return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.duplicateFolder = async (req, res) => {
  try {
    if (!canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({ error: 'You are not allowed to duplicate pitch folders' });
    }

    const actorId = getActorAdminId(req.admin);
    const body = req.body || {};
    const sourceFolderId = cleanStr(body.folderId || body.id || req.params?.id);

    if (!mongoose.Types.ObjectId.isValid(sourceFolderId)) {
      return res.status(400).json({ error: 'Valid folder id is required' });
    }

    const sourceDoc = await findAccessibleFolder(sourceFolderId, req.admin);
    if (!sourceDoc) {
      return res.status(404).json({ error: 'Pitch folder not found' });
    }

    const duplicateTitle = cleanStr(body.title) || `${cleanStr(sourceDoc.title)} Copy`;
    const duplicateSlug = await buildUniqueFolderSlug(duplicateTitle);

    const duplicatedItems = Array.isArray(sourceDoc.items)
      ? sourceDoc.items.map((item) => cloneFolderItemForDuplicate(item, actorId))
      : [];

    const duplicatedFolder = await PitchFolder.create({
      title: duplicateTitle,
      slug: duplicateSlug,
      description: cleanStr(sourceDoc.description),

      brandVisibleItemCount: null,
      showFullListToBrand: true,

      // deep duplicate items
      items: duplicatedItems,

      // never duplicate share token / URL
      share: {
        token: '',
        url: '',
        generatedAt: null,
        sharedByAdminId: null,
      },

      // duplicated folders start as reusable/unassigned pitch folders
      assignedCampaign: {},

      createdByAdmin: actorId || null,
      updatedByAdmin: actorId || null,
    });

    const hydrated = await PitchFolder.findById(duplicatedFolder._id)
      .populate(buildCreatorPopulate())
      .populate(buildUpdatedByPopulate())
      .populate(buildSharedByPopulate())
      .lean();

    return res.json({
      success: true,
      message: 'Pitch folder duplicated successfully',
      data: serializeFolderDetail(hydrated),
    });
  } catch (err) {
    console.error('[duplicateFolder] Error:', err);

    await saveErrorLog(req, err, err?.response?.status || err?.statusCode || err?.status || 500, 'DUPLICATE_FOLDER_ERROR'); return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.archiveFolder = async (req, res) => {
  try {
    if (!canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({ error: 'You are not allowed to archive pitch folders' });
    }

    const actorId = getActorAdminId(req.admin);
    const id = cleanStr(req.body?.id);

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Valid folder id is required' });
    }

    const doc = await findAccessibleFolder(id, req.admin);
    if (!doc) {
      return res.status(404).json({ error: 'Pitch folder not found' });
    }

    doc.archivedAt = new Date();
    doc.updatedByAdmin = actorId || null;
    await doc.save();

    return res.json({
      success: true,
      message: 'Pitch folder archived successfully',
    });
  } catch (err) {
    console.error('[archiveFolder] Error:', err);

    await saveErrorLog(req, err, err?.response?.status || err?.statusCode || err?.status || 500, 'ARCHIVE_FOLDER_ERROR'); return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.addFolderItem = async (req, res) => {
  try {
    if (!canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({
        error: 'You are not allowed to update pitch folders',
      });
    }

    const actorId = getActorAdminId(req.admin);
    const folderId = cleanStr(req.params.id);

    if (!mongoose.Types.ObjectId.isValid(folderId)) {
      return res.status(400).json({
        error: 'Valid folder id is required',
      });
    }

    const doc = await findAccessibleFolder(folderId, req.admin);

    if (!doc) {
      return res.status(404).json({
        error: 'Pitch folder not found',
      });
    }

    const enrichedBody = await enrichPitchFolderItemBodyWithProfileEmail(
      req.body || {}
    );

    const item = {
      ...normalizeItem(enrichedBody, actorId),
      createdByAdmin: actorId || null,
    };

    if (!item.name) {
      return res.status(400).json({
        error: 'Influencer name is required',
      });
    }

    if (folderHasDuplicateItem(doc, item)) {
      return res.status(409).json({
        error: 'This influencer already exists in the pitch folder',
      });
    }

    doc.items.push(item);
    doc.updatedByAdmin = actorId || null;

    const hydrated = await saveAndHydrateFolder(doc);

    return res.json({
      success: true,
      message: 'Influencer added successfully',
      data: serializeFolderDetail(hydrated),
    });
  } catch (err) {
    console.error('[addFolderItem] Error:', err);

    await saveErrorLog(req, err, err?.response?.status || err?.statusCode || err?.status || 500, 'ADD_FOLDER_ITEM_ERROR'); return res.status(500).json({
      error: err?.message || 'Internal error',
    });
  }
};

exports.updateFolderItem = async (req, res) => {
  try {
    if (!canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({
        error: 'You are not allowed to update pitch folders',
      });
    }

    const actorId = getActorAdminId(req.admin);
    const folderId = cleanStr(req.body?.folderId);
    const itemId = cleanStr(req.body?.itemId);

    if (
      !mongoose.Types.ObjectId.isValid(folderId) ||
      !mongoose.Types.ObjectId.isValid(itemId)
    ) {
      return res.status(400).json({
        error: 'Valid folderId and itemId are required',
      });
    }

    const doc = await findAccessibleFolder(folderId, req.admin);

    if (!doc) {
      return res.status(404).json({
        error: 'Pitch folder not found',
      });
    }

    const item = doc.items.id(itemId);

    if (!item) {
      return res.status(404).json({
        error: 'Folder item not found',
      });
    }

    const currentItem =
      typeof item.toObject === 'function' ? item.toObject() : item;

    const requestedGoodFit = hasOwn(req.body || {}, 'goodFit')
      ? !!req.body.goodFit
      : null;

    if (
      hasAssignedCampaign(doc) &&
      item.goodFit === true &&
      requestedGoodFit === false
    ) {
      return res.status(400).json({
        success: false,
        error:
          'Campaign is already assigned. You cannot mark an existing Good Fit influencer as Unfit.',
      });
    }

    const enrichedBody = await enrichPitchFolderItemBodyWithProfileEmail(
      req.body || {},
      currentItem || {}
    );

    applyItemMutations(item, enrichedBody || {}, actorId);

    if (!cleanStr(item.name)) {
      return res.status(400).json({
        error: 'Influencer name is required',
      });
    }

    if (folderHasDuplicateItem(doc, item, itemId)) {
      return res.status(409).json({
        error:
          'Another influencer with the same handle/link/email already exists in this pitch folder',
      });
    }

    doc.updatedByAdmin = actorId || null;

    const hydrated = await saveAndHydrateFolder(doc);

    return res.json({
      success: true,
      message: 'Influencer updated successfully',
      data: serializeFolderDetail(hydrated),
    });
  } catch (err) {
    console.error('[updateFolderItem] Error:', err);

    await saveErrorLog(req, err, err?.response?.status || err?.statusCode || err?.status || 500, 'UPDATE_FOLDER_ITEM_ERROR'); return res.status(500).json({
      error: err?.message || 'Internal error',
    });
  }
};

exports.deleteFolderItem = async (req, res) => {
  try {
    if (!canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({ error: 'You are not allowed to update pitch folders' });
    }

    const actorId = getActorAdminId(req.admin);
    const folderId = cleanStr(req.body?.folderId);
    const itemId = cleanStr(req.body?.itemId);

    if (!mongoose.Types.ObjectId.isValid(folderId) || !mongoose.Types.ObjectId.isValid(itemId)) {
      return res.status(400).json({ error: 'Valid folderId and itemId are required' });
    }

    const doc = await findAccessibleFolder(folderId, req.admin);
    if (!doc) {
      return res.status(404).json({ error: 'Pitch folder not found' });
    }

    const item = doc.items.id(itemId);
    if (!item) {
      return res.status(404).json({ error: 'Folder item not found' });
    }

    item.deleteOne();
    doc.updatedByAdmin = actorId || null;

    const hydrated = await saveAndHydrateFolder(doc);

    return res.json({
      success: true,
      message: 'Influencer removed successfully',
      data: serializeFolderDetail(hydrated),
    });
  } catch (err) {
    console.error('[deleteFolderItem] Error:', err);

    await saveErrorLog(req, err, err?.response?.status || err?.statusCode || err?.status || 500, 'DELETE_FOLDER_ITEM_ERROR'); return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.getFolderItemMediaKitUploadUrl = async (req, res) => {
  try {
    if (!canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({ error: 'You are not allowed to upload media kits' });
    }

    const folderId = cleanStr(req.body?.folderId);
    const fileName = cleanStr(req.body?.fileName);
    const contentType = cleanStr(req.body?.contentType).toLowerCase() || 'application/pdf';

    if (!mongoose.Types.ObjectId.isValid(folderId)) {
      return res.status(400).json({ error: 'Valid folderId is required' });
    }

    const folder = await findAccessibleFolder(folderId, req.admin);
    if (!folder) {
      return res.status(404).json({ error: 'Pitch folder not found' });
    }

    if (!fileName) {
      return res.status(400).json({ error: 'fileName is required' });
    }

    if (contentType !== 'application/pdf' && !fileName.toLowerCase().endsWith('.pdf')) {
      return res.status(400).json({ error: 'Only PDF MediaKit uploads are allowed' });
    }

    const safeFileName = sanitizeFileName(fileName);
    const key = buildMediaKitS3Key(folderId, safeFileName);

    const uploadUrl = await createMediaKitUploadUrl({
      key,
      contentType: 'application/pdf',
    });

    return res.json({
      success: true,
      data: {
        key,
        fileName: safeFileName,
        contentType: 'application/pdf',
        uploadUrl,
        expiresIn: 900,
      },
    });
  } catch (err) {
    console.error('[getFolderItemMediaKitUploadUrl] Error:', err);

    await saveErrorLog(req, err, err?.response?.status || err?.statusCode || err?.status || 500, 'GET_FOLDER_ITEM_MEDIA_KIT_UPLOAD_URL_ERROR'); return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.updateFolderItemMediaKitVisibility = async (req, res) => {
  try {
    if (!canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({ error: 'You are not allowed to update media kit visibility' });
    }

    const actorId = getActorAdminId(req.admin);
    const folderId = cleanStr(req.body?.folderId);
    const itemId = cleanStr(req.body?.itemId);
    const showToBrand = !!req.body?.showToBrand;

    if (!mongoose.Types.ObjectId.isValid(folderId) || !mongoose.Types.ObjectId.isValid(itemId)) {
      return res.status(400).json({ error: 'Valid folderId and itemId are required' });
    }

    const doc = await findAccessibleFolder(folderId, req.admin);
    if (!doc) {
      return res.status(404).json({ error: 'Pitch folder not found' });
    }

    const item = doc.items.id(itemId);
    if (!item) {
      return res.status(404).json({ error: 'Folder item not found' });
    }

    if (showToBrand) {
      setVisibleMediaKitSource(item, 'pdf', actorId);
    } else {
      markSpecificMediaKitHidden(item, 'pdf', actorId);
    }

    item.updatedByAdmin = actorId || null;
    doc.updatedByAdmin = actorId || null;

    const hydrated = await saveAndHydrateFolder(doc);
    const updatedItem = hydrated.items.find((x) => String(x._id) === String(itemId));

    return res.json({
      success: true,
      message: `MediaKit is now ${showToBrand ? 'visible' : 'hidden'} for brand`,
      data: {
        folderId: hydrated._id,
        itemId,
        mediaKitAccess: updatedItem?.mediaKitAccess || null,
        mediaKit: updatedItem?.mediaKit || null,
      },
    });
  } catch (err) {
    console.error('[updateFolderItemMediaKitVisibility] Error:', err);

    await saveErrorLog(req, err, err?.response?.status || err?.statusCode || err?.status || 500, 'UPDATE_FOLDER_ITEM_MEDIA_KIT_VISIBILITY_ERROR'); return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.updateFolderItemMediaKitApproval = async (req, res) => {
  try {
    if (!canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({ error: 'You are not allowed to approve media kit requests' });
    }

    const actorId = getActorAdminId(req.admin);
    const folderId = cleanStr(req.body?.folderId);
    const itemId = cleanStr(req.body?.itemId);
    const action = cleanStr(req.body?.action).toLowerCase();

    if (!mongoose.Types.ObjectId.isValid(folderId) || !mongoose.Types.ObjectId.isValid(itemId)) {
      return res.status(400).json({ error: 'Valid folderId and itemId are required' });
    }

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'action must be approve or reject' });
    }

    const doc = await findAccessibleFolder(folderId, req.admin);
    if (!doc) {
      return res.status(404).json({ error: 'Pitch folder not found' });
    }

    const item = doc.items.id(itemId);
    if (!item) {
      return res.status(404).json({ error: 'Folder item not found' });
    }

    if (!hasStoredMediaKit(item.mediaKit)) {
      return res.status(400).json({ error: 'No MediaKit PDF uploaded for this influencer yet' });
    }

    if (!item.mediaKit) {
      item.mediaKit = normalizeMediaKit(null, actorId);
    }

    if (action === 'approve') {
      setVisibleMediaKitSource(item, 'pdf', actorId);
    } else {
      item.mediaKit.showToBrand = false;
      item.mediaKit.requestStatus = 'rejected';
      item.mediaKit.reviewedAt = new Date();
      item.mediaKit.reviewedByAdminId = actorId || null;
    }

    item.updatedByAdmin = actorId || null;
    doc.updatedByAdmin = actorId || null;

    const hydrated = await saveAndHydrateFolder(doc);
    const updatedItem = hydrated.items.find((x) => String(x._id) === String(itemId));

    return res.json({
      success: true,
      message: `MediaKit request ${action}d successfully`,
      data: {
        folderId: hydrated._id,
        itemId,
        mediaKitAccess: updatedItem?.mediaKitAccess || null,
        mediaKit: updatedItem?.mediaKit || null,
      },
    });
  } catch (err) {
    console.error('[updateFolderItemMediaKitApproval] Error:', err);

    await saveErrorLog(req, err, err?.response?.status || err?.statusCode || err?.status || 500, 'UPDATE_FOLDER_ITEM_MEDIA_KIT_APPROVAL_ERROR'); return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.updateFolderItemMediaKitLinkVisibility = async (req, res) => {
  try {
    if (!canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({ error: 'You are not allowed to update media kit link visibility' });
    }

    const actorId = getActorAdminId(req.admin);
    const folderId = cleanStr(req.body?.folderId);
    const itemId = cleanStr(req.body?.itemId);
    const showToBrand = !!req.body?.showToBrand;

    if (!mongoose.Types.ObjectId.isValid(folderId) || !mongoose.Types.ObjectId.isValid(itemId)) {
      return res.status(400).json({ error: 'Valid folderId and itemId are required' });
    }

    const doc = await findAccessibleFolder(folderId, req.admin);
    if (!doc) {
      return res.status(404).json({ error: 'Pitch folder not found' });
    }

    const item = doc.items.id(itemId);
    if (!item) {
      return res.status(404).json({ error: 'Folder item not found' });
    }

    if (showToBrand) {
      setVisibleMediaKitSource(item, 'link', actorId);
    } else {
      markSpecificMediaKitHidden(item, 'link', actorId);
    }

    item.updatedByAdmin = actorId || null;
    doc.updatedByAdmin = actorId || null;

    const hydrated = await saveAndHydrateFolder(doc);
    const updatedItem = hydrated.items.find((x) => String(x._id) === String(itemId));

    return res.json({
      success: true,
      message: `Media kit link is now ${showToBrand ? 'visible' : 'hidden'} for brand`,
      data: {
        folderId: hydrated._id,
        itemId,
        mediaKitAccess: updatedItem?.mediaKitAccess || null,
        mediaKitLink: updatedItem?.mediaKitLink || null,
      },
    });
  } catch (err) {
    console.error('[updateFolderItemMediaKitLinkVisibility] Error:', err);

    await saveErrorLog(req, err, err?.response?.status || err?.statusCode || err?.status || 500, 'UPDATE_FOLDER_ITEM_MEDIA_KIT_LINK_VISIBILITY_ERROR'); return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.updateFolderItemMediaKitLinkApproval = async (req, res) => {
  try {
    if (!canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({ error: 'You are not allowed to approve media kit link requests' });
    }

    const actorId = getActorAdminId(req.admin);
    const folderId = cleanStr(req.body?.folderId);
    const itemId = cleanStr(req.body?.itemId);
    const action = cleanStr(req.body?.action).toLowerCase();

    if (!mongoose.Types.ObjectId.isValid(folderId) || !mongoose.Types.ObjectId.isValid(itemId)) {
      return res.status(400).json({ error: 'Valid folderId and itemId are required' });
    }

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'action must be approve or reject' });
    }

    const doc = await findAccessibleFolder(folderId, req.admin);
    if (!doc) {
      return res.status(404).json({ error: 'Pitch folder not found' });
    }

    const item = doc.items.id(itemId);
    if (!item) {
      return res.status(404).json({ error: 'Folder item not found' });
    }

    if (!hasMediaKitLink(item.mediaKitLink)) {
      return res.status(400).json({ error: 'No media kit link generated for this influencer yet' });
    }

    if (!item.mediaKitLink) {
      item.mediaKitLink = normalizeMediaKitLink(null, actorId);
    }

    if (action === 'approve') {
      setVisibleMediaKitSource(item, 'link', actorId);
    } else {
      item.mediaKitLink.showToBrand = false;
      item.mediaKitLink.requestStatus = 'rejected';
      item.mediaKitLink.reviewedAt = new Date();
      item.mediaKitLink.reviewedByAdminId = actorId || null;
    }

    item.updatedByAdmin = actorId || null;
    doc.updatedByAdmin = actorId || null;

    const hydrated = await saveAndHydrateFolder(doc);
    const updatedItem = hydrated.items.find((x) => String(x._id) === String(itemId));

    return res.json({
      success: true,
      message: `Media kit link request ${action}d successfully`,
      data: {
        folderId: hydrated._id,
        itemId,
        mediaKitAccess: updatedItem?.mediaKitAccess || null,
        mediaKitLink: updatedItem?.mediaKitLink || null,
      },
    });
  } catch (err) {
    console.error('[updateFolderItemMediaKitLinkApproval] Error:', err);

    await saveErrorLog(req, err, err?.response?.status || err?.statusCode || err?.status || 500, 'UPDATE_FOLDER_ITEM_MEDIA_KIT_LINK_APPROVAL_ERROR'); return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.generateShareLink = async (req, res) => {
  try {
    if (!canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({ error: 'You are not allowed to share pitch folders' });
    }

    const actorId = getActorAdminId(req.admin);
    const id = cleanStr(req.params.id);

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Valid folder id is required' });
    }

    const doc = await findAccessibleFolder(id, req.admin);
    if (!doc) {
      return res.status(404).json({ error: 'Pitch folder not found' });
    }

    const token = crypto.randomBytes(24).toString('hex');
    const url = `${getShareBaseUrl()}/${token}`;

    doc.share = {
      token,
      url,
      generatedAt: new Date(),
      sharedByAdminId: actorId || null,
    };
    doc.updatedByAdmin = actorId || null;

    const hydrated = await saveAndHydrateFolder(doc);

    return res.json({
      success: true,
      message: 'Share link generated successfully',
      data: serializeFolderDetail(hydrated).share,
    });
  } catch (err) {
    console.error('[generateShareLink] Error:', err);

    await saveErrorLog(req, err, err?.response?.status || err?.statusCode || err?.status || 500, 'GENERATE_SHARE_LINK_ERROR'); return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.getSharedFolder = async (req, res) => {
  try {
    const token = cleanStr(req.params.token);

    if (!token) {
      return res.status(400).json({ error: 'Share token is required' });
    }

    const doc = await PitchFolder.findOne({
      'share.token': token,
      archivedAt: null,
    }).lean();

    if (!doc) {
      return res.status(404).json({ error: 'Shared pitch folder not found' });
    }

    const allItems = sortFolderItemsByMediaKitPriority(
      Array.isArray(doc.items) ? doc.items : []
    );

    const configuredVisibleCount =
      doc.brandVisibleItemCount === null || doc.brandVisibleItemCount === undefined
        ? allItems.length
        : Math.max(0, Number(doc.brandVisibleItemCount) || 0);

    const itemsToShow = doc.showFullListToBrand
      ? allItems
      : allItems.slice(0, configuredVisibleCount);

    const sharedItems = await Promise.all(
      itemsToShow.map((item) => serializeFolderItemForShared(item))
    );

    return res.json({
      success: true,
      data: {
        _id: doc._id,
        title: doc.title,
        description: doc.description,
        brandVisibleItemCount: configuredVisibleCount,
        showFullListToBrand: !!doc.showFullListToBrand,
        share: doc.share,
        totalItemCount: allItems.length,
        visibleItemCount: sharedItems.length,
        items: sharedItems,
      },
    });
  } catch (err) {
    console.error('[getSharedFolder] Error:', err);

    await saveErrorLog(req, err, err?.response?.status || err?.statusCode || err?.status || 500, 'GET_SHARED_FOLDER_ERROR'); return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.bulkImportYoutubeToFolder = async (req, res) => {
  try {
    if (!canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({
        error: 'You are not allowed to update pitch folders',
      });
    }

    const actorId = getActorAdminId(req.admin);
    const folderId = cleanStr(req.params.id);
    const rawUsers = Array.isArray(req.body?.rawUsers) ? req.body.rawUsers : [];

    if (!mongoose.Types.ObjectId.isValid(folderId)) {
      return res.status(400).json({
        error: 'Valid folder id is required',
      });
    }

    if (!rawUsers.length) {
      return res.status(400).json({
        error: 'rawUsers are required',
      });
    }

    const folder = await findAccessibleFolder(folderId, req.admin);

    if (!folder) {
      return res.status(404).json({
        error: 'Pitch folder not found',
      });
    }

    const existingKeys = new Set(
      (folder.items || [])
        .map((item) => buildFolderItemDedupeKey(item))
        .filter(Boolean)
    );

    let added = 0;
    let skipped = 0;

    const alreadyAdded = [];
    const missingEmailUsers = [];
    const skippedInvalidUsers = [];
    const signedUpMatchedUsers = [];
    const addedWithoutEmailUsers = [];

    for (const user of rawUsers) {
      const provider = normalizeProvider(user.platform || user.provider || 'youtube');

      const rawHandle = cleanStr(
        user.handle ||
        user.username ||
        user.handleId ||
        user.channelHandle ||
        ''
      ).replace(/^@+/, '');

      const normalizedHandle = rawHandle ? `@${rawHandle}` : '';

      const channelId = cleanStr(
        user.channelId ||
        user.userId ||
        user.sourceRefId ||
        user.modashUserId ||
        ''
      );

      const profileUrl = cleanStr(
        user.url ||
        user.profileUrl ||
        user.primaryLink ||
        user.link ||
        ''
      );

      const rawLinks = Array.isArray(user.links)
        ? user.links
        : profileUrl
          ? [profileUrl]
          : [];

      const categories = Array.isArray(user.categories)
        ? user.categories
        : Array.isArray(user.niche)
          ? user.niche
          : [];

      const baseBody = {
        provider,
        platform: provider,

        name: cleanStr(
          user.fullname ||
          user.fullName ||
          user.name ||
          user.title ||
          normalizedHandle
        ),

        handle: normalizedHandle,
        username: rawHandle,
        channelHandle: normalizedHandle,

        channelId,
        userId: cleanStr(user.userId || channelId),
        sourceRefId: cleanStr(user.sourceRefId || channelId),
        modashUserId: cleanStr(user.modashUserId || ''),

        followers: toNullableNumber(
          user.followers ||
          user.followersCount ||
          user.subscribers ||
          user.subscriberCount
        ),

        primaryLink: profileUrl,
        links: uniqStrings(rawLinks),

        niche: uniqStrings(categories),
        country: cleanStr(user.country || user.countryName || ''),
        email: cleanStr(user.email || '').toLowerCase(),

        selectionReason: cleanStr(user.selectionReason || ''),
        goodFit: !!user.goodFit,

        influencerRateCard: cleanStr(user.influencerRateCard || ''),
        platformRateCard: cleanStr(user.platformRateCard || ''),
        rateCardCurrency: cleanStr(user.rateCardCurrency || 'USD').toUpperCase(),
        ourFeePct: toNullableNumber(user.ourFeePct),
        shippingAddress: cleanStr(user.shippingAddress || user.comments || ''),
      };

      const enrichedBody = await enrichPitchFolderItemBodyWithProfileEmail(baseBody);

      const item = {
        ...normalizeItem(enrichedBody, actorId),
        createdByAdmin: actorId || null,
        updatedByAdmin: actorId || null,
      };

      if (!item.name) {
        skipped += 1;
        skippedInvalidUsers.push({
          handle: normalizedHandle,
          channelId,
          reason: 'Influencer name is missing',
        });
        continue;
      }

      const dedupeKey = buildFolderItemDedupeKey(item);

      if (!dedupeKey) {
        skipped += 1;
        skippedInvalidUsers.push({
          name: item.name,
          handle: normalizedHandle,
          channelId,
          reason: 'Could not create duplicate-check key',
        });
        continue;
      }

      if (existingKeys.has(dedupeKey)) {
        skipped += 1;
        alreadyAdded.push(item.handle || item.name);
        continue;
      }

      if (enrichedBody.isSignedUpInfluencer && enrichedBody.signedUpInfluencerId) {
        signedUpMatchedUsers.push({
          influencerId: enrichedBody.signedUpInfluencerId,
          name: item.name,
          email: item.email,
          handle: item.handle,
          provider: item.provider,
        });
      }

      if (!item.email) {
        addedWithoutEmailUsers.push({
          name: item.name,
          handle: item.handle || normalizedHandle,
          channelId,
          provider: item.provider,
        });
      }

      folder.items.push(item);
      existingKeys.add(dedupeKey);
      added += 1;
    }

    folder.updatedByAdmin = actorId || null;

    const hydrated = await saveAndHydrateFolder(folder);

    const message =
      added > 0
        ? 'Youtube creators imported successfully'
        : alreadyAdded.length > 0
          ? 'All selected Youtube creators are already added in this folder'
          : 'No Youtube creators were imported';

    return res.json({
      success: true,
      message,
      added,
      skipped,
      alreadyAdded: uniqStrings(alreadyAdded),
      missingEmailUsers,
      skippedInvalidUsers,
      signedUpMatchedUsers,
      addedWithoutEmailUsers,
      total: hydrated?.items?.length || 0,
      data: serializeFolderDetail(hydrated),
    });
  } catch (err) {
    console.error('[bulkImportYoutubeToFolder] Error:', err);

    await saveErrorLog(req, err, err?.response?.status || err?.statusCode || err?.status || 500, 'BULK_IMPORT_YOUTUBE_TO_FOLDER_ERROR'); return res.status(500).json({
      error: err?.message || 'Internal error',
    });
  }
};

exports.updateSharedFolderGoodFit = async (req, res) => {
  try {
    const token = cleanStr(req.params.token);
    const itemId = cleanStr(req.params.itemId);
    const goodFit = !!req.body?.goodFit;

    if (!token) {
      return res.status(400).json({ error: 'Share token is required' });
    }

    if (!itemId || !mongoose.Types.ObjectId.isValid(itemId)) {
      return res.status(400).json({ error: 'Valid item id is required' });
    }

    const doc = await PitchFolder.findOne({
      'share.token': token,
      archivedAt: null,
    });

    if (!doc) {
      return res.status(404).json({ error: 'Shared pitch folder not found' });
    }

    const item = doc.items.id(itemId);
    if (!item) {
      return res.status(404).json({ error: 'Folder item not found' });
    }

    if (hasAssignedCampaign(doc) && item.goodFit === true && goodFit === false) {
      return res.status(400).json({
        success: false,
        error:
          'Campaign is already assigned. You cannot mark an existing Good Fit influencer as Unfit.',
      });
    }

    item.goodFit = goodFit;
    await doc.save();

    return res.json({
      success: true,
      message: 'Good fit updated successfully',
      data: {
        _id: item._id,
        goodFit: item.goodFit,
      },
    });
  } catch (err) {
    console.error('[updateSharedFolderGoodFit] Error:', err);

    await saveErrorLog(req, err, err?.response?.status || err?.statusCode || err?.status || 500, 'UPDATE_SHARED_FOLDER_GOOD_FIT_ERROR'); return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.requestSharedFolderMediaKit = async (req, res) => {
  try {
    const token = cleanStr(req.params.token);
    const itemId = cleanStr(req.params.itemId);

    if (!token) {
      return res.status(400).json({ error: 'Share token is required' });
    }

    if (!itemId || !mongoose.Types.ObjectId.isValid(itemId)) {
      return res.status(400).json({ error: 'Valid item id is required' });
    }

    const doc = await PitchFolder.findOne({
      'share.token': token,
      archivedAt: null,
    });

    if (!doc) {
      return res.status(404).json({ error: 'Shared pitch folder not found' });
    }

    const item = doc.items.id(itemId);
    if (!item) {
      return res.status(404).json({ error: 'Folder item not found' });
    }

    ensureSingleSharedMediaKit(item);
    ensureGenericRequestConsistency(item);

    // if already visible to brand, no need to request
    if (item.mediaKit?.showToBrand || item.mediaKitLink?.showToBrand) {
      return res.json({
        success: true,
        message: 'Media kit is already available',
        data: {
          _id: item._id,
          requestStatus: 'approved',
          requestedAt: getGenericMediaKitRequestedAt(item),
          buttonLabel: '',
        },
      });
    }

    const now = new Date();
    const source = getPreferredMediaKitSource(item);

    // if one source exists, mark request on that source
    if (source === 'pdf') {
      item.mediaKit.requestStatus = 'requested';
      item.mediaKit.requestedAt = now;
    } else if (source === 'link') {
      item.mediaKitLink.requestStatus = 'requested';
      item.mediaKitLink.requestedAt = now;
    } else {
      // nothing added yet, but still allow brand request
      // store a generic request on mediaKit bucket by default
      if (!item.mediaKit) {
        item.mediaKit = normalizeMediaKit(null, null);
      }

      item.mediaKit.requestStatus = 'requested';
      item.mediaKit.requestedAt = now;
    }

    await doc.save();

    return res.json({
      success: true,
      message: 'Media kit request sent successfully',
      data: {
        _id: item._id,
        requestStatus: 'requested',
        requestedAt: getGenericMediaKitRequestedAt(item),
        buttonLabel: 'Requested',
      },
    });
  } catch (err) {
    console.error('[requestSharedFolderMediaKit] Error:', err);

    await saveErrorLog(req, err, err?.response?.status || err?.statusCode || err?.status || 500, 'REQUEST_SHARED_FOLDER_MEDIA_KIT_ERROR'); return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

function getMediaKitPriorityScore(item) {
  const hasAnyMediaKit = hasStoredMediaKit(item?.mediaKit) || hasMediaKitLink(item?.mediaKitLink);
  const visibleSource = getVisibleMediaKitSource(item);
  const requestStatus = getGenericMediaKitRequestStatus(item);

  if (visibleSource) return 4;
  if (hasAnyMediaKit) return 3;
  if (requestStatus === 'requested') return 2;
  return 1;
}

function sortFolderItemsByMediaKitPriority(items = []) {
  return [...items].sort((a, b) => {
    const scoreDiff = getMediaKitPriorityScore(b) - getMediaKitPriorityScore(a);
    if (scoreDiff !== 0) return scoreDiff;

    return 0;
  });
}

exports.moveFolderItems = async (req, res) => {
  try {
    if (!canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({
        error: 'You are not allowed to move influencers between pitch folders',
      });
    }

    const actorId = getActorAdminId(req.admin);
    const sourceFolderId = cleanStr(req.body?.sourceFolderId || req.body?.folderId);
    const destinationFolderId = cleanStr(req.body?.destinationFolderId);

    const transferType = cleanStr(
      req.body?.transferType || req.body?.mode || 'move'
    ).toLowerCase();

    const isCopyOnly = ['copy', 'copy_move', 'copy-move', 'copyandmove'].includes(
      transferType
    );
    const isDirectMove = ['move', 'direct_move', 'direct-move'].includes(
      transferType
    );

    const itemIds = Array.isArray(req.body?.itemIds)
      ? uniqStrings(req.body.itemIds).filter((id) =>
        mongoose.Types.ObjectId.isValid(String(id))
      )
      : [];

    if (!isCopyOnly && !isDirectMove) {
      return res.status(400).json({
        error:
          'transferType must be one of: copy, move, direct_move, copy_move',
      });
    }

    if (!mongoose.Types.ObjectId.isValid(sourceFolderId)) {
      return res.status(400).json({ error: 'Valid sourceFolderId is required' });
    }

    if (!mongoose.Types.ObjectId.isValid(destinationFolderId)) {
      return res.status(400).json({
        error: 'Valid destinationFolderId is required',
      });
    }

    if (String(sourceFolderId) === String(destinationFolderId)) {
      return res.status(400).json({
        error: 'Source and destination folder cannot be the same',
      });
    }

    if (!itemIds.length) {
      return res.status(400).json({
        error: 'At least one valid itemId is required',
      });
    }

    const sourceFolder = await findAccessibleFolder(sourceFolderId, req.admin);
    if (!sourceFolder) {
      return res.status(404).json({ error: 'Source pitch folder not found' });
    }

    const destinationFolder = await findAccessibleFolder(
      destinationFolderId,
      req.admin
    );
    if (!destinationFolder) {
      return res
        .status(404)
        .json({ error: 'Destination pitch folder not found' });
    }

    const destinationExistingKeys = new Set(
      (destinationFolder.items || []).map((item) => buildFolderItemDedupeKey(item)).filter(Boolean)
    );

    const skippedMissingItemIds = [];
    const skippedDuplicateItemIds = [];
    let copiedCount = 0;
    let movedCount = 0;

    for (const itemId of itemIds) {
      const sourceItem = sourceFolder.items.id(itemId);

      if (!sourceItem) {
        skippedMissingItemIds.push(itemId);
        continue;
      }

      const itemKey = buildFolderItemDedupeKey(sourceItem);

      if (itemKey && destinationExistingKeys.has(itemKey)) {
        skippedDuplicateItemIds.push(itemId);
        continue;
      }

      if (isCopyOnly) {
        const copiedItem = cloneFolderItemForTransfer(sourceItem, actorId);
        destinationFolder.items.push(copiedItem);
        copiedCount += 1;
      } else {
        const movedItem =
          typeof sourceItem.toObject === 'function'
            ? sourceItem.toObject()
            : { ...sourceItem };

        movedItem.updatedByAdmin = actorId || null;

        destinationFolder.items.push(movedItem);
        sourceItem.deleteOne();
        movedCount += 1;
      }

      if (itemKey) {
        destinationExistingKeys.add(itemKey);
      }
    }

    const processedCount = isCopyOnly ? copiedCount : movedCount;

    if (!processedCount) {
      return res.status(400).json({
        error: `No influencers were ${isCopyOnly ? 'copied' : 'moved'}`,
        data: {
          action: isCopyOnly ? 'copy' : 'move',
          copiedCount,
          movedCount,
          skippedMissingItemIds,
          skippedDuplicateItemIds,
        },
      });
    }

    destinationFolder.updatedByAdmin = actorId || null;
    await destinationFolder.save();

    if (!isCopyOnly) {
      sourceFolder.updatedByAdmin = actorId || null;
      await sourceFolder.save();
    }

    const [sourceHydrated, destinationHydrated] = await Promise.all([
      PitchFolder.findById(sourceFolder._id)
        .populate(buildCreatorPopulate())
        .populate(buildUpdatedByPopulate())
        .populate(buildSharedByPopulate())
        .lean(),
      PitchFolder.findById(destinationFolder._id)
        .populate(buildCreatorPopulate())
        .populate(buildUpdatedByPopulate())
        .populate(buildSharedByPopulate())
        .lean(),
    ]);

    return res.json({
      success: true,
      message: `Selected influencers ${isCopyOnly ? 'copied' : 'moved'
        } successfully`,
      data: {
        action: isCopyOnly ? 'copy' : 'move',
        copiedCount,
        movedCount,
        skippedMissingItemIds,
        skippedDuplicateItemIds,
        sourceFolder: serializeFolderDetail(sourceHydrated),
        destinationFolder: serializeFolderListItem(destinationHydrated),
      },
    });
  } catch (err) {
    console.error('[moveFolderItems] Error:', err);

    await saveErrorLog(req, err, err?.response?.status || err?.statusCode || err?.status || 500, 'MOVE_FOLDER_ITEMS_ERROR'); return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

async function findInfluencerForFolderItem(item = {}) {
  return findSignedUpInfluencerForSource(item);
}

function buildActiveApplicantPatch({ influencer, item, folder, actorId, now }) {
  return {
    'applicants.$.name': influencer.name || item.name || '',
    'applicants.$.isShortlisted': 0,
    'applicants.$.isUndicided': 0,
    'applicants.$.isRejected': 0,
    'applicants.$.isActive': 1,
    'applicants.$.statusBrand': 'active',
    'applicants.$.statusInfluencer': 'active',
    'applicants.$.brandStatus': 'active',
    'applicants.$.influencerStatus': 'active',
    'applicants.$.activeSource': 'pitch_folder_assignment',
    'applicants.$.activeAt': now,
    'applicants.$.pitchFolderId': String(folder._id),
    'applicants.$.pitchFolderItemId': String(item._id),
    'applicants.$.assignedByAdminId': actorId ? String(actorId) : null,
  };
}

function buildActiveApplicantPush({ influencer, item, folder, actorId, now }) {
  return {
    influencerId: String(influencer._id),
    name: influencer.name || item.name || '',
    isShortlisted: 0,
    isUndicided: 0,
    isRejected: 0,
    isActive: 1,
    statusBrand: 'active',
    statusInfluencer: 'active',
    brandStatus: 'active',
    influencerStatus: 'active',
    activeSource: 'pitch_folder_assignment',
    activeAt: now,
    appliedAt: now,
    pitchFolderId: String(folder._id),
    pitchFolderItemId: String(item._id),
    assignedByAdminId: actorId ? String(actorId) : null,
  };
}

async function updateCampaignApplicantCount(campaign) {
  const campaignId = String(campaign?._id || '').trim();

  const applyRecord = await ApplyCampaign.findOne({ campaignId })
    .select('applicants')
    .lean();

  const applicantCount = Array.isArray(applyRecord?.applicants)
    ? applyRecord.applicants.length
    : 0;

  await Campaign.updateOne(
    { _id: campaign._id },
    {
      $set: {
        applicantCount,
        hasApplied: applicantCount > 0 ? 1 : 0,
      },
    }
  );

  return applicantCount;
}

async function upsertFolderItemAsActiveApplicant({ folder, campaign, item, influencer, actorId }) {
  const campaignId = String(campaign?._id || '').trim();
  const influencerId = String(influencer?._id || '').trim();
  const now = new Date();

  if (!campaignId || !influencerId) {
    return { added: false, updated: false, alreadyActive: false };
  }

  const existingApplyRecord = await ApplyCampaign.findOne(
    { campaignId, 'applicants.influencerId': influencerId },
    { 'applicants.$': 1 }
  ).lean();

  const existingApplicant = Array.isArray(existingApplyRecord?.applicants)
    ? existingApplyRecord.applicants[0]
    : null;

  const alreadyActive = isActiveCampaignApplicant(existingApplicant || {});

  const updateExisting = await ApplyCampaign.updateOne(
    { campaignId, 'applicants.influencerId': influencerId },
    { $set: buildActiveApplicantPatch({ influencer, item, folder, actorId, now }) }
  );

  if (Number(updateExisting.matchedCount || updateExisting.n || 0) > 0) {
    return { added: false, updated: !alreadyActive, alreadyActive };
  }

  await ApplyCampaign.updateOne(
    { campaignId },
    {
      $setOnInsert: { campaignId },
      $push: { applicants: buildActiveApplicantPush({ influencer, item, folder, actorId, now }) },
    },
    { upsert: true }
  );

  return { added: true, updated: false, alreadyActive: false };
}

async function syncFolderGoodFitsToActiveCampaign({ folder, campaign, actorId }) {
  const campaignId = String(campaign?._id || '').trim();

  if (!folder || !campaignId) {
    return {
      goodFitCount: 0,
      matchedInfluencerCount: 0,
      addedCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      applicantCount: 0,
      skippedItems: [],
    };
  }

  const now = new Date();
  const goodFitItems = (Array.isArray(folder.items) ? folder.items : []).filter(
    (item) => item && item.goodFit === true
  );

  let addedCount = 0;
  let updatedCount = 0;
  const matchedInfluencerIds = new Set();
  const skippedItems = [];

  for (const item of goodFitItems) {
    const influencer = await findInfluencerForFolderItem(item);

    if (!influencer?._id) {
      skippedItems.push({
        itemId: String(item?._id || ''),
        name: cleanStr(item?.name),
        email: cleanStr(item?.email),
        handle: cleanStr(item?.handle),
        reason: 'Influencer record not found. Create the influencer first, then assign/sync again.',
      });
      continue;
    }

    const influencerId = String(influencer._id);
    matchedInfluencerIds.add(influencerId);

    const applicantPatch = {
      'applicants.$.name': influencer.name || item.name || '',
      'applicants.$.isShortlisted': 0,
      'applicants.$.isUndicided': 0,
      'applicants.$.isRejected': 0,
      'applicants.$.isActive': 1,
      'applicants.$.statusBrand': 'active',
      'applicants.$.statusInfluencer': 'active',
      'applicants.$.brandStatus': 'active',
      'applicants.$.influencerStatus': 'active',
      'applicants.$.activeSource': 'pitch_folder_assignment',
      'applicants.$.activeAt': now,
      'applicants.$.pitchFolderId': String(folder._id),
      'applicants.$.pitchFolderItemId': String(item._id),
      'applicants.$.assignedByAdminId': actorId ? String(actorId) : null,
    };

    const updateExisting = await ApplyCampaign.updateOne(
      {
        campaignId,
        'applicants.influencerId': influencerId,
      },
      { $set: applicantPatch }
    );

    if (Number(updateExisting.matchedCount || updateExisting.n || 0) > 0) {
      updatedCount += 1;
      continue;
    }

    await ApplyCampaign.updateOne(
      { campaignId },
      {
        $setOnInsert: { campaignId },
        $push: {
          applicants: {
            influencerId,
            name: influencer.name || item.name || '',
            isShortlisted: 0,
            isUndicided: 0,
            isRejected: 0,
            isActive: 1,
            statusBrand: 'active',
            statusInfluencer: 'active',
            brandStatus: 'active',
            influencerStatus: 'active',
            activeSource: 'pitch_folder_assignment',
            activeAt: now,
            appliedAt: now,
            pitchFolderId: String(folder._id),
            pitchFolderItemId: String(item._id),
            assignedByAdminId: actorId ? String(actorId) : null,
          },
        },
      },
      { upsert: true }
    );

    addedCount += 1;
  }

  const applyRecord = await ApplyCampaign.findOne({ campaignId })
    .select('applicants')
    .lean();

  const applicantCount = Array.isArray(applyRecord?.applicants)
    ? applyRecord.applicants.length
    : 0;

  await Campaign.updateOne(
    { _id: campaign._id },
    {
      $set: {
        applicantCount,
        hasApplied: applicantCount > 0 ? 1 : 0,
      },
    }
  );

  return {
    goodFitCount: goodFitItems.length,
    matchedInfluencerCount: matchedInfluencerIds.size,
    addedCount,
    updatedCount,
    skippedCount: skippedItems.length,
    applicantCount,
    skippedItems,
  };
}

exports.activateFolderItemOnAssignedCampaign = async (req, res) => {
  try {
    if (!canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({ success: false, error: 'You are not allowed to activate pitch folder influencers on campaigns' });
    }

    const actorId = getActorAdminId(req.admin);
    const folderId = cleanStr(req.params?.id || req.body?.folderId);
    const itemId = cleanStr(req.params?.itemId || req.body?.itemId);

    if (!mongoose.Types.ObjectId.isValid(folderId) || !mongoose.Types.ObjectId.isValid(itemId)) {
      return res.status(400).json({ success: false, error: 'Valid folderId and itemId are required' });
    }

    const folder = await findAccessibleFolder(folderId, req.admin);
    if (!folder) return res.status(404).json({ success: false, error: 'Pitch folder not found' });

    if (!hasAssignedCampaign(folder)) {
      return res.status(400).json({ success: false, error: 'Assign a campaign to this pitch folder first' });
    }

    const item = folder.items.id(itemId);
    if (!item) return res.status(404).json({ success: false, error: 'Folder item not found' });

    const campaignLookupId = cleanStr(folder.assignedCampaign?.campaignsId) || getAssignedCampaignIdString(folder.assignedCampaign);
    const campaign = await findCampaignByAnyIdForAssignment(campaignLookupId);
    if (!campaign) return res.status(404).json({ success: false, error: 'Assigned campaign not found' });

    const influencer = await findInfluencerForFolderItem(item);
    if (!influencer?._id) {
      return res.status(400).json({
        success: false,
        error: 'Influencer account not found. Create the influencer first, then activate on campaign.',
      });
    }

    const activation = await upsertFolderItemAsActiveApplicant({ folder, campaign, item, influencer, actorId });
    const now = new Date();

    item.goodFit = true;
    item.campaignActivation = {
      campaignId: campaign._id,
      campaignsId: cleanStr(campaign.campaignsId),
      influencerId: influencer._id,
      activeAt: now,
      activatedByAdminId: actorId && mongoose.Types.ObjectId.isValid(String(actorId))
        ? new mongoose.Types.ObjectId(String(actorId))
        : null,
    };
    item.updatedByAdmin = actorId || null;
    folder.updatedByAdmin = actorId || null;

    await updateCampaignApplicantCount(campaign);
    const hydrated = await saveAndHydrateFolder(folder);

    return res.json({
      success: true,
      message: activation.alreadyActive
        ? 'Influencer is already active on this campaign.'
        : 'Influencer activated on campaign successfully.',
      data: {
        folderId: String(hydrated._id),
        itemId,
        campaignId: String(campaign._id),
        campaignsId: cleanStr(campaign.campaignsId),
        influencerId: String(influencer._id),
        alreadyActive: activation.alreadyActive,
        added: activation.added,
        updated: activation.updated,
        assignedCampaign: serializeAssignedCampaign(hydrated.assignedCampaign),
        folder: await serializeFolderDetailWithCampaignState(hydrated),
      },
    });
  } catch (err) {
    console.error('[activateFolderItemOnAssignedCampaign] Error:', err);

    await saveErrorLog(req, err, err?.response?.status || err?.statusCode || err?.status || 500, 'ACTIVATE_FOLDER_ITEM_ON_ASSIGNED_CAMPAIGN_ERROR'); return res.status(500).json({ success: false, error: err?.message || 'Internal error' });
  }
};

exports.assignCampaignToFolder = async (req, res) => {
  try {
    if (!canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({
        success: false,
        error: 'You are not allowed to assign campaigns to pitch folders',
      });
    }

    const actorId = getActorAdminId(req.admin);
    const folderId = cleanStr(req.body?.folderId || req.body?.id);
    const rawCampaignId = cleanStr(req.body?.campaignId);

    if (!mongoose.Types.ObjectId.isValid(folderId)) {
      return res.status(400).json({
        success: false,
        error: 'Valid folderId is required',
      });
    }

    if (!rawCampaignId) {
      return res.status(400).json({
        success: false,
        error: 'campaignId is required',
      });
    }

    const folder = await findAccessibleFolder(folderId, req.admin);

    if (!folder) {
      return res.status(404).json({
        success: false,
        error: 'Pitch folder not found',
      });
    }

    const campaign = await findCampaignByAnyIdForAssignment(rawCampaignId);

    if (!campaign) {
      return res.status(404).json({
        success: false,
        error: 'Campaign not found',
      });
    }

    const assignedCampaign = folder.assignedCampaign || {};
    let hydrated = null;
    let alreadyAssignedToSameCampaign = false;

    if (hasAssignedCampaign(folder)) {
      const currentCampaignObjectId = String(assignedCampaign.campaignId?._id || assignedCampaign.campaignId || '');
      const nextCampaignObjectId = String(campaign._id || '');
      const currentCampaignsId = cleanStr(assignedCampaign.campaignsId);
      const nextCampaignsId = cleanStr(campaign.campaignsId);

      const isSameCampaign =
        currentCampaignObjectId === nextCampaignObjectId ||
        (!!currentCampaignsId && !!nextCampaignsId && currentCampaignsId === nextCampaignsId);

      if (!isSameCampaign) {
        return res.status(409).json({
          success: false,
          error: 'This pitch folder is already assigned to another campaign and cannot be assigned again',
          data: {
            folderId: String(folder._id),
            assignedCampaign: serializeAssignedCampaign(assignedCampaign),
          },
        });
      }

      alreadyAssignedToSameCampaign = true;
      hydrated = folder;
    } else {
      folder.assignedCampaign = buildAssignedCampaignPayload(campaign, actorId);
      folder.updatedByAdmin = actorId || null;
      hydrated = await saveAndHydrateFolder(folder);
    }

    const syncResult = await syncFolderGoodFitsToActiveCampaign({
      folder: hydrated,
      campaign,
      actorId,
    });

    if (alreadyAssignedToSameCampaign) {
      hydrated = await PitchFolder.findById(folder._id)
        .populate(buildCreatorPopulate())
        .populate(buildUpdatedByPopulate())
        .populate(buildSharedByPopulate())
        .lean();
    }

    return res.json({
      success: true,
      message: alreadyAssignedToSameCampaign
        ? 'Pitch folder is already assigned to this campaign. Good Fit influencers synced to Active.'
        : 'Campaign assigned to pitch folder and Good Fit influencers synced to Active.',
      data: {
        folderId: String(hydrated._id),
        assignedCampaign: serializeAssignedCampaign(hydrated.assignedCampaign),
        syncResult,
        folder: await serializeFolderDetailWithCampaignState(hydrated),
      },
    });
  } catch (err) {
    console.error('[assignCampaignToFolder] Error:', err);

    await saveErrorLog(req, err, err?.response?.status || err?.statusCode || err?.status || 500, 'ASSIGN_CAMPAIGN_TO_FOLDER_ERROR'); return res.status(500).json({
      success: false,
      error: err?.message || 'Internal error',
    });
  }
};

const getInfluencerUniqueKey = (item = {}) => {
  const influencerId = cleanStr(
    item.influencerId ||
    item.creatorId ||
    item.influencer?._id ||
    item.creator?._id
  );

  if (influencerId) return `influencer:${influencerId}`;

  const email = cleanStr(item.email).toLowerCase();
  if (email) return `email:${email}`;

  const primaryLink = cleanStr(
    item.primaryLink || item.profileUrl || item.url || item.links?.[0]
  )
    .toLowerCase()
    .replace(/\/+$/, "");

  if (primaryLink) return `link:${primaryLink}`;

  const provider = cleanStr(item.provider || item.platform).toLowerCase();
  const handle = cleanStr(item.handle || item.username)
    .toLowerCase()
    .replace(/^@+/, "");

  if (provider || handle) return `handle:${provider}:${handle}`;

  const name = cleanStr(item.name).toLowerCase();
  if (name) return `name:${name}:${provider}`;

  return `item:${String(item._id || "")}`;
};


exports.getCampaignGoodFitList = async (req, res) => {
  try {
    const brandId = getAuthedBrandId(req);
    const rawCampaignId = cleanStr(req.params?.campaignId || req.query?.campaignId);

    if (!brandId) {
      return res.status(401).json({
        success: false,
        error: 'Brand authentication is required',
      });
    }

    if (!rawCampaignId) {
      return res.status(400).json({
        success: false,
        error: 'campaignId is required',
      });
    }

    const campaign = await findCampaignByAnyIdForAssignment(rawCampaignId);

    if (!campaign) {
      return res.status(404).json({
        success: false,
        error: 'Campaign not found',
      });
    }

    if (!assertBrandCanUseCampaign(campaign, brandId)) {
      return res.status(403).json({
        success: false,
        error: 'This campaign does not belong to the authenticated brand',
      });
    }

    const campaignOr = buildAssignedCampaignMatchOr(rawCampaignId, campaign);

    if (!campaignOr.length) {
      return res.status(400).json({
        success: false,
        error: 'Could not build campaign lookup',
      });
    }

    const folderFilter = applyBrandScopeToFilter(
      {
        archivedAt: null,
        $or: campaignOr,
        'items.goodFit': true,
      },
      brandId
    );

    const docs = await PitchFolder.find(folderFilter)
      .sort({ updatedAt: -1 })
      .lean();

    const campaignPayload = {
      campaignId: String(campaign._id),
      campaignsId: cleanStr(campaign.campaignsId),
      campaignTitle: cleanStr(campaign.campaignTitle),
      productOrServiceName: cleanStr(campaign.productOrServiceName),
      brandId: cleanStr(campaign.brandId),
      brandName: cleanStr(campaign.brandName),
      assignedAt: null,
    };

    if (!docs.length) {
      return res.json({
        success: true,
        message: 'No good fit influencers found for this campaign',
        data: {
          campaign: campaignPayload,
          totalFolderCount: 0,
          totalCampaignCount: 1,
          totalGoodFitCount: 0,
          campaigns: [campaignPayload],
          folders: [],
          items: [],
        },
      });
    }

    const folders = [];
    const uniqueInfluencersMap = new Map();

    for (const doc of docs) {
      const allItems = sortFolderItemsByMediaKitPriority(
        Array.isArray(doc.items) ? doc.items : []
      );

      const goodFitItems = allItems.filter((item) => item?.goodFit === true);

      const assignedCampaign = serializeAssignedCampaign(doc.assignedCampaign);

      const folderCampaignPayload = {
        ...campaignPayload,
        assignedAt: assignedCampaign?.assignedAt || null,
        folderId: String(doc._id),
        folderTitle: doc.title || '',
        folderSlug: doc.slug || '',
      };

      const serializedItems = await Promise.all(
        goodFitItems.map((item) => serializeFolderItemForShared(item))
      );

      const folderPayload = {
        _id: String(doc._id),
        title: doc.title || '',
        slug: doc.slug || '',
        description: doc.description || '',
        brandId: cleanStr(doc.brandId || doc.brandRef || brandId),
        assignedCampaign,
      };

      folders.push({
        ...folderPayload,
        totalItemCount: allItems.length,
        goodFitCount: serializedItems.length,
        items: serializedItems.map((item) => ({
          ...item,
          folder: folderPayload,
          relatedCampaigns: [folderCampaignPayload],
          relatedCampaignCount: 1,
          relatedFolders: [folderPayload],
          relatedFolderCount: 1,
        })),
      });

      for (let i = 0; i < goodFitItems.length; i += 1) {
        const originalItem = goodFitItems[i];
        const serializedItem = serializedItems[i];

        const uniqueKey = getInfluencerUniqueKey({
          ...originalItem,
          ...serializedItem,
        });

        if (!uniqueInfluencersMap.has(uniqueKey)) {
          uniqueInfluencersMap.set(uniqueKey, {
            ...serializedItem,
            folder: folderPayload,
            relatedCampaigns: [folderCampaignPayload],
            relatedCampaignCount: 1,
            relatedFolders: [folderPayload],
            relatedFolderCount: 1,
          });
        }
      }
    }

    const items = Array.from(uniqueInfluencersMap.values());

    return res.json({
      success: true,
      message: 'Campaign good fit influencers fetched successfully',
      data: {
        campaign: campaignPayload,
        totalFolderCount: folders.length,
        totalCampaignCount: 1,
        totalGoodFitCount: items.length,
        campaigns: [campaignPayload],
        folders,
        items,
      },
    });
  } catch (err) {
    console.error('[getCampaignGoodFitList] Error:', err);


    await saveErrorLog(req, err, err?.response?.status || err?.statusCode || err?.status || 500, 'GET_CAMPAIGN_GOOD_FIT_LIST_ERROR'); return res.status(500).json({
      success: false,
      error: err?.message || 'Internal error',
    });
  }
};

exports.getFolderGoodFitListAll = async (req, res) => {
  try {
    const hasAdminScope = !!req.admin;
    const authedBrandId = getAuthedBrandId(req);
    const brandId = getRequestedBrandId(req);

    if (!hasAdminScope && !authedBrandId) {
      return res.status(401).json({
        success: false,
        error: 'Brand authentication is required',
      });
    }

    if (hasAdminScope && !canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({
        success: false,
        error: 'You are not allowed to access good fit influencers',
      });
    }

    const folderFilter = brandId
      ? buildBrandScopedPitchFolderFilter(brandId)
      : { archivedAt: null };

    folderFilter['items.goodFit'] = true;

    const docs = await PitchFolder.find(folderFilter)
      .sort({ updatedAt: -1 })
      .lean();

    if (!docs.length) {
      return res.json({
        success: true,
        message: 'No good fit influencers found',
        data: {
          totalFolderCount: 0,
          totalCampaignCount: 0,
          totalGoodFitCount: 0,
          items: [],
          folders: [],
          campaigns: [],
        },
      });
    }

    const folders = [];
    const campaignsMap = new Map();
    const uniqueInfluencersMap = new Map();

    for (const doc of docs) {
      const allItems = sortFolderItemsByMediaKitPriority(
        Array.isArray(doc.items) ? doc.items : []
      );

      const goodFitItems = allItems.filter((item) => item?.goodFit === true);

      const assignedCampaign =
        typeof serializeAssignedCampaign === 'function'
          ? serializeAssignedCampaign(doc.assignedCampaign)
          : doc.assignedCampaign || null;

      const campaignId = cleanStr(
        assignedCampaign?.campaignId ||
        assignedCampaign?.campaignsId ||
        assignedCampaign?._id
      );

      const campaignPayload = assignedCampaign
        ? {
          campaignId: cleanStr(assignedCampaign.campaignId),
          campaignsId: cleanStr(assignedCampaign.campaignsId),
          campaignTitle: cleanStr(assignedCampaign.campaignTitle),
          productOrServiceName: cleanStr(
            assignedCampaign.productOrServiceName
          ),
          brandId: cleanStr(assignedCampaign.brandId || brandId),
          brandName: cleanStr(assignedCampaign.brandName),
          assignedAt: assignedCampaign.assignedAt || null,
          folderId: String(doc._id),
          folderTitle: doc.title || '',
          folderSlug: doc.slug || '',
        }
        : {
          campaignId: '',
          campaignsId: '',
          campaignTitle: '',
          productOrServiceName: '',
          brandId: cleanStr(doc.brandId || doc.brandRef || brandId),
          brandName: '',
          assignedAt: null,
          folderId: String(doc._id),
          folderTitle: doc.title || '',
          folderSlug: doc.slug || '',
        };

      const campaignMapKey = campaignId || `folder:${String(doc._id)}`;

      if (!campaignsMap.has(campaignMapKey)) {
        campaignsMap.set(campaignMapKey, campaignPayload);
      }

      const serializedItems = await Promise.all(
        goodFitItems.map((item) => serializeFolderItemForShared(item))
      );

      const folderItems = serializedItems.map((item) => ({
        ...item,
        relatedCampaigns: [campaignPayload],
        relatedCampaignCount: 1,
      }));

      folders.push({
        _id: String(doc._id),
        title: doc.title || '',
        slug: doc.slug || '',
        description: doc.description || '',
        brandId: cleanStr(doc.brandId || doc.brandRef || campaignPayload.brandId),
        assignedCampaign,
        totalItemCount: allItems.length,
        goodFitCount: serializedItems.length,
        items: folderItems,
      });

      for (let i = 0; i < goodFitItems.length; i += 1) {
        const originalItem = goodFitItems[i];
        const serializedItem = serializedItems[i];

        const uniqueKey = getInfluencerUniqueKey({
          ...originalItem,
          ...serializedItem,
        });

        const folderPayload = {
          _id: String(doc._id),
          title: doc.title || '',
          slug: doc.slug || '',
          description: doc.description || '',
          brandId: cleanStr(doc.brandId || doc.brandRef || campaignPayload.brandId),
          assignedCampaign,
        };

        if (!uniqueInfluencersMap.has(uniqueKey)) {
          uniqueInfluencersMap.set(uniqueKey, {
            ...serializedItem,
            folder: folderPayload,
            relatedCampaigns: [],
            relatedCampaignCount: 0,
            relatedFolders: [],
            relatedFolderCount: 0,
            _campaignKeys: new Set(),
            _folderKeys: new Set(),
          });
        }

        const existing = uniqueInfluencersMap.get(uniqueKey);

        if (!existing._campaignKeys.has(campaignMapKey)) {
          existing._campaignKeys.add(campaignMapKey);
          existing.relatedCampaigns.push(campaignPayload);
          existing.relatedCampaignCount = existing.relatedCampaigns.length;
        }

        const folderKey = String(doc._id);

        if (!existing._folderKeys.has(folderKey)) {
          existing._folderKeys.add(folderKey);
          existing.relatedFolders.push(folderPayload);
          existing.relatedFolderCount = existing.relatedFolders.length;
        }
      }
    }

    const uniqueItems = Array.from(uniqueInfluencersMap.values()).map((item) => {
      const { _campaignKeys, _folderKeys, ...safeItem } = item;
      return safeItem;
    });

    return res.json({
      success: true,
      message: 'Good fit influencers fetched successfully',
      data: {
        totalFolderCount: folders.length,
        totalCampaignCount: campaignsMap.size,
        totalGoodFitCount: uniqueItems.length,
        campaigns: Array.from(campaignsMap.values()),
        items: uniqueItems,
        folders,
      },
    });
  } catch (err) {
    console.error('[getFolderGoodFitListAll] Error:', err);


    await saveErrorLog(req, err, err?.response?.status || err?.statusCode || err?.status || 500, 'GET_FOLDER_GOOD_FIT_LIST_ALL_ERROR'); return res.status(500).json({
      success: false,
      error: err?.message || 'Internal error',
    });
  }
};