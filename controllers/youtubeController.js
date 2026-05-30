'use strict';

require('dotenv').config();
const { fetch, Agent } = require('undici');

const InfluencerProfile = require('../models/youtube');
const saveErrorLog = require('../services/errorLog.service');

const asyncHandler = (fn, errorCode = 'YOUTUBE_CONTROLLER_ERROR') => async (req, res, next) => {
  try {
    return await fn(req, res, next);
  } catch (err) {
    await saveErrorLog(
      req,
      err,
      err?.response?.status || err?.statusCode || err?.status || 500,
      errorCode
    );

    return next(err);
  }
};

const YT_API_KEY = process.env.YOUTUBE_API_KEY;
const YT_TIMEOUT_MS = Number(process.env.YOUTUBE_TIMEOUT_MS || 12000);

const httpAgent = new Agent({
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 60_000,
});

const YT_CHANNELS = 'https://www.googleapis.com/youtube/v3/channels';
const YT_PLAYLIST_ITEMS = 'https://www.googleapis.com/youtube/v3/playlistItems';
const YT_VIDEOS = 'https://www.googleapis.com/youtube/v3/videos';
const YT_SEARCH = 'https://www.googleapis.com/youtube/v3/search';
const MAX_VIDEO_FETCH = 50;

const CHANNEL_PARTS = [
  'snippet',
  'statistics',
  'topicDetails',
  'brandingSettings',
  'contentDetails',
  'status',
  'localizations',
];

const MAX_SEARCH_SCAN_PAGES = Number(process.env.YT_SEARCH_SCAN_PAGES || 6);
const DEFAULT_FILTERED_RESULT_GOAL = Number(process.env.YT_FILTERED_RESULT_GOAL || 20);

// ======================================================
// Helpers
// ======================================================

async function searchYouTubeChannels(query, pageToken = '', maxResults = 50) {
  const params = new URLSearchParams();
  params.set('part', 'snippet');
  params.set('q', String(query || '').trim());
  params.set('type', 'channel');
  params.set('maxResults', String(Math.min(50, Math.max(1, Number(maxResults) || 50))));
  params.set('key', YT_API_KEY);

  if (pageToken) params.set('pageToken', pageToken);

  const data = await ytFetch(`${YT_SEARCH}?${params.toString()}`);

  return {
    items: Array.isArray(data?.items) ? data.items : [],
    nextPageToken: data?.nextPageToken || null,
    prevPageToken: data?.prevPageToken || null,
    pageInfo: data?.pageInfo || null,
  };
}

async function searchYouTubeVideos(query, maxResults = 50) {
  const params = new URLSearchParams({
    part: 'snippet',
    q: String(query || '').trim(),
    type: 'video',
    maxResults: String(Math.min(50, Math.max(1, Number(maxResults) || 50))),
    key: YT_API_KEY,
  });

  const data = await ytFetch(`${YT_SEARCH}?${params.toString()}`);
  return Array.isArray(data?.items) ? data.items : [];
}

async function fetchChannelsByIds(channelIds = []) {
  const ids = Array.from(
    new Set((channelIds || []).map((x) => String(x || '').trim()).filter(Boolean))
  );

  if (!ids.length) return [];

  const params = new URLSearchParams();
  params.set('part', CHANNEL_PARTS.join(','));
  params.set('id', ids.join(','));
  params.set('key', YT_API_KEY);

  const data = await ytFetch(`${YT_CHANNELS}?${params.toString()}`);
  return Array.isArray(data?.items) ? data.items : [];
}

async function fetchVideosByIds(videoIds = []) {
  const ids = Array.from(new Set(videoIds.filter(Boolean)));
  if (!ids.length) return [];

  const params = new URLSearchParams({
    part: 'snippet,statistics,contentDetails',
    id: ids.join(','),
    key: YT_API_KEY,
  });

  const data = await ytFetch(`${YT_VIDEOS}?${params.toString()}`);
  return Array.isArray(data?.items) ? data.items : [];
}
function cleanStr(v) {
  if (v === null || typeof v === 'undefined') return '';
  return String(v).trim();
}

function normalizeHandle(input) {
  const s = cleanStr(input);
  if (!s) return null;

  // Handles plain handle, @handle, or URL containing @handle
  const m = s.match(/@([A-Za-z0-9._\-]+)/);
  if (m && m[1]) return `@${m[1]}`;

  if (/^[A-Za-z0-9._\-]+$/.test(s)) return `@${s}`;

  return null;
}

function handleToLower(input) {
  const h = normalizeHandle(input);
  return h ? h.toLowerCase() : null;
}

function cleanStrOrNull(v) {
  if (v === null || typeof v === 'undefined') return null;
  const s = String(v).trim();
  return s ? s : null;
}

function labelFromWikiUrl(url) {
  try {
    const last = decodeURIComponent(String(url).split('/').pop() || '');
    return last.replace(/_/g, ' ');
  } catch {
    return String(url || '');
  }
}

function escapeRegex(str = '') {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function pickInstagramHandle(text) {
  const t = String(text || '');
  const m =
    t.match(/instagram\.com\/([A-Za-z0-9._]+)/i) ||
    t.match(/\B@([A-Za-z0-9._]{3,})\b/);

  if (!m) return null;
  return `@${String(m[1]).toLowerCase()}`;
}

function cleanStrOrNull(v) {
  if (v === null || typeof v === 'undefined') return null;
  const s = String(v).trim();
  return s ? s : null;
}

function parseDateOrNull(v) {
  if (v === null || v === '' || typeof v === 'undefined') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return { __invalid: true };
  return d;
}

function parseBoolOrNull(v) {
  if (v === null || typeof v === 'undefined' || v === '') return null;
  if (typeof v === 'boolean') return v;


  const s = String(v).trim().toLowerCase();
  if (['true', 'yes', '1'].includes(s)) return true;
  if (['false', 'no', '0'].includes(s)) return false;

  return { __invalid: true };
}

function normalizeChannelHandle(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  return s.startsWith('@') ? s : `@${s.replace(/^@/, '')}`;
}

function parseFlexibleNumber(v) {
  if (v === null || v === '' || typeof v === 'undefined') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseArrayInput(v) {
  if (Array.isArray(v)) {
    return v.map((x) => String(x || '').trim()).filter(Boolean);
  }

  const s = cleanStr(v);
  if (!s) return [];

  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function normalizeCountryTokens(values = []) {
  return Array.from(
    new Set(
      (values || [])
        .map((x) => String(x || '').trim().toUpperCase())
        .filter(Boolean)
    )
  );
}

function containsCI(v) {
  return new RegExp(escapeRegex(String(v || '').trim()), 'i');
}

function normalizeSearchQuery(input) {
  const raw = cleanStr(input);
  if (!raw) return '';

  return raw
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-zA-Z])/g, '$1 $2')
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildAvgViewsMin(body = {}) {
  const raw = body.avgViewsMin ?? body.averageViewsMin ?? null;
  const n = raw != null && raw !== '' ? Number(raw) : null;
  return Number.isFinite(n) ? n : null;
}

function buildLastUploadDays(body = {}) {
  const raw = body.lastUploadDays ?? body.lastUploadWindowDays ?? null;
  const n = raw != null && raw !== '' ? Number(raw) : null;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function buildLiveSearchFilterState(input = {}) {
  const { min: followersMin, max: followersMax } = buildSubscriberRange(input);
  const avgViewsMin = buildAvgViewsMin(input);
  const lastUploadDays = buildLastUploadDays(input);

  const countries = normalizeCountryTokens([
    ...parseArrayInput(input.country),
    ...parseArrayInput(input.countries),
  ]);

  const categories = [
    ...parseArrayInput(input.category),
    ...parseArrayInput(input.categories),
  ].filter(Boolean);

  return {
    followersMin,
    followersMax,
    avgViewsMin,
    lastUploadDays,
    countries,
    categories,
    sortBy: cleanStr(input.sortBy) || 'relevance',
  };
}

function passesBasicLiveSearchFilters(rec, filters) {
  const subs = toNum(rec?.subscriberCount);

  if (filters.followersMin !== null) {
    if (subs === null || subs < filters.followersMin) return false;
  }

  if (filters.followersMax !== null) {
    if (subs === null || subs > filters.followersMax) return false;
  }

  if (filters.countries.length) {
    const rc = String(rec?.country || '').trim().toUpperCase();
    if (!rc || !filters.countries.includes(rc)) return false;
  }

  if (filters.categories.length) {
    const hay = [
      ...(Array.isArray(rec?.topicLabels) ? rec.topicLabels : []),
      rec?.title || '',
      rec?.description || '',
      rec?.keywords || '',
    ].join(' || ');

    const matched = filters.categories.some((term) => containsCI(term).test(hay));
    if (!matched) return false;
  }

  return true;
}

function passesMetricLiveSearchFilters(rec, filters) {
  if (filters.avgViewsMin !== null) {
    const avgViews = toNum(rec?.avgViewsLast15);
    if (avgViews === null || avgViews < filters.avgViewsMin) return false;
  }

  if (filters.lastUploadDays !== null) {
    const dt = rec?.lastUploadAt ? new Date(rec.lastUploadAt) : null;
    if (!dt || Number.isNaN(dt.getTime())) return false;

    const cutoff = Date.now() - filters.lastUploadDays * 24 * 60 * 60 * 1000;
    if (dt.getTime() < cutoff) return false;
  }

  return true;
}

function liveSearchNeedsMetrics(filters) {
  return (
    filters.avgViewsMin !== null ||
    filters.lastUploadDays !== null ||
    [
      'avg_views_desc',
      'avg_views_asc',
      'engagement_desc',
      'recent_upload',
      'uploads_per_week',
    ].includes(filters.sortBy)
  );
}

function getLiveSearchSortComparator(sortBy = 'relevance') {
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
  };

  const time = (v) => {
    const t = new Date(v || 0).getTime();
    return Number.isFinite(t) ? t : 0;
  };

  switch (sortBy) {
    case 'subscribers_desc':
      return (a, b) => num(b.subscriberCount) - num(a.subscriberCount) || num(b.score) - num(a.score);

    case 'subscribers_asc':
      return (a, b) => num(a.subscriberCount) - num(b.subscriberCount) || num(b.score) - num(a.score);

    case 'avg_views_desc':
      return (a, b) => num(b.avgViewsLast15) - num(a.avgViewsLast15) || num(b.score) - num(a.score);

    case 'avg_views_asc':
      return (a, b) => num(a.avgViewsLast15) - num(b.avgViewsLast15) || num(b.score) - num(a.score);

    case 'engagement_desc':
      return (a, b) => num(b.engagementRateLast15) - num(a.engagementRateLast15) || num(b.score) - num(a.score);

    case 'recent_upload':
      return (a, b) => time(b.lastUploadAt) - time(a.lastUploadAt) || num(b.score) - num(a.score);

    case 'uploads_per_week':
      return (a, b) => num(b.uploadFrequencyPerWeek) - num(a.uploadFrequencyPerWeek) || num(b.score) - num(a.score);

    case 'newest':
      return (a, b) => time(b.channelCreatedAt) - time(a.channelCreatedAt) || num(b.score) - num(a.score);

    case 'relevance':
    default:
      return (a, b) => num(b.score) - num(a.score);
  }
}

async function fetchChannelById(channelId) {
  const params = new URLSearchParams({
    part: CHANNEL_PARTS.join(','),
    id: String(channelId || '').trim(),
    key: YT_API_KEY,
  });

  const data = await ytFetch(`${YT_CHANNELS}?${params.toString()}`);
  return data?.items?.[0] || null;
}

async function buildYouTubeProfileData(channel, opts = {}) {
  const inputHandle = opts.inputHandle ? normalizeHandle(opts.inputHandle) : null;
  const inputEmail = typeof opts.email === 'string' ? opts.email.trim().toLowerCase() : null;
  const videosLimit = Math.min(50, Math.max(1, Number(opts.videosLimit) || 15));

  const snippet = channel?.snippet || {};
  const stats = channel?.statistics || {};
  const topic = channel?.topicDetails || {};
  const branding = channel?.brandingSettings || {};
  const uploadsPlaylistId = channel?.contentDetails?.relatedPlaylists?.uploads || null;

  const customUrlRaw = snippet?.customUrl || '';
  const resolvedHandle =
    normalizeHandle(customUrlRaw) ||
    normalizeChannelHandle(customUrlRaw) ||
    inputHandle ||
    null;

  const videos = uploadsPlaylistId
    ? await fetchLatestVideosFromUploads(uploadsPlaylistId, videosLimit)
    : [];

  const computed = computeMetricsFromVideos(videos, 15);

  const topicCategories = Array.isArray(topic.topicCategories) ? topic.topicCategories : [];
  const topicLabels = topicCategories.map(labelFromWikiUrl);

  const bannerUrl = branding?.image?.bannerExternalUrl || null;
  const keywords = branding?.channel?.keywords || '';

  const instagramFromChannel = pickInstagramHandle(snippet.description);
  const instagramFromVideos =
    videos.map((v) => pickInstagramHandle(v?.snippet?.description)).find(Boolean) || null;
  const instagramHandle = instagramFromChannel || instagramFromVideos || null;

  const profileData = {
    platform: 'youtube',
    handle: resolvedHandle,
    channelId: channel.id,

    title: snippet.title || '',
    description: snippet.description || '',
    country: snippet.country || null,
    defaultLanguage: snippet.defaultLanguage || null,
    thumbnails: snippet.thumbnails || null,

    keywords,
    bannerUrl,

    topicCategories,
    topicLabels,

    subscriberCount: toNum(stats.subscriberCount),
    totalViewCount: toNum(stats.viewCount),
    totalVideoCount: toNum(stats.videoCount),

    lastVideos: computed.lastVideos,

    avgViewsLast15: computed.avgViews,
    engagementRateLast15: computed.engagementRate,
    uploadFrequencyPerWeek: computed.postsPerWeek,
    avgDaysBetweenUploads: computed.avgDaysBetween,

    lastUploadAt: computed.lastUploadAt,
    lastVideoId: computed.lastVideoId,
    lastVideoTitle: computed.lastVideoTitle,

    instagramHandle,

    rawChannel: channel,
    syncedAt: new Date(),
    updatedAt: new Date(),
    ...(inputEmail ? { email: inputEmail } : {}),
  };

  return {
    resolvedHandle,
    profileData,
  };
}

// ======================================================
// HTTP fetch wrapper
// ======================================================
async function ytFetch(url, timeoutMs = YT_TIMEOUT_MS) {
  const ac = new AbortController();
  const t = setTimeout(
    () => ac.abort(new Error('YouTube API timeout')),
    timeoutMs
  );

  try {
    const r = await fetch(url, {
      dispatcher: httpAgent,
      signal: ac.signal,
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`YouTube API ${r.status}: ${txt || r.statusText}`);
    }


    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

/* -------------------------------------------------------------------------- */
/*                              YouTube calls                                 */
/* -------------------------------------------------------------------------- */

async function fetchChannelByHandle(handle) {
  const params = new URLSearchParams({
    part: CHANNEL_PARTS.join(','),
    forHandle: handle,
    key: YT_API_KEY,
  });


  const data = await ytFetch(`${YT_CHANNELS}?${params.toString()}`);
  return data?.items?.[0] || null;
}
function chunkArray(arr = [], size = 50) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

async function fetchChannelsByIds(ids = []) {
  const uniq = Array.from(
    new Set((ids || []).map((x) => String(x || '').trim()).filter(Boolean))
  );

  if (!uniq.length) return [];

  const batches = chunkArray(uniq, 50);
  const all = [];

  for (const batch of batches) {
    const params = new URLSearchParams({
      part: CHANNEL_PARTS.join(','),
      id: batch.join(','),
      key: YT_API_KEY,
    });

    const data = await ytFetch(`${YT_CHANNELS}?${params.toString()}`);
    if (Array.isArray(data?.items)) {
      all.push(...data.items);
    }
  }

  return all;
}

async function fetchVideosByIds(ids = []) {
  const uniq = Array.from(
    new Set((ids || []).map((x) => String(x || '').trim()).filter(Boolean))
  );

  if (!uniq.length) return [];

  const batches = chunkArray(uniq, 50);
  const all = [];

  for (const batch of batches) {
    const params = new URLSearchParams({
      part: 'snippet,contentDetails,statistics,topicDetails,status',
      id: batch.join(','),
      key: YT_API_KEY,
    });

    const data = await ytFetch(`${YT_VIDEOS}?${params.toString()}`);
    if (Array.isArray(data?.items)) {
      all.push(...data.items);
    }
  }

  return all;
}

/**
 * Global keyword search for channels
 */
async function searchChannelsByKeyword(query, limit = 5) {
  const safeLimit = Math.min(25, Math.max(1, Number(limit) || 5));

  const params = new URLSearchParams({
    part: 'snippet',
    q: String(query || '').trim(),
    type: 'channel',
    maxResults: String(safeLimit),
    key: YT_API_KEY,
  });

  const data = await ytFetch(`${YT_SEARCH}?${params.toString()}`);
  return Array.isArray(data?.items) ? data.items : [];
}

function isMongoObjectIdLike(value) {
  return /^[a-f\d]{24}$/i.test(String(value || "").trim());
}

function cleanSearchValue(value) {
  const text = cleanStr(value);
  if (!text) return "";
  if (isMongoObjectIdLike(text)) return "";
  return text;
}

function uniqCleanSearch(values = []) {
  const seen = new Set();

  return values
    .flat()
    .map((x) => cleanSearchValue(x))
    .filter(Boolean)
    .filter((x) => {
      const key = x.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function getCampaignSubcategoryTags(campaign = {}) {
  return uniqCleanSearch(
    Array.isArray(campaign.details?.subcategories)
      ? campaign.details.subcategories.flatMap((x) =>
        Array.isArray(x?.tags) ? x.tags : []
      )
      : []
  );
}

function getCampaignGoals(campaign = {}) {
  return uniqCleanSearch([
    campaign.campaignGoal,
    campaign.campaignObjective,
    ...(Array.isArray(campaign.details?.campaignGoals)
      ? campaign.details.campaignGoals.map((x) => x?.goal)
      : []),
  ]);
}

function getCampaignContentFormats(campaign = {}) {
  return uniqCleanSearch([
    // Do not use raw campaign.contentFormats here because it can contain ObjectIds.
    ...(Array.isArray(campaign.details?.contentFormats)
      ? campaign.details.contentFormats.map((x) => x?.format)
      : []),
    campaign.contentFormat,
    campaign.deliverable,
  ]);
}

function buildYouTubeCampaignCategories(campaign = {}) {
  return uniqCleanSearch([
    campaign.campaignCategory,
    campaign.campaignSubcategory,
    ...(Array.isArray(campaign.categories)
      ? campaign.categories.flatMap((x) => [
        x?.categoryName,
        x?.subcategoryName,
      ])
      : []),
    campaign.details?.category?.name,
    ...(Array.isArray(campaign.details?.subcategories)
      ? campaign.details.subcategories.map((x) => x?.name)
      : []),
    ...getCampaignSubcategoryTags(campaign).slice(0, 12),
  ]);
}

function buildYouTubeCampaignCountries(campaign = {}) {
  return uniqCleanSearch([
    campaign.targetCountry,
    campaign.targetCountryCode,
    ...(Array.isArray(campaign.details?.targetCountries)
      ? campaign.details.targetCountries.flatMap((x) => [
        x?.countryCode,
        x?.countryName,
      ])
      : []),
  ]);
}

/**
 * Global keyword search for videos
 */
async function searchVideosByKeyword(query, limit = 12) {
  const safeLimit = Math.min(25, Math.max(1, Number(limit) || 12));

  const params = new URLSearchParams({
    part: 'snippet',
    q: String(query || '').trim(),
    type: 'video',
    order: 'relevance',
    maxResults: String(safeLimit),
    key: YT_API_KEY,
  });

  const data = await ytFetch(`${YT_SEARCH}?${params.toString()}`);
  return Array.isArray(data?.items) ? data.items : [];
}

/**
 * Fetch latest uploads. YouTube API maxResults per request is 50.
 */
async function fetchLatestVideosFromUploads(uploadsPlaylistId, limit = 50) {
  const safeLimit = Math.min(
    MAX_VIDEO_FETCH,
    Math.max(1, Number(limit) || MAX_VIDEO_FETCH)
  );

  const params = new URLSearchParams({
    part: 'contentDetails,snippet',
    playlistId: uploadsPlaylistId,
    maxResults: String(safeLimit),
    key: YT_API_KEY,
  });

  const data = await ytFetch(`${YT_PLAYLIST_ITEMS}?${params.toString()}`);

  const ids = (data?.items || [])
    .map((it) => it?.contentDetails?.videoId)
    .filter(Boolean);

  if (!ids.length) return [];

  const p2 = new URLSearchParams({
    part: 'snippet,contentDetails,statistics,topicDetails,status',
    id: ids.join(','),
    key: YT_API_KEY,
  });

  const v = await ytFetch(`${YT_VIDEOS}?${p2.toString()}`);
  return Array.isArray(v?.items) ? v.items : [];
}

// ======================================================
// Compute metrics
// ======================================================
function computeMetricsFromVideos(videos = [], sampleSize = 15) {
  const rows = videos
    .map((v) => {
      const st = v?.statistics || {};
      const sn = v?.snippet || {};
      const cd = v?.contentDetails || {};

      return {
        videoId: v?.id || null,
        title: sn?.title || '',
        description: sn?.description || '',
        publishedAt: sn?.publishedAt ? new Date(sn.publishedAt) : null,
        viewCount: toNum(st.viewCount) ?? 0,
        likeCount: toNum(st.likeCount) ?? 0,
        commentCount: toNum(st.commentCount) ?? 0,
        duration: cd?.duration || null,
        thumbnails: sn?.thumbnails || null,
        videoUrl: v?.id ? `https://www.youtube.com/watch?v=${v.id}` : null,
      };
    })
    .filter((r) => r.videoId && r.publishedAt);

  rows.sort((a, b) => b.publishedAt - a.publishedAt);

  const sample = rows.slice(0, Math.max(1, Number(sampleSize) || 15));

  if (!sample.length) {
    return {
      storedVideos: [],
      avgViews: null,
      engagementRate: null,
      postsPerWeek: null,
      avgDaysBetween: null,
      lastUploadAt: null,
      lastVideoId: null,
      lastVideoTitle: null,
    };
  }

  const avgViews = Math.round(sample.reduce((a, r) => a + r.viewCount, 0) / sample.length);

  const erArr = sample
    .map((r) => (r.viewCount > 0 ? (r.likeCount + r.commentCount) / r.viewCount : 0))
    .filter(Number.isFinite);

  const engagementRate = erArr.length
    ? Number(
      (erArr.reduce((a, b) => a + b, 0) / erArr.length).toFixed(6)
    )
    : null;

  let postsPerWeek = null;
  let avgDaysBetween = null;

  if (sample.length >= 2) {
    const newest = sample[0].publishedAt.getTime();
    const oldest = sample[sample.length - 1].publishedAt.getTime();
    const days = Math.max(1, (newest - oldest) / (1000 * 60 * 60 * 24));
    postsPerWeek = Number(((sample.length / days) * 7).toFixed(3));

    const gaps = [];
    for (let i = 0; i < sample.length - 1; i++) {
      gaps.push((sample[i].publishedAt - sample[i + 1].publishedAt) / (1000 * 60 * 60 * 24));
    }

    avgDaysBetween = gaps.length
      ? Number(
        (gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(3)
      )
      : null;
  }

  return {
    lastVideos: sample,
    avgViews,
    engagementRate,
    postsPerWeek,
    avgDaysBetween,
    lastUploadAt: sample[0].publishedAt,
    lastVideoId: sample[0].videoId,
    lastVideoTitle: sample[0].title,
  };
}

/* -------------------------------------------------------------------------- */
/*                           Shared query builder                             */
/* -------------------------------------------------------------------------- */

function buildInfluencerQuery(input = {}, opts = {}) {
  const and = [{ platform: 'youtube' }];

  const followersMin = parseFlexibleNumber(
    input.followersMin ?? input.minFollowers ?? input.followers_from
  );
  const followersMax = parseFlexibleNumber(
    input.followersMax ?? input.maxFollowers ?? input.followers_to
  );

  if (followersMin !== null || followersMax !== null) {
    const range = {};
    if (followersMin !== null) range.$gte = followersMin;
    if (followersMax !== null) range.$lte = followersMax;
    and.push({ subscriberCount: range });
  }

  const countryValues = normalizeCountryTokens([
    ...parseArrayInput(input.country),
    ...parseArrayInput(input.countries),
  ]);

  if (countryValues.length) {
    and.push({
      country: { $in: countryValues.map(exactCI) },
    });
  }

  const categoryValues = [
    ...parseArrayInput(input.category),
    ...parseArrayInput(input.categories),
  ].filter(Boolean);

  if (categoryValues.length) {
    const rxList = categoryValues.map((c) => containsCI(c));
    and.push({
      $or: [
        { topicLabels: { $in: rxList } },
        { topicCategories: { $in: rxList } },
      ],
    });
  }

  const search = cleanStr(input.search);
  if (search) {
    const needleRaw = search;
    const needleNoAt = search.startsWith('@') ? search.slice(1) : search;

    const rxRaw = escapeRegex(needleRaw);
    const rxNoAt = escapeRegex(needleNoAt);

    const handleRx = new RegExp(
      rxRaw.startsWith('@') ? rxRaw : `@${rxNoAt}`,
      'i'
    );
    const plainRx = new RegExp(rxNoAt, 'i');

    and.push({
      $or: [
        { email: plainRx },
        { handle: handleRx },
        { title: plainRx },
        { channelId: plainRx },
        { instagramHandle: plainRx },
        { handleId: plainRx },
        { country: plainRx },
        { defaultLanguage: plainRx },
        { lastSponsor: plainRx },
        { topAudienceCountry: plainRx },
        { workingHandle: plainRx },
      ],
    });
  }

  if (Array.isArray(opts.handleIds) && opts.handleIds.length) {
    and.push({
      handleId: { $in: opts.handleIds.map((x) => cleanStr(x)).filter(Boolean) },
    });
  }

  return and.length === 1 ? and[0] : { $and: and };
}

function buildSortSpec(sortBy, sortOrder) {
  const safeSortBy = ALLOWED_SORT.has(String(sortBy)) ? String(sortBy) : 'createdAt';
  const safeSortOrder =
    String(sortOrder || 'desc').toLowerCase() === 'asc' ? 1 : -1;

  if (safeSortBy === 'engagementRateLast15') {
    return {
      sortBy: safeSortBy,
      sortOrder: safeSortOrder,
      mongoSort: {
        engagementRateLast15: safeSortOrder,
        uploadFrequencyPerWeek: -1,
        createdAt: -1,
      },
    };
  }

  if (safeSortBy === 'uploadFrequencyPerWeek') {
    return {
      sortBy: safeSortBy,
      sortOrder: safeSortOrder,
      mongoSort: {
        uploadFrequencyPerWeek: safeSortOrder,
        engagementRateLast15: -1,
        createdAt: -1,
      },
    };
  }

  return {
    sortBy: safeSortBy,
    sortOrder: safeSortOrder,
    mongoSort: { [safeSortBy]: safeSortOrder, createdAt: -1 },
  };
}

function buildProjection({ includeRaw = false, includeVideos = false } = {}) {
  return {
    __v: 0,
    rawPlaylists: 0,
    ...(includeRaw ? {} : { rawChannel: 0 }),
    ...(includeVideos ? {} : { lastVideos: 0 }),
  };
}

/* -------------------------------------------------------------------------- */
/*                             CSV helpers                                    */
/* -------------------------------------------------------------------------- */

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function fmt(v) {
  return v == null || v === '' ? '—' : String(v);
}

function fmtNum(v) {
  return v == null || Number.isNaN(Number(v)) ? '—' : String(v);
}

function fmtPercent(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(2)}%`;
}

function fmtBool(v) {
  if (v === true) return 'Yes';
  if (v === false) return 'No';
  return '—';
}

function fmtDateOnly(v) {
  if (!v) return '—';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return '—';

  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function ytLink(doc) {
  if (doc?.handle) return `https://www.youtube.com/${doc.handle}`;
  if (doc?.channelId) return `https://www.youtube.com/channel/${doc.channelId}`;
  return '—';
}

function igLink(doc) {
  const h = cleanStr(doc?.instagramHandle);
  if (!h) return '—';
  const username = h.startsWith('@') ? h.slice(1) : h;
  return `https://www.instagram.com/${username}`;
}

function niche(doc) {
  const labels = Array.isArray(doc?.topicLabels) ? doc.topicLabels : [];
  return labels[0] ? String(labels[0]) : '—';
}

function subNiche(doc) {
  const labels = Array.isArray(doc?.topicLabels) ? doc.topicLabels : [];
  return labels[1] ? String(labels[1]) : '—';
}

function followups(doc) {
  const arr = Array.isArray(doc?.followUpDates) ? doc.followUpDates : [];
  const dates = arr
    .map((x) => (x instanceof Date ? x : new Date(x)))
    .filter((d) => d && !Number.isNaN(d.getTime()))
    .sort((a, b) => b.getTime() - a.getTime());

  return {
    f1: dates[0] ? fmtDateOnly(dates[0]) : '—',
    f2: dates[1] ? fmtDateOnly(dates[1]) : '—',
  };
}

/* -------------------------------------------------------------------------- */
/*                             Controllers                                    */
/* -------------------------------------------------------------------------- */

// ======================================================
// Mapping helpers for GLOBAL SEARCH (read-only, not stored)
// ======================================================
function mapVideoLite(v) {
  const sn = v?.snippet || {};
  const st = v?.statistics || {};

  return {
    videoId: v?.id || null,
    title: sn?.title || '',
    description: sn?.description || '',
    publishedAt: sn?.publishedAt || null,
    channelId: sn?.channelId || null,
    channelTitle: sn?.channelTitle || '',
    thumbnails: sn?.thumbnails || null,
    viewCount: toNum(st?.viewCount),
    likeCount: toNum(st?.likeCount),
    commentCount: toNum(st?.commentCount),
    videoUrl: v?.id ? `https://www.youtube.com/watch?v=${v.id}` : null,
  };
}

function mapChannelLite(ch) {
  const sn = ch?.snippet || {};
  const st = ch?.statistics || {};
  const topic = ch?.topicDetails || {};
  const branding = ch?.brandingSettings || {};

  const topicCategories = Array.isArray(topic.topicCategories) ? topic.topicCategories : [];
  const topicLabels = topicCategories.map(labelFromWikiUrl);

  return {
    channelId: ch?.id || null,
    title: sn?.title || '',
    description: sn?.description || '',
    handle: sn?.customUrl
      ? `@${String(sn.customUrl).replace(/^@/, '')}`
      : null,
    customUrl: sn?.customUrl || null,
    country: sn?.country || null,
    thumbnails: sn?.thumbnails || null,
    subscriberCount: toNum(st?.subscriberCount),
    totalViewCount: toNum(st?.viewCount),
    totalVideoCount: toNum(st?.videoCount),
    topicLabels,
    bannerUrl: branding?.image?.bannerExternalUrl || null,
    channelUrl: ch?.id ? `https://www.youtube.com/channel/${ch.id}` : null,
  };
}



function mapChannelToGlobalRecommendation(ch, videosByChannelId, directChannelSet = new Set()) {
  const sn = ch?.snippet || {};
  const st = ch?.statistics || {};
  const td = ch?.topicDetails || {};
  const branding = ch?.brandingSettings || {};

  const handle = normalizeHandle(sn?.customUrl || '') || null;
  const topicCategories = Array.isArray(td?.topicCategories) ? td.topicCategories : [];
  const topicLabels = topicCategories.map(labelFromWikiUrl);
  const matchedVideos = (videosByChannelId.get(ch.id) || []).slice(0, 6);
  const matchedByDirectChannelSearch = directChannelSet.has(ch.id);

  return {
    channelId: ch.id,
    title: sn?.title || '',
    description: sn?.description || '',
    handle,
    customUrl: sn?.customUrl || null,
    country: sn?.country || null,
    defaultLanguage: sn?.defaultLanguage || null,
    thumbnails: sn?.thumbnails || null,
    subscriberCount: toNum(st?.subscriberCount),
    totalViewCount: toNum(st?.viewCount),
    totalVideoCount: toNum(st?.videoCount),
    topicLabels,
    keywords: branding?.channel?.keywords || '',
    bannerUrl: branding?.image?.bannerExternalUrl || null,
    channelCreatedAt: sn?.publishedAt || null,
    channelUrl: handle
      ? `https://www.youtube.com/${handle}`
      : ch.id
        ? `https://www.youtube.com/channel/${ch.id}`
        : null,
    matchedByDirectChannelSearch,
    matchedVideos,

    avgViewsLast15: null,
    engagementRateLast15: null,
    uploadFrequencyPerWeek: null,
    avgDaysBetweenUploads: null,
    lastUploadAt: null,
    lastVideoId: null,
    lastVideoTitle: null,
    instagramHandle: null,

    score:
      (matchedByDirectChannelSearch ? 1000 : 0) +
      (matchedVideos.length * 75) +
      ((toNum(st?.subscriberCount) || 0) / 100000),
  };
}

async function enrichYouTubeRecommendationMetrics(recommendations, channelsById, filters) {
  if (!liveSearchNeedsMetrics(filters) || !recommendations.length) return recommendations;

  return Promise.all(
    recommendations.map(async (rec) => {
      const ch = channelsById.get(rec.channelId);
      if (!ch) return rec;

      try {
        const { profileData } = await buildYouTubeProfileData(ch, {
          inputHandle: rec.handle,
          videosLimit: 15,
        });

        return {
          ...rec,
          avgViewsLast15: profileData.avgViewsLast15 ?? null,
          engagementRateLast15: profileData.engagementRateLast15 ?? null,
          uploadFrequencyPerWeek: profileData.uploadFrequencyPerWeek ?? null,
          avgDaysBetweenUploads: profileData.avgDaysBetweenUploads ?? null,
          lastUploadAt: profileData.lastUploadAt ?? null,
          lastVideoId: profileData.lastVideoId ?? null,
          lastVideoTitle: profileData.lastVideoTitle ?? null,
          instagramHandle: profileData.instagramHandle ?? null,
        };
      } catch {
        return rec;
      }
    })
  );
}

async function collectYouTubeRecommendationsFromChannelIds({
  channelIds,
  videosByChannelId,
  directChannelSet,
  filters,
}) {
  const uniqueChannelIds = Array.from(
    new Set((channelIds || []).map((x) => String(x || '').trim()).filter(Boolean))
  );

  if (!uniqueChannelIds.length) return [];

  const channels = await fetchChannelsByIds(uniqueChannelIds);
  const channelsById = new Map(channels.map((ch) => [ch.id, ch]));

  let recommendations = channels.map((ch) =>
    mapChannelToGlobalRecommendation(ch, videosByChannelId, directChannelSet)
  );

  recommendations = recommendations.filter((rec) =>
    passesBasicLiveSearchFilters(rec, filters)
  );

  recommendations = await enrichYouTubeRecommendationMetrics(
    recommendations,
    channelsById,
    filters
  );

  return recommendations.filter((rec) =>
    passesMetricLiveSearchFilters(rec, filters)
  );
}

function addUniqueYouTubeRecommendations(collected, recommendations = []) {
  for (const rec of recommendations) {
    const key = rec.channelId || rec.handle || rec.title;
    if (!key) continue;

    const prev = collected.get(key);
    if (!prev || Number(rec.score || 0) > Number(prev.score || 0)) {
      collected.set(key, rec);
    }
  }
}

// ======================================================
// Global YouTube search (READ ONLY, no DB storage)
// query: "powerstation reviews"
// returns channels/influencers with matched videos
// ======================================================
async function globalYouTubeSearch(query, opts = {}) {
  const normalizedQuery = normalizeSearchQuery(query);
  const videoLimit = Math.min(50, Math.max(1, Number(opts.videoLimit) || 50));
  const incomingPageToken = cleanStr(opts.pageToken || '');
  const filters = buildLiveSearchFilterState(opts);

  const targetFilteredCount = Math.min(
    50,
    Math.max(1, Number(opts.channelLimit) || DEFAULT_FILTERED_RESULT_GOAL)
  );

  const videoSearchItems = await searchYouTubeVideos(normalizedQuery, videoLimit);
  const videoIds = videoSearchItems
    .map((it) => it?.id?.videoId)
    .filter(Boolean);

  const videos = await fetchVideosByIds(videoIds);

  const videosByChannelId = new Map();
  for (const v of videos) {
    const cid = v?.snippet?.channelId;
    if (!cid) continue;

    const row = {
      videoId: v?.id || null,
      title: v?.snippet?.title || '',
      description: v?.snippet?.description || '',
      publishedAt: v?.snippet?.publishedAt || null,
      channelId: cid,
      channelTitle: v?.snippet?.channelTitle || '',
      thumbnails: v?.snippet?.thumbnails || null,
      viewCount: toNum(v?.statistics?.viewCount),
      likeCount: toNum(v?.statistics?.likeCount),
      commentCount: toNum(v?.statistics?.commentCount),
      videoUrl: v?.id ? `https://www.youtube.com/watch?v=${v.id}` : null,
    };

    if (!videosByChannelId.has(cid)) videosByChannelId.set(cid, []);
    videosByChannelId.get(cid).push(row);
  }

  const videoChannelIds = Array.from(videosByChannelId.keys());

  let currentPageToken = incomingPageToken || '';
  let nextPageToken = null;
  let scannedPages = 0;

  const collected = new Map();

  // Use channels discovered from matching videos first. The previous logic only
  // used the YouTube channel-search endpoint, so a query could have 50 video hits
  // but still return only 0-1 channels. This fills recommendations from the
  // actual channels behind those matched videos.
  addUniqueYouTubeRecommendations(
    collected,
    await collectYouTubeRecommendationsFromChannelIds({
      channelIds: videoChannelIds,
      videosByChannelId,
      directChannelSet: new Set(),
      filters,
    })
  );

  while (scannedPages < MAX_SEARCH_SCAN_PAGES && collected.size < targetFilteredCount) {
    const channelPage = await searchYouTubeChannels(normalizedQuery, currentPageToken, 50);
    scannedPages += 1;

    const pageChannelIds = channelPage.items
      .map((it) => it?.id?.channelId || it?.snippet?.channelId)
      .filter(Boolean);

    const directChannelSet = new Set(pageChannelIds);

    addUniqueYouTubeRecommendations(
      collected,
      await collectYouTubeRecommendationsFromChannelIds({
        channelIds: pageChannelIds,
        videosByChannelId,
        directChannelSet,
        filters,
      })
    );

    nextPageToken = channelPage.nextPageToken || null;
    if (!nextPageToken) break;
    currentPageToken = nextPageToken;
  }

  const recommendations = Array.from(collected.values()).sort(
    getLiveSearchSortComparator(filters.sortBy)
  );

  return {
    query: normalizedQuery,
    channelsFound: recommendations.length,
    videoHits: videos.length,
    nextPageToken,
    hasMore: !!nextPageToken,
    scannedPages,
    appliedFilters: filters,
    recommendations,
  };
}

function pickYouTubeThumb(thumbnails = {}) {
  return (
    thumbnails?.high?.url ||
    thumbnails?.medium?.url ||
    thumbnails?.default?.url ||
    null
  );
}

function youtubeTierFromFollowers(value) {
  const followers = Number(value || 0);

  if (followers >= 1000000) return { key: "mega", label: "Mega" };
  if (followers >= 100000) return { key: "macro", label: "Macro" };
  if (followers >= 10000) return { key: "micro", label: "Micro" };
  if (followers >= 1000) return { key: "nano", label: "Nano" };

  return { key: "starter", label: "Starter" };
}

function looksUsefulSearchText(value) {
  const text = cleanStr(value);
  if (!text) return false;

  const lower = text.toLowerCase();

  // Reject random repeated text like tyrytytyt / trytrytryrty
  if (/([a-z]{2,6})\1{2,}/i.test(lower)) return false;

  const words = lower
    .replace(/[^a-z0-9\s]/gi, " ")
    .split(/\s+/)
    .filter(Boolean);

  if (!words.length) return false;

  const uniqueWords = new Set(words);
  if (words.length >= 3 && uniqueWords.size <= 2) return false;

  return true;
}

function uniqClean(values = []) {
  const seen = new Set();

  return values
    .flat()
    .map((x) => cleanStr(x))
    .filter(Boolean)
    .filter((x) => {
      const key = x.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function getCampaignSubcategoryTags(campaign = {}) {
  return uniqClean(
    Array.isArray(campaign.details?.subcategories)
      ? campaign.details.subcategories.flatMap((x) =>
        Array.isArray(x?.tags) ? x.tags : []
      )
      : []
  );
}

function getCampaignGoals(campaign = {}) {
  return uniqClean([
    campaign.campaignGoal,
    campaign.campaignObjective,
    ...(Array.isArray(campaign.details?.campaignGoals)
      ? campaign.details.campaignGoals.map((x) => x?.goal)
      : []),
  ]);
}

function getCampaignContentFormats(campaign = {}) {
  return uniqClean([
    ...(Array.isArray(campaign.contentFormats)
      ? campaign.contentFormats
      : []),
    ...(Array.isArray(campaign.details?.contentFormats)
      ? campaign.details.contentFormats.map((x) => x?.format)
      : []),
  ]);
}

function buildYouTubeCampaignCategories(campaign = {}) {
  return uniqClean([
    campaign.campaignCategory,
    campaign.campaignSubcategory,
    ...(Array.isArray(campaign.categories)
      ? campaign.categories.flatMap((x) => [
        x?.categoryName,
        x?.subcategoryName,
      ])
      : []),
    campaign.details?.category?.name,
    ...(Array.isArray(campaign.details?.subcategories)
      ? campaign.details.subcategories.map((x) => x?.name)
      : []),
    ...getCampaignSubcategoryTags(campaign).slice(0, 12),
  ]);
}

function buildYouTubeCampaignCountries(campaign = {}) {
  return uniqClean([
    campaign.targetCountry,
    campaign.targetCountryCode,
    ...(Array.isArray(campaign.targetCountries)
      ? campaign.targetCountries
      : []),
    ...(Array.isArray(campaign.details?.targetCountries)
      ? campaign.details.targetCountries.flatMap((x) => [
        x?.countryCode,
        x?.countryName,
      ])
      : []),
  ]);
}

function buildYouTubeCampaignQuery(campaign = {}) {
  const categoryTerms = buildYouTubeCampaignCategories(campaign);
  const goalTerms = getCampaignGoals(campaign);
  const formatTerms = getCampaignContentFormats(campaign);

  const usefulCampaignText = [
    campaign.campaignTitle,
    campaign.productOrServiceName,
    campaign.description,
    campaign.additionalNotes,
    ...(Array.isArray(campaign.hashtags) ? campaign.hashtags : []),
    ...(Array.isArray(campaign.preferredHashtags)
      ? campaign.preferredHashtags
      : []),
  ].filter(looksUsefulSearchText);

  const values = uniqCleanSearch([
    ...categoryTerms,
    ...goalTerms,
    ...formatTerms,
    ...usefulCampaignText,
  ]);

  return values.join(" ").replace(/\s+/g, " ").trim().slice(0, 220);
}

function getFollowerFitLabel(subscribers, minFollowers, maxFollowers) {
  const subs = Number(subscribers || 0);

  if (minFollowers && subs < minFollowers) return "below_min_followers";
  if (maxFollowers && subs > maxFollowers) return "above_max_followers";

  return "matched";
}

function matchAnyText(haystackValues = [], needles = []) {
  const haystack = haystackValues
    .map((x) => cleanStr(x))
    .filter(Boolean)
    .join(" || ")
    .toLowerCase();

  if (!haystack) return false;

  return needles.some((needle) => {
    const clean = cleanStr(needle).toLowerCase();
    return clean && haystack.includes(clean);
  });
}

function buildCampaignFit(rec = {}, campaign = {}) {
  const minFollowers = Number(campaign.minFollowers || 0);
  const maxFollowers = Number(campaign.maxFollowers || 0);

  const categories = buildYouTubeCampaignCategories(campaign);
  const countries = buildYouTubeCampaignCountries(campaign);
  const goals = getCampaignGoals(campaign);
  const contentFormats = getCampaignContentFormats(campaign);

  const haystackValues = [
    rec.title,
    rec.description,
    rec.keywords,
    ...(Array.isArray(rec.topicLabels) ? rec.topicLabels : []),
    ...(Array.isArray(rec.matchedVideos)
      ? rec.matchedVideos.flatMap((v) => [v?.title, v?.description])
      : []),
  ];

  const countryUpper = cleanStr(rec.country).toUpperCase();
  const countryMatched = countries.length
    ? countries.some((x) => cleanStr(x).toUpperCase() === countryUpper)
    : null;

  const categoryMatched = categories.length
    ? matchAnyText(haystackValues, categories)
    : null;

  const goalMatched = goals.length
    ? matchAnyText(haystackValues, goals)
    : null;

  const contentFormatMatched = contentFormats.length
    ? matchAnyText(haystackValues, contentFormats)
    : null;

  const followerFit = getFollowerFitLabel(
    rec.subscriberCount,
    minFollowers,
    maxFollowers
  );

  let score = 0;

  if (followerFit === "matched") score += 45;
  if (categoryMatched === true) score += 30;
  if (countryMatched === true) score += 10;
  if (goalMatched === true) score += 10;
  if (contentFormatMatched === true) score += 5;

  return {
    score,
    followerFit,
    categoryMatched,
    countryMatched,
    goalMatched,
    contentFormatMatched,
    expected: {
      minFollowers: minFollowers || null,
      maxFollowers: maxFollowers || null,
      countries,
      categories,
      goals,
      contentFormats,
    },
    actual: {
      subscriberCount: Number(rec.subscriberCount || 0),
      country: rec.country || null,
      topicLabels: Array.isArray(rec.topicLabels) ? rec.topicLabels : [],
    },
  };
}

function passesCampaignHardFilters(rec = {}, campaign = {}) {
  const minFollowers = Number(campaign.minFollowers || 0);
  const maxFollowers = Number(campaign.maxFollowers || 0);
  const subscriberCount = Number(rec.subscriberCount || 0);

  if (minFollowers && subscriberCount < minFollowers) return false;
  if (maxFollowers && subscriberCount > maxFollowers) return false;

  return true;
}

function buildYouTubeRecommendationReason(rec = {}, campaign = {}) {
  const fit = buildCampaignFit(rec, campaign);
  const parts = [];

  if (fit.followerFit === "matched") {
    parts.push(
      `${new Intl.NumberFormat("en", {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(Number(rec.subscriberCount || 0))} subscribers within campaign range`
    );
  }

  if (fit.categoryMatched) {
    parts.push("Category match");
  }

  if (fit.countryMatched) {
    parts.push(`Country match: ${rec.country}`);
  }

  if (fit.goalMatched) {
    parts.push("Goal match");
  }

  if (fit.contentFormatMatched) {
    parts.push("Content format match");
  }

  if (!parts.length && Array.isArray(rec.topicLabels) && rec.topicLabels.length) {
    parts.push(`Matches ${rec.topicLabels.slice(0, 2).join(", ")}`);
  }

  return parts.slice(0, 4).join(" • ") || "YouTube API campaign match";
}

function mapYouTubeRecommendedInfluencer(rec, maxScore, campaign = {}) {
  const campaignFit = buildCampaignFit(rec, campaign);
  const rawScore = Number(rec.score || 0) + Number(campaignFit.score || 0);

  const aiScore =
    maxScore > 0
      ? Math.max(1, Math.min(100, Math.round((rawScore / maxScore) * 100)))
      : Math.max(1, Math.min(100, campaignFit.score));

  const handle = normalizeHandle(rec.handle || rec.customUrl || "");
  const username = handle
    ? handle.replace(/^@/, "")
    : String(rec.channelId || "");

  const channelUrl =
    rec.channelUrl ||
    (handle
      ? `https://www.youtube.com/${handle}`
      : rec.channelId
        ? `https://www.youtube.com/channel/${rec.channelId}`
        : null);

  return {
    _id: rec.channelId,
    ids: {
      modashId: rec.channelId || null,
      userId: rec.channelId || null,
      youtubeChannelId: rec.channelId || null,
    },
    channelId: rec.channelId || null,
    source: "youtube_api",
    profileSource: "youtube_api",

    name: rec.title || username || "YouTube Creator",
    fullname: rec.title || username || "YouTube Creator",
    username,
    handle: handle || username,
    platform: "youtube",

    followers: Number(rec.subscriberCount || 0),
    tier: youtubeTierFromFollowers(rec.subscriberCount),
    categories: Array.isArray(rec.topicLabels) ? rec.topicLabels : [],
    bio: cleanStr(rec.description || ""),
    picture: pickYouTubeThumb(rec.thumbnails),
    url: channelUrl,
    urls: {
      url: channelUrl,
    },

    isVerified: false,
    isPrivate: false,

    stats: {
      engagementRate: Number(rec.engagementRateLast15 || 0),
      engagements: 0,
      averageViews: Number(rec.avgViewsLast15 || 0),
      totalViews: Number(rec.totalViewCount || 0),
      totalVideos: Number(rec.totalVideoCount || 0),
      uploadFrequencyPerWeek: Number(rec.uploadFrequencyPerWeek || 0),
    },

    location: {
      country: rec.country || null,
      state: null,
      city: null,
    },

    campaignFit,
    aiScore,
    rawAiScore: rawScore,
    recommendationReason: buildYouTubeRecommendationReason(rec, campaign),
  };
}

async function runCampaignYouTubeSearch(query, campaign, limit, opts = {}) {
  const relaxFilters = Boolean(opts.relaxFilters);

  return globalYouTubeSearch(query, {
    channelLimit: Math.max(limit * 5, 50),
    videoLimit: 50,

    followersMin: relaxFilters ? null : campaign.minFollowers,
    followersMax: relaxFilters ? null : campaign.maxFollowers,

    categories: [],

    country: undefined,
    countries: [],

    sortBy: "relevance",
  });
}

async function getYouTubeRecommendationsForCampaign(campaign = {}, opts = {}) {
  if (!YT_API_KEY) {
    const err = new Error("Missing YOUTUBE_API_KEY");
    err.status = 500;
    throw err;
  }

  const limit = Math.min(
    15,
    Math.max(10, parseInt(String(opts.limit || 15), 10) || 15)
  );
  const minimumResults = Math.min(
    limit,
    Math.max(1, parseInt(String(opts.minResults || 10), 10) || 10)
  );

  const primaryQuery = buildYouTubeCampaignQuery(campaign);

  if (!primaryQuery || primaryQuery.length < 2) {
    const err = new Error(
      "Campaign does not have enough searchable information to recommend YouTube influencers"
    );
    err.status = 400;
    throw err;
  }

  const categoryQuery = buildYouTubeCampaignCategories(campaign)
    .slice(0, 12)
    .join(" ");

  const goalQuery = getCampaignGoals(campaign).join(" ");
  const formatQuery = getCampaignContentFormats(campaign).join(" ");

  const queryVariants = uniqClean([
    primaryQuery,
    [categoryQuery, goalQuery, formatQuery].filter(Boolean).join(" "),
    categoryQuery,
  ]).filter((x) => x.length >= 2);

  const merged = new Map();
  const metaRuns = [];

  for (const query of queryVariants) {
    const data = await runCampaignYouTubeSearch(query, campaign, limit);

    metaRuns.push({
      query,
      channelsFound: data.channelsFound,
      videoHits: data.videoHits,
      scannedPages: data.scannedPages,
      hasMore: data.hasMore,
      relaxed: false,
    });

    const rows = Array.isArray(data.recommendations)
      ? data.recommendations
      : [];

    rows.forEach((rec) => {
      if (!passesCampaignHardFilters(rec, campaign)) return;

      const key = rec.channelId || rec.handle || rec.title;
      if (!key) return;

      const fit = buildCampaignFit(rec, campaign);
      const score = Number(rec.score || 0) + Number(fit.score || 0);
      const next = { ...rec, score, campaignFit: fit };

      const prev = merged.get(key);
      if (!prev || Number(next.score || 0) > Number(prev.score || 0)) {
        merged.set(key, next);
      }
    });

    if (merged.size >= limit) break;
  }

  // If strict follower filters produce no rows, relax once so the UI still
  // shows same-source YouTube recommendations instead of an empty list.
  if (merged.size < minimumResults) {
    for (const query of queryVariants) {
      const data = await runCampaignYouTubeSearch(query, campaign, limit, {
        relaxFilters: true,
      });

      metaRuns.push({
        query,
        channelsFound: data.channelsFound,
        videoHits: data.videoHits,
        scannedPages: data.scannedPages,
        hasMore: data.hasMore,
        relaxed: true,
      });

      const rows = Array.isArray(data.recommendations)
        ? data.recommendations
        : [];

      rows.forEach((rec) => {
        const key = rec.channelId || rec.handle || rec.title;
        if (!key) return;

        const fit = buildCampaignFit(rec, campaign);
        const score = Number(rec.score || 0) + Number(fit.score || 0);
        const next = { ...rec, score, campaignFit: fit };

        const prev = merged.get(key);
        if (!prev || Number(next.score || 0) > Number(prev.score || 0)) {
          merged.set(key, next);
        }
      });

      if (merged.size >= limit) break;
    }
  }

  const sorted = Array.from(merged.values())
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, limit);

  const maxScore = Math.max(
    ...sorted.map((x) => Number(x.score || 0)),
    0
  );

  return {
    query: queryVariants[0],
    results: sorted.map((item) =>
      mapYouTubeRecommendedInfluencer(item, maxScore, campaign)
    ),
    total: sorted.length,
    meta: {
      source: "youtube_api",
      runs: metaRuns,
      channelsFound: sorted.length,
      filters: {
        minFollowers: campaign.minFollowers || null,
        maxFollowers: campaign.maxFollowers || null,
        countries: buildYouTubeCampaignCountries(campaign),
        categories: buildYouTubeCampaignCategories(campaign),
        goals: getCampaignGoals(campaign),
        contentFormats: getCampaignContentFormats(campaign),
      },
      minimumResults,
    },
  };
}

exports.getYouTubeRecommendationsForCampaign =
  getYouTubeRecommendationsForCampaign;

// ======================================================
// POST /youtube/search
// body: { query }
// Rules:
// - If explicit handle search (@creator) => sync/store in DB
// - Else => global search only, DO NOT store
// ======================================================
exports.searchYouTube = asyncHandler(async (req, res) => {
  if (!YT_API_KEY) {
    return res.status(500).json({
      status: 'error',
      message: 'Missing YOUTUBE_API_KEY',
    });
  }

  const body = req.body || {};
  const rawQuery = cleanStrOrNull(body.query ?? body.search ?? body.keyword);
  const pageToken = cleanStrOrNull(body.pageToken) || '';

  if (!rawQuery) {
    return res.status(400).json({
      status: 'error',
      message: 'query is required',
    });
  }

  const data = await globalYouTubeSearch(rawQuery, {
    channelLimit: body.channelLimit ?? 50,
    videoLimit: body.videoLimit ?? 50,
    pageToken,

    followersMin: body.followersMin,
    followersMax: body.followersMax,
    subscriberRange: body.subscriberRange,

    country: body.country,
    countries: body.countries,

    category: body.category,
    categories: body.categories,

    avgViewsMin: body.avgViewsMin,
    lastUploadDays: body.lastUploadDays,

    sortBy: body.sortBy,
  });

  return res.json({
    status: 'ok',
    mode: 'global',
    stored: false,
    query: rawQuery,
    data,
  });
});

// ======================================================
// POST /youtube/profile/sync
// Exact handle sync + store
// ======================================================
exports.syncYouTubeProfile = asyncHandler(async (req, res) => {
  if (!YT_API_KEY) {
    return res.status(500).json({
      status: 'error',
      message: 'Missing YOUTUBE_API_KEY',
    });
  }

  const body = req.body || {};
  const handle = body.handle ? normalizeHandle(body.handle) : null;
  const channelId = cleanStrOrNull(body.channelId);

  if (!handle && !channelId) {
    return res.status(400).json({
      status: 'error',
      message: 'Provide handle or channelId.',
    });
  }

  const rawEmail = typeof body.email === 'string' ? body.email.trim() : '';
  const email = rawEmail ? rawEmail.toLowerCase() : null;

  if (email) {
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!emailOk) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid email format',
        email: rawEmail,
      });
    }
  }

  const channel = handle
    ? await fetchChannelByHandle(handle)
    : await fetchChannelById(channelId);

  if (!channel) {
    return res.status(404).json({
      status: 'error',
      message: 'Channel not found.',
    });
  }

  const { resolvedHandle, profileData } = await buildYouTubeProfileData(channel, {
    inputHandle: handle,
    email,
    videosLimit: 50,
  });

  if (!resolvedHandle) {
    return res.status(400).json({
      status: 'error',
      message: 'Unable to resolve channel handle for saving.',
    });
  }

  const filter = {
    platform: 'youtube',
    handle: resolvedHandle.toLowerCase(),
  };

  const doc = await InfluencerProfile.findOneAndUpdate(
    filter,
    { $set: profileData },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  return res.json({
    status: 'ok',
    mode: 'handle',
    stored: true,
    handle: resolvedHandle,
    handleId: doc.handleId,
    data: doc,
  });
});

// ======================================================
// POST /youtube/profile/update-manual
// body: { handleId OR handle, ...manualFields }
// - Updates ONLY provided manual fields (email included)
// - Supports clearing fields by sending null or "" (except email must be valid or null)
// ======================================================
exports.updateInfluencerManualFields = asyncHandler(async (req, res) => {
  const body = req.body || {};

  const handleId = cleanStrOrNull(body.handleId);
  const handle = body.handle ? normalizeHandle(body.handle) : null;

  if (!handleId && !handle) {
    return res.status(400).json({
      status: 'error',
      message: 'Provide handleId OR handle.',
    });
    return res.status(400).json({
      status: 'error',
      message: 'Provide handleId OR handle.',
    });
  }

  const filter = handleId
    ? { handleId }
    : { platform: 'youtube', handle: String(handle).toLowerCase() };

  const $set = {};

  if ('email' in body) {
    const email = cleanStrOrNull(body.email);


    if (email === null) {
      $set.email = null;
    } else {
      const emailLc = email.toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLc)) {
        return res.status(400).json({
          status: 'error',
          message: 'Invalid email format.',
        });
        return res.status(400).json({
          status: 'error',
          message: 'Invalid email format.',
        });
      }
      $set.email = emailLc;
    }
  }

  if ('lastSponsor' in body) {
    $set.lastSponsor = cleanStrOrNull(body.lastSponsor);
  }

  if ('managedByAgency' in body) {
    const b = parseBoolOrNull(body.managedByAgency);
    if (b && b.__invalid) {
      return res.status(400).json({
        status: 'error',
        message: 'managedByAgency must be boolean.',
      });
      return res.status(400).json({
        status: 'error',
        message: 'managedByAgency must be boolean.',
      });
    }
    $set.managedByAgency = b;
  }

  if ('topAudienceCountry' in body) {
    $set.topAudienceCountry = cleanStrOrNull(body.topAudienceCountry);
  }

  if ('averageAudienceAge' in body) {
    const v = body.averageAudienceAge;
    if (v === null || v === '' || typeof v === 'undefined') {
      $set.averageAudienceAge = null;
    } else {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 120) {
        return res.status(400).json({
          status: 'error',
          message: 'averageAudienceAge must be 0-120.',
        });
        return res.status(400).json({
          status: 'error',
          message: 'averageAudienceAge must be 0-120.',
        });
      }
      $set.averageAudienceAge = n;
    }
  }

  if ('lastContactedAt' in body || 'lastContactedDate' in body) {
    const raw =
      'lastContactedAt' in body
        ? body.lastContactedAt
        : body.lastContactedDate;

    const d = parseDateOrNull(raw);
    if (d && d.__invalid) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid lastContactedAt date.',
      });
      return res.status(400).json({
        status: 'error',
        message: 'Invalid lastContactedAt date.',
      });
    }
    $set.lastContactedAt = d;
    $set.lastContactedAt = d;
  }

  if ('followUpDates' in body) {
    const arr = Array.isArray(body.followUpDates) ? body.followUpDates : [];
    const parsed = [];


    for (const x of arr) {
      const d = parseDateOrNull(x);
      if (d && d.__invalid) {
        return res.status(400).json({
          status: 'error',
          message: 'followUpDates contains invalid date.',
        });
        return res.status(400).json({
          status: 'error',
          message: 'followUpDates contains invalid date.',
        });
      }
      if (d) parsed.push(d);
    }

    const uniq = Array.from(new Map(parsed.map((d) => [d.getTime(), d])).values())
      .sort((a, b) => a.getTime() - b.getTime());

    $set.followUpDates = uniq;
  }

  if ('workingHandle' in body) $set.workingHandle = cleanStrOrNull(body.workingHandle);

  if (Object.keys($set).length === 0) {
    const existing = await InfluencerProfile.findOne(filter).lean();

    if (!existing) {
      return res.status(404).json({
        status: 'error',
        message: 'Influencer not found. Run sync API first.',
      });
      return res.status(404).json({
        status: 'error',
        message: 'Influencer not found. Run sync API first.',
      });
    }

    return res.json({
      status: 'ok',
      handleId: existing.handleId,
      data: existing,
    });
  }

  $set.updatedAt = new Date();

  const doc = await InfluencerProfile.findOneAndUpdate(
    filter,
    { $set },
    { new: true }
  ).lean();

  if (!doc) {
    return res.status(404).json({
      status: 'error',
      message: 'Influencer not found. Run sync API first.',
    });
    return res.status(404).json({
      status: 'error',
      message: 'Influencer not found. Run sync API first.',
    });
  }

  return res.json({
    status: 'ok',
    handleId: doc.handleId,
    data: doc,
  });
  return res.json({
    status: 'ok',
    handleId: doc.handleId,
    data: doc,
  });
});

// ======================================================
// POST /youtube/getall
// DB search only (saved influencers)
// ======================================================
const ALLOWED_SORT = new Set([
  'createdAt',
  'updatedAt',
  'syncedAt',
  'subscriberCount',
  'avgViewsLast15',
  'engagementRateLast15',
  'uploadFrequencyPerWeek',
  'lastContactedAt',
]);

// ======================================================
// POST /youtube/getall
// Saved DB search + advanced filters
// ======================================================

const SORT_MAP = {
  relevance: { updatedAt: -1 },
  subscribers_desc: { subscriberCount: -1 },
  subscribers_asc: { subscriberCount: 1 },
  avg_views_desc: { avgViewsLast15: -1 },
  avg_views_asc: { avgViewsLast15: 1 },
  engagement_desc: { engagementRateLast15: -1 },
  recent_upload: { lastUploadAt: -1 },
  uploads_per_week: { uploadFrequencyPerWeek: -1 },
  newest: { createdAt: -1 },
};

function buildSubscriberRange(body = {}) {
  const preset = String(body.subscriberRange || '').trim();

  const PRESET_MAP = {
    '1k_10k': { min: 1_000, max: 10_000 },
    '10k_50k': { min: 10_000, max: 50_000 },
    '50k_100k': { min: 50_000, max: 100_000 },
    '100k_500k': { min: 100_000, max: 500_000 },
    '500k_1m': { min: 500_000, max: 1_000_000 },
    '1m_5m': { min: 1_000_000, max: 5_000_000 },
    '5m_10m': { min: 5_000_000, max: 10_000_000 },
    '10m_plus': { min: 10_000_000, max: null },
  };

  const presetMin = PRESET_MAP[preset]?.min ?? null;
  const presetMax = PRESET_MAP[preset]?.max ?? null;

  const directMinRaw =
    body.followersMin ??
    body.minFollowers ??
    body.subscribersMin ??
    null;

  const directMaxRaw =
    body.followersMax ??
    body.maxFollowers ??
    body.subscribersMax ??
    null;

  const directMin = directMinRaw != null && directMinRaw !== '' ? Number(directMinRaw) : null;
  const directMax = directMaxRaw != null && directMaxRaw !== '' ? Number(directMaxRaw) : null;

  let min = Number.isFinite(presetMin) ? presetMin : null;
  let max = Number.isFinite(presetMax) ? presetMax : null;

  if (Number.isFinite(directMin)) {
    min = Number.isFinite(min) ? Math.max(min, directMin) : directMin;
  }

  if (Number.isFinite(directMax)) {
    max = Number.isFinite(max) ? Math.min(max, directMax) : directMax;
  }

  return {
    min: Number.isFinite(min) ? min : null,
    max: Number.isFinite(max) ? max : null,
  };
}

function buildAvgViewsMin(body = {}) {
  const raw = body.avgViewsMin ?? body.averageViewsMin ?? null;
  const n = raw != null && raw !== '' ? Number(raw) : null;
  return Number.isFinite(n) ? n : null;
}

function buildLastUploadDays(body = {}) {
  const raw = body.lastUploadDays ?? body.lastUploadWindowDays ?? null;
  const n = raw != null && raw !== '' ? Number(raw) : null;
  return Number.isFinite(n) && n > 0 ? n : null;
}

exports.getAllInfluencers = asyncHandler(async (req, res) => {
  try {
    const body = req.body || {};

    const _escapeRegex =
      typeof escapeRegex === 'function'
        ? escapeRegex
        : (str = '') => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const page = Math.max(1, parseInt(body.page ?? '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(body.limit ?? '20', 10)));
    const skip = (page - 1) * limit;

    const search = typeof body.search === 'string' ? body.search.trim() : '';

    const sortKey = String(body.sortBy || 'relevance').trim();
    const sort = SORT_MAP[sortKey] || SORT_MAP.relevance;

    const includeRaw = String(body.includeRaw ?? 'false').toLowerCase() === 'true';
    const includeVideos = String(body.includeVideos ?? 'false').toLowerCase() === 'true';

    const { min: followersMin, max: followersMax } = buildSubscriberRange(body);
    const avgViewsMin = buildAvgViewsMin(body);
    const lastUploadDays = buildLastUploadDays(body);

    const countryRaw = body.country ?? null;
    const countriesRaw = body.countries ?? null;

    const categoryRaw = body.category ?? null;
    const categoriesRaw = body.categories ?? null;

    const baseQuery = { platform: 'youtube' };
    const and = [];

    // -----------------------------
    // Subscribers range
    // -----------------------------
    if (Number.isFinite(followersMin) || Number.isFinite(followersMax)) {
      const range = {};
      if (Number.isFinite(followersMin)) range.$gte = followersMin;
      if (Number.isFinite(followersMax)) range.$lte = followersMax;
      and.push({ subscriberCount: range });
    }

    // -----------------------------
    // Avg views minimum
    // -----------------------------
    if (Number.isFinite(avgViewsMin)) {
      and.push({ avgViewsLast15: { $gte: avgViewsMin } });
    }

    // -----------------------------
    // Last upload window
    // -----------------------------
    if (Number.isFinite(lastUploadDays)) {
      const after = new Date(Date.now() - lastUploadDays * 24 * 60 * 60 * 1000);
      and.push({ lastUploadAt: { $gte: after } });
    }

    // -----------------------------
    // Country
    // Stored country is typically code like US / IN
    // -----------------------------
    const countries = Array.isArray(countriesRaw)
      ? countriesRaw.map((x) => String(x || '').trim()).filter(Boolean)
      : [];

    const country = typeof countryRaw === 'string' ? countryRaw.trim() : '';

    if (countries.length) {
      const rxList = countries.map((c) => new RegExp(`^${_escapeRegex(c)}$`, 'i'));
      and.push({ country: { $in: rxList } });
    } else if (country) {
      and.push({ country: new RegExp(`^${_escapeRegex(country)}$`, 'i') });
    }

    // -----------------------------
    // Category
    // Match topic labels/categories + content text for things like Review/Unboxing/Tutorial
    // -----------------------------
    const categories = Array.isArray(categoriesRaw)
      ? categoriesRaw.map((x) => String(x || '').trim()).filter(Boolean)
      : [];

    const category = typeof categoryRaw === 'string' ? categoryRaw.trim() : '';

    const categoryTerms = categories.length ? categories : category ? [category] : [];

    if (categoryTerms.length) {
      const rxList = categoryTerms.map((c) => new RegExp(_escapeRegex(c), 'i'));

      and.push({
        $or: [
          { topicLabels: { $in: rxList } },
          { topicCategories: { $in: rxList } },
          { title: { $in: rxList } },
          { description: { $in: rxList } },
          { keywords: { $in: rxList } },
        ],
      });
    }

    // -----------------------------
    // Search
    // -----------------------------
    if (search) {
      const needleRaw = search;
      const needleNoAt = search.startsWith('@') ? search.slice(1) : search;

      const rxRaw = _escapeRegex(needleRaw);
      const rxNoAt = _escapeRegex(needleNoAt);

      const handleRx = new RegExp(rxRaw.startsWith('@') ? rxRaw : `@${rxNoAt}`, 'i');
      const plainRx = new RegExp(rxNoAt, 'i');

      and.push({
        $or: [
          { email: plainRx },
          { handle: handleRx },
          { title: plainRx },
          { channelId: plainRx },
          { instagramHandle: plainRx },
          { handleId: plainRx },
          { lastSponsor: plainRx },
          { topAudienceCountry: plainRx },
          { workingHandle: plainRx },
          { description: plainRx },
          { keywords: plainRx },
          { topicLabels: plainRx },
          { topicCategories: plainRx },
        ],
      });
    }

    const query = { ...baseQuery };
    if (and.length) query.$and = and;

    const projection = {
      __v: 0,
      ...(includeRaw ? {} : { rawChannel: 0 }),
      ...(includeVideos ? {} : { lastVideos: 0 }),
      rawPlaylists: 0,
    };

    const [total, items] = await Promise.all([
      InfluencerProfile.countDocuments(query),
      InfluencerProfile.find(query)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .select(projection)
        .lean(),
    ]);

    return res.json({
      status: 'ok',
      page,
      limit,
      total,
      hasNext: page * limit < total,
      sortBy: sortKey,
      search: search || '',
      filters: {
        followersMin: Number.isFinite(followersMin) ? followersMin : null,
        followersMax: Number.isFinite(followersMax) ? followersMax : null,
        avgViewsMin: Number.isFinite(avgViewsMin) ? avgViewsMin : null,
        lastUploadDays: Number.isFinite(lastUploadDays) ? lastUploadDays : null,
        country: country || null,
        countries: countries.length ? countries : null,
        category: category || null,
        categories: categories.length ? categories : null,
      },
      data: items,
    });
  } catch (err) {
    console.error('getAllInfluencers error:', err);
    await saveErrorLog(
      req,
      err,
      err?.response?.status || err?.statusCode || err?.status || 400,
      'GET_ALL_INFLUENCERS_ERROR'
    );

    return res.status(400).json({
      status: 'error',
      message: err?.message || 'Failed to fetch influencers.',
    });
  }
});

// ======================================================
// PATCH email only if empty
// ======================================================
exports.patchInfluencerEmail = asyncHandler(async (req, res) => {
  const handle = normalizeHandle(req.body.handle);
  const email = cleanStr(req.body.email).toLowerCase();

  if (!handle) {
    return res.status(400).json({
      status: 'error',
      message: 'Valid handle required',
    });
  }

  if (!email) {
    return res.status(400).json({
      status: 'error',
      message: 'Valid email required',
    });
  }

  const r = await InfluencerProfile.updateOne(
    {
      platform: 'youtube',
      handle: handle.toLowerCase(),
      $or: [{ email: null }, { email: '' }, { email: { $exists: false } }],
    },
    { $set: { email } }
  );

  return res.json({
    status: 'ok',
    matched: r.matchedCount,
    modified: r.modifiedCount,
  });
  return res.json({
    status: 'ok',
    matched: r.matchedCount,
    modified: r.modifiedCount,
  });
});

// ======================================================
// CSV export
// ======================================================
exports.exportInfluencersCsv = asyncHandler(async (req, res) => {
  try {
    const body = req.body || {};
    const MAX_EXPORT = 100_000;

    const handleIdsRaw = body.handleIds ?? body.ids ?? null;
    const handleIds = Array.isArray(handleIdsRaw)
      ? handleIdsRaw.map((x) => String(x || '').trim()).filter(Boolean)
      : [];

    const limitRaw = body.limit ?? body.downloadLimit ?? body.count ?? 500;
    const limitFromBody = Math.min(MAX_EXPORT, Math.max(1, parseInt(String(limitRaw), 10) || 500));
    const limit = handleIds.length ? Math.min(MAX_EXPORT, handleIds.length) : limitFromBody;

    const _escapeRegex =
      typeof escapeRegex === 'function'
        ? escapeRegex
        : (str = '') => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const search = typeof body.search === 'string' ? body.search.trim() : '';
    const sortBy = ALLOWED_SORT.has(String(body.sortBy)) ? String(body.sortBy) : 'createdAt';
    const sortOrder = String(body.sortOrder || 'desc').toLowerCase() === 'asc' ? 1 : -1;

    const followersMinRaw = body.followersMin ?? body.minFollowers ?? body.followers_from ?? null;
    const followersMaxRaw = body.followersMax ?? body.maxFollowers ?? body.followers_to ?? null;

    const countryRaw = body.country ?? null;
    const countriesRaw = body.countries ?? null;

    const categoryRaw = body.category ?? null;
    const categoriesRaw = body.categories ?? null;

    const baseQuery = { platform: 'youtube' };
    const and = [];

    const followersMin = followersMinRaw != null && followersMinRaw !== '' ? Number(followersMinRaw) : null;
    const followersMax = followersMaxRaw != null && followersMaxRaw !== '' ? Number(followersMaxRaw) : null;

    if (Number.isFinite(followersMin) || Number.isFinite(followersMax)) {
      const range = {};
      if (Number.isFinite(followersMin)) range.$gte = followersMin;
      if (Number.isFinite(followersMax)) range.$lte = followersMax;
      and.push({ subscriberCount: range });
    }

    const countries = Array.isArray(countriesRaw)
      ? countriesRaw.map((x) => String(x || '').trim()).filter(Boolean)
      : [];
    const country = typeof countryRaw === 'string' ? countryRaw.trim() : '';

    if (countries.length) {
      const rxList = countries.map((c) => new RegExp(`^${_escapeRegex(c)}$`, 'i'));
      and.push({ country: { $in: rxList } });
    } else if (country) {
      and.push({ country: new RegExp(`^${_escapeRegex(country)}$`, 'i') });
    }

    const categories = Array.isArray(categoriesRaw)
      ? categoriesRaw.map((x) => String(x || '').trim()).filter(Boolean)
      : [];
    const category = typeof categoryRaw === 'string' ? categoryRaw.trim() : '';

    if (categories.length) {
      const rxList = categories.map((c) => new RegExp(_escapeRegex(c), 'i'));
      and.push({
        $or: [{ topicLabels: { $in: rxList } }, { topicCategories: { $in: rxList } }],
      });
    } else if (category) {
      const rx = new RegExp(_escapeRegex(category), 'i');
      and.push({
        $or: [{ topicLabels: rx }, { topicCategories: rx }],
      });
    }

    if (search) {
      const needleRaw = search;
      const needleNoAt = search.startsWith('@') ? search.slice(1) : search;

      const rxRaw = _escapeRegex(needleRaw);
      const rxNoAt = _escapeRegex(needleNoAt);

      const handleRx = new RegExp(rxRaw.startsWith('@') ? rxRaw : `@${rxNoAt}`, 'i');
      const plainRx = new RegExp(rxNoAt, 'i');

      and.push({
        $or: [
          { email: plainRx },
          { handle: handleRx },
          { title: plainRx },
          { channelId: plainRx },
          { instagramHandle: plainRx },
          { handleId: plainRx },
          { lastSponsor: plainRx },
          { topAudienceCountry: plainRx },
          { workingHandle: plainRx },
        ],
      });
    }

    const query = { ...baseQuery };

    if (handleIds.length) {
      query.handleId = { $in: handleIds };
    }

    if (and.length) query.$and = and;

    const items = await InfluencerProfile.find(query)
      .sort({ [sortBy]: sortOrder })
      .limit(limit)
      .select({
        __v: 0,
        rawChannel: 0,
        rawPlaylists: 0,
      })
      .lean();

    const dash = '—';

    const csvEscape = (v) => {
      const s = String(v ?? '');
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const fmt = (v) => {
      if (v == null || v === '') return dash;
      return String(v);
    };

    const fmtNum = (v) => {
      if (v == null || Number.isNaN(Number(v))) return dash;
      return String(v);
    };

    const fmtPercent = (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return dash;
      return `${(n * 100).toFixed(2)}%`;
    };

    const fmtBool = (v) => {
      if (v === true) return 'Yes';
      if (v === false) return 'No';
      return dash;
    };

    const fmtDateOnly = (v) => {
      if (!v) return dash;
      const d = v instanceof Date ? v : new Date(v);
      if (Number.isNaN(d.getTime())) return dash;
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    };

    const ytLink = (doc) => (doc?.handle ? `https://www.youtube.com/${doc.handle}` : dash);

    const igLink = (doc) => {
      const h = doc?.instagramHandle ? String(doc.instagramHandle).trim() : '';
      if (!h) return dash;
      const username = h.startsWith('@') ? h.slice(1) : h;
      return `https://www.instagram.com/${username}`;
    };

    const ttLink = () => dash;

    const niche = (doc) => {
      const labels = Array.isArray(doc?.topicLabels) ? doc.topicLabels : [];
      return labels[0] ? String(labels[0]) : dash;
    };

    const subNiche = (doc) => {
      const labels = Array.isArray(doc?.topicLabels) ? doc.topicLabels : [];
      return labels[1] ? String(labels[1]) : dash;
    };

    const followups = (doc) => {
      const arr = Array.isArray(doc?.followUpDates) ? doc.followUpDates : [];
      const dates = arr
        .map((x) => (x instanceof Date ? x : new Date(x)))
        .filter((d) => d && !Number.isNaN(d.getTime()))
        .sort((a, b) => b.getTime() - a.getTime());

      return {
        f1: dates[0] ? fmtDateOnly(dates[0]) : dash,
        f2: dates[1] ? fmtDateOnly(dates[1]) : dash,
      };
    };

    const header = [
      'Sr. No.',
      'Handle Title',
      'Influencer Handle',
      'Email',
      'Phone',
      'YouTube Handle link',
      'Instagram Handle link',
      'TikTok Handle link',
      'Country/Region',
      'Language',
      'Niche',
      'Sub-Niche',
      'Subscriber/Follower count',
      'Avg Views (last 15 videos)',
      'Engagement Rate',
      'Upload Frequency',
      'Last Sponsor',
      'Managed by Any Agency',
      'Top Audience Country',
      'Average Audience Age',
      'CollabGlam Demographics link',
      'Last Contacted Date',
      'Last Working Handle',
      'Last 1st followup date',
      'Last 2nd followup date',
      'Status',
      'Reply',
      'Notes',
    ];

    const lines = [header.map(csvEscape).join(',')];

    items.forEach((doc, idx) => {
      const fu = followups(doc);

      const row = [
        idx + 1,
        fmt(doc.title),
        fmt(doc.handle),
        fmt(doc.email),
        dash,
        ytLink(doc),
        igLink(doc),
        ttLink(doc),
        fmt(doc.country),
        fmt(doc.defaultLanguage),
        niche(doc),
        subNiche(doc),
        fmtNum(doc.subscriberCount),
        fmtNum(doc.avgViewsLast15),
        fmtPercent(doc.engagementRateLast15),
        doc.uploadFrequencyPerWeek != null ? String(doc.uploadFrequencyPerWeek) : dash,
        fmt(doc.lastSponsor),
        fmtBool(doc.managedByAgency),
        fmt(doc.topAudienceCountry),
        doc.averageAudienceAge != null ? String(doc.averageAudienceAge) : dash,
        dash,
        fmtDateOnly(doc.lastContactedAt),
        fmt(doc.workingHandle),
        fu.f1,
        fu.f2,
        dash,
        dash,
        dash,
      ];

      lines.push(row.map(csvEscape).join(','));
    });

    const csv = lines.join('\n');

    const ts = new Date();
    const stamp = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}${String(ts.getDate()).padStart(2, '0')}_${String(
      ts.getHours()
    ).padStart(2, '0')}${String(ts.getMinutes()).padStart(2, '0')}${String(ts.getSeconds()).padStart(2, '0')}`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="influencers_${stamp}.csv"`);

    return res.status(200).send(csv);
  } catch (err) {
    console.error('exportInfluencersCsv error:', err);
    await saveErrorLog(
      req,
      err,
      err?.response?.status || err?.statusCode || err?.status || 400,
      'EXPORT_INFLUENCERS_CSV_ERROR'
    );

    return res.status(400).json({
      status: 'error',
      message: err?.message || 'Failed to export influencers.',
    });
  }
});

exports.previewYouTubeProfile = asyncHandler(async (req, res) => {
  if (!YT_API_KEY) {
    return res.status(500).json({
      status: 'error',
      message: 'Missing YOUTUBE_API_KEY',
    });
  }

  const body = req.body || {};
  const handle = body.handle ? normalizeHandle(body.handle) : null;
  const channelId = cleanStrOrNull(body.channelId);
  const videosLimit = Math.min(50, Math.max(1, Number(body.videosLimit) || 15));

  if (!handle && !channelId) {
    return res.status(400).json({
      status: 'error',
      message: 'Provide handle or channelId.',
    });
  }

  const channel = handle
    ? await fetchChannelByHandle(handle)
    : await fetchChannelById(channelId);

  if (!channel) {
    return res.status(404).json({
      status: 'error',
      message: 'Channel not found.',
    });
  }

  const { resolvedHandle, profileData } = await buildYouTubeProfileData(channel, {
    inputHandle: handle,
    videosLimit,
  });

  return res.json({
    status: 'ok',
    mode: 'preview',
    stored: false,
    data: {
      ...profileData,
      handle: resolvedHandle,
    },
  });
});
