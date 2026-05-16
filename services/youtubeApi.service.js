'use strict';

const axios = require('axios');
const {
  toNumber,
  parseIsoDurationToSeconds,
  percent,
  getAgeLabel,
  round,
  compactNumber,
  formatDurationFromSeconds
} = require('../utils/number');

const YOUTUBE_BASE_URL = 'https://www.googleapis.com/youtube/v3';

const PUBLIC_VIDEO_PARTS = [
  'snippet',
  'contentDetails',
  'statistics',
  'status',
  'player',
  'topicDetails',
  'recordingDetails',
  'liveStreamingDetails',
  'paidProductPlacementDetails'
];

const PUBLIC_CHANNEL_PARTS = [
  'snippet',
  'contentDetails',
  'statistics',
  'status',
  'brandingSettings',
  'topicDetails',
  'localizations'
];

const VIDEO_CATEGORY_MAP = {
  1: 'Film & Animation',
  2: 'Autos & Vehicles',
  10: 'Music',
  15: 'Pets & Animals',
  17: 'Sports',
  18: 'Short Movies',
  19: 'Travel & Events',
  20: 'Gaming',
  21: 'Videoblogging',
  22: 'People & Blogs',
  23: 'Comedy',
  24: 'Entertainment',
  25: 'News & Politics',
  26: 'Howto & Style',
  27: 'Education',
  28: 'Science & Technology',
  29: 'Nonprofits & Activism',
  30: 'Movies',
  31: 'Anime/Animation',
  32: 'Action/Adventure',
  33: 'Classics',
  34: 'Comedy',
  35: 'Documentary',
  36: 'Drama',
  37: 'Family',
  38: 'Foreign',
  39: 'Horror',
  40: 'Sci-Fi/Fantasy',
  41: 'Thriller',
  42: 'Shorts',
  43: 'Shows',
  44: 'Trailers'
};

function getApiKey() {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    const error = new Error('YOUTUBE_API_KEY is missing in environment variables.');
    error.statusCode = 500;
    throw error;
  }
  return key;
}

function normalizeYouTubeError(error) {
  const status = error.response?.status || error.statusCode || 500;
  const apiError = error.response?.data?.error;
  const apiMessage = apiError?.message;
  const apiReason = apiError?.errors?.[0]?.reason || error.reason || '';
  const apiDomain = apiError?.errors?.[0]?.domain || '';

  const wrapped = new Error(apiMessage || error.message || 'YouTube API request failed.');
  wrapped.statusCode = status;
  wrapped.reason = apiReason;
  wrapped.domain = apiDomain;
  wrapped.raw = apiError || null;
  return wrapped;
}

async function youtubeGet(endpoint, params = {}) {
  try {
    const response = await axios.get(`${YOUTUBE_BASE_URL}/${endpoint}`, {
      params: {
        key: getApiKey(),
        ...params
      },
      timeout: Number(process.env.YOUTUBE_TIMEOUT_MS || 20000)
    });

    return response.data;
  } catch (error) {
    throw normalizeYouTubeError(error);
  }
}

function chunkArray(items = [], size = 50) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function getVideoDetails(videoId) {
  const data = await youtubeGet('videos', {
    part: PUBLIC_VIDEO_PARTS.join(','),
    id: videoId
  });

  const video = data.items?.[0];
  if (!video) {
    const error = new Error('Video not found or unavailable.');
    error.statusCode = 404;
    throw error;
  }

  return video;
}

async function getChannelDetails(channelId) {
  const data = await youtubeGet('channels', {
    part: PUBLIC_CHANNEL_PARTS.join(','),
    id: channelId
  });

  const channel = data.items?.[0];
  if (!channel) {
    const error = new Error('Channel not found or unavailable.');
    error.statusCode = 404;
    throw error;
  }

  return channel;
}

async function getCommentReplies(parentId, maxReplies = 100) {
  const safeMax = Math.max(0, Math.min(toNumber(maxReplies, 100), 500));
  if (!parentId || !safeMax) return [];

  const replies = [];
  let pageToken = null;

  while (replies.length < safeMax) {
    const remaining = safeMax - replies.length;
    const data = await youtubeGet('comments', {
      part: 'snippet',
      parentId,
      maxResults: Math.min(100, remaining),
      textFormat: 'plainText',
      pageToken: pageToken || undefined
    });

    const rows = (data.items || []).map((reply) => ({
      commentId: reply.id,
      parentId,
      authorDisplayName: reply.snippet?.authorDisplayName || '',
      authorChannelId: reply.snippet?.authorChannelId?.value || '',
      authorProfileImageUrl: reply.snippet?.authorProfileImageUrl || '',
      text: reply.snippet?.textOriginal || reply.snippet?.textDisplay || '',
      likeCount: toNumber(reply.snippet?.likeCount),
      publishedAt: reply.snippet?.publishedAt || null,
      updatedAt: reply.snippet?.updatedAt || null,
      isReply: true
    }));

    replies.push(...rows);
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  return replies;
}

async function getPublicCommentThreads(videoId, maxComments = 300, options = {}) {
  const maxAllowed = Math.max(0, Math.min(toNumber(maxComments, 300), 500));
  if (!maxAllowed) {
    return {
      comments: [],
      replies: [],
      disabled: false,
      error: null,
      repliesFullyFetched: false,
      commentCountFetched: 0,
      replyCountFetched: 0
    };
  }

  const includeReplies = Boolean(options.includeReplies);
  const maxRepliesPerThread = Math.max(0, Math.min(toNumber(options.maxRepliesPerThread, 25), 100));
  const order = options.order === 'time' ? 'time' : 'relevance';

  const comments = [];
  const replies = [];
  let pageToken = null;

  try {
    while (comments.length < maxAllowed) {
      const remaining = maxAllowed - comments.length;
      const data = await youtubeGet('commentThreads', {
        part: 'snippet,replies',
        videoId,
        maxResults: Math.min(100, remaining),
        order,
        textFormat: 'plainText',
        pageToken: pageToken || undefined
      });

      for (const item of data.items || []) {
        const top = item.snippet?.topLevelComment;
        const snippet = top?.snippet || {};
        const previewReplies = (item.replies?.comments || []).map((reply) => ({
          commentId: reply.id,
          parentId: top?.id || '',
          authorDisplayName: reply.snippet?.authorDisplayName || '',
          authorChannelId: reply.snippet?.authorChannelId?.value || '',
          authorProfileImageUrl: reply.snippet?.authorProfileImageUrl || '',
          text: reply.snippet?.textOriginal || reply.snippet?.textDisplay || '',
          likeCount: toNumber(reply.snippet?.likeCount),
          publishedAt: reply.snippet?.publishedAt || null,
          updatedAt: reply.snippet?.updatedAt || null,
          isReply: true,
          previewOnly: true
        }));

        const row = {
          commentThreadId: item.id,
          commentId: top?.id || '',
          authorDisplayName: snippet.authorDisplayName || '',
          authorChannelId: snippet.authorChannelId?.value || '',
          authorProfileImageUrl: snippet.authorProfileImageUrl || '',
          text: snippet.textOriginal || snippet.textDisplay || '',
          likeCount: toNumber(snippet.likeCount),
          publishedAt: snippet.publishedAt || null,
          updatedAt: snippet.updatedAt || null,
          replyCount: toNumber(item.snippet?.totalReplyCount),
          canReply: item.snippet?.canReply !== false,
          isPublic: item.snippet?.isPublic !== false,
          repliesPreview: previewReplies,
          isReply: false
        };

        comments.push(row);

        if (includeReplies && row.commentId && row.replyCount > 0) {
          const fetchedReplies = await getCommentReplies(row.commentId, maxRepliesPerThread);
          replies.push(...fetchedReplies);
        } else if (!includeReplies) {
          replies.push(...previewReplies);
        }
      }

      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }

    return {
      comments,
      replies,
      disabled: false,
      error: null,
      repliesFullyFetched: includeReplies,
      commentCountFetched: comments.length,
      replyCountFetched: replies.length
    };
  } catch (error) {
    if (error.statusCode === 403 && error.reason === 'commentsDisabled') {
      return {
        comments: [],
        replies: [],
        disabled: true,
        error: error.message,
        repliesFullyFetched: false,
        commentCountFetched: 0,
        replyCountFetched: 0
      };
    }
    throw error;
  }
}

async function getRecentChannelVideoIds(uploadPlaylistId, limit = 12) {
  if (!uploadPlaylistId) return [];

  const safeLimit = Math.min(Math.max(toNumber(limit, 12), 1), 50);
  const data = await youtubeGet('playlistItems', {
    part: 'snippet,contentDetails,status',
    playlistId: uploadPlaylistId,
    maxResults: safeLimit
  });

  return (data.items || [])
    .map((item) => item.contentDetails?.videoId || item.snippet?.resourceId?.videoId)
    .filter(Boolean);
}

async function getVideosStats(videoIds = []) {
  const ids = [...new Set((videoIds || []).filter(Boolean))].slice(0, 50);
  if (!ids.length) return [];

  const all = [];
  for (const batch of chunkArray(ids, 50)) {
    const data = await youtubeGet('videos', {
      part: 'snippet,contentDetails,statistics,status,topicDetails',
      id: batch.join(',')
    });
    all.push(...(data.items || []));
  }

  return all;
}

function getBestThumbnail(thumbnails = {}) {
  return (
    thumbnails?.maxres?.url ||
    thumbnails?.standard?.url ||
    thumbnails?.high?.url ||
    thumbnails?.medium?.url ||
    thumbnails?.default?.url ||
    ''
  );
}

function getVideoCategoryName(categoryId) {
  return VIDEO_CATEGORY_MAP[toNumber(categoryId)] || 'Uncategorized';
}

function buildChannelUrl(channel = {}) {
  const customUrl = channel.snippet?.customUrl || channel.customUrl || '';
  const channelId = channel.id || channel.channelId || '';
  if (customUrl) return `https://www.youtube.com/${String(customUrl).replace(/^\//, '')}`;
  if (channelId) return `https://www.youtube.com/channel/${channelId}`;
  return '';
}

function normalizeVideo(video) {
  const snippet = video.snippet || {};
  const statistics = video.statistics || {};
  const contentDetails = video.contentDetails || {};
  const status = video.status || {};

  const viewCount = toNumber(statistics.viewCount);
  const likeCount = toNumber(statistics.likeCount);
  const commentCount = toNumber(statistics.commentCount);
  const durationSeconds = parseIsoDurationToSeconds(contentDetails.duration);
  const engagementRate = percent(likeCount + commentCount, viewCount);
  const likeRate = percent(likeCount, viewCount);
  const commentRate = percent(commentCount, viewCount);

  return {
    videoId: video.id,
    title: snippet.title || '',
    description: snippet.description || '',
    channelId: snippet.channelId || '',
    channelTitle: snippet.channelTitle || '',
    publishedAt: snippet.publishedAt ? new Date(snippet.publishedAt) : null,
    publishDate: snippet.publishedAt ? new Date(snippet.publishedAt) : null,
    thumbnails: snippet.thumbnails || {},
    thumbnailUrl: getBestThumbnail(snippet.thumbnails),
    tags: Array.isArray(snippet.tags) ? snippet.tags : [],
    categoryId: snippet.categoryId || '',
    categoryName: getVideoCategoryName(snippet.categoryId),
    defaultLanguage: snippet.defaultLanguage || '',
    defaultAudioLanguage: snippet.defaultAudioLanguage || '',
    liveBroadcastContent: snippet.liveBroadcastContent || 'none',
    duration: contentDetails.duration || '',
    durationSeconds,
    durationDisplay: formatDurationFromSeconds(durationSeconds),
    definition: contentDetails.definition || '',
    captionAvailable: contentDetails.caption === 'true',
    licensedContent: Boolean(contentDetails.licensedContent),
    projection: contentDetails.projection || '',
    privacyStatus: status.privacyStatus || '',
    uploadStatus: status.uploadStatus || '',
    embeddable: Boolean(status.embeddable),
    publicStatsViewable: status.publicStatsViewable !== false,
    madeForKids: Boolean(status.madeForKids),
    containsSyntheticMedia: Boolean(status.containsSyntheticMedia),
    hasPaidProductPlacement: Boolean(video.paidProductPlacementDetails?.hasPaidProductPlacement),
    viewCount,
    likeCount,
    commentCount,
    favoriteCount: toNumber(statistics.favoriteCount),
    engagementRate,
    likeRate,
    commentRate,
    player: video.player || {},
    topicDetails: video.topicDetails || {},
    recordingDetails: video.recordingDetails || {},
    liveStreamingDetails: video.liveStreamingDetails || {}
  };
}

function normalizeChannel(channel) {
  const snippet = channel.snippet || {};
  const statistics = channel.statistics || {};
  const brandingSettings = channel.brandingSettings || {};
  const subscriberCount = toNumber(statistics.subscriberCount);
  const totalViewCount = toNumber(statistics.viewCount);
  const videoCount = toNumber(statistics.videoCount);

  return {
    channelId: channel.id,
    title: snippet.title || '',
    description: snippet.description || '',
    customUrl: snippet.customUrl || '',
    channelUrl: buildChannelUrl(channel),
    publishedAt: snippet.publishedAt ? new Date(snippet.publishedAt) : null,
    channelAge: getAgeLabel(snippet.publishedAt),
    country: snippet.country || brandingSettings.channel?.country || '',
    thumbnails: snippet.thumbnails || {},
    thumbnailUrl: getBestThumbnail(snippet.thumbnails),
    subscriberCount,
    subscriberCountDisplay: compactNumber(subscriberCount),
    hiddenSubscriberCount: Boolean(statistics.hiddenSubscriberCount),
    totalViewCount,
    totalViewCountDisplay: compactNumber(totalViewCount),
    videoCount,
    videoCountDisplay: compactNumber(videoCount),
    uploadsPlaylistId: channel.contentDetails?.relatedPlaylists?.uploads || '',
    likesPlaylistId: channel.contentDetails?.relatedPlaylists?.likes || '',
    privacyStatus: channel.status?.privacyStatus || '',
    isLinked: Boolean(channel.status?.isLinked),
    longUploadsStatus: channel.status?.longUploadsStatus || '',
    madeForKids: Boolean(channel.status?.madeForKids),
    branding: brandingSettings,
    topicDetails: channel.topicDetails || {},
    localized: snippet.localized || {}
  };
}

function calculateCreatorAverage(videos = [], currentVideoId) {
  const usable = videos
    .filter((video) => video.id !== currentVideoId)
    .map(normalizeVideo)
    .filter((video) => video.viewCount > 0);

  if (!usable.length) {
    return {
      sampleSize: 0,
      averageViews: 0,
      averageLikes: 0,
      averageComments: 0,
      averageEngagementRate: 0,
      averageDurationSeconds: 0,
      lastPublishedAt: null
    };
  }

  const totals = usable.reduce(
    (acc, video) => {
      acc.views += video.viewCount;
      acc.likes += video.likeCount;
      acc.comments += video.commentCount;
      acc.engagementRate += video.engagementRate;
      acc.durationSeconds += video.durationSeconds;
      return acc;
    },
    { views: 0, likes: 0, comments: 0, engagementRate: 0, durationSeconds: 0 }
  );

  const sorted = usable
    .filter((video) => video.publishedAt)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  return {
    sampleSize: usable.length,
    averageViews: Math.round(totals.views / usable.length),
    averageLikes: Math.round(totals.likes / usable.length),
    averageComments: Math.round(totals.comments / usable.length),
    averageEngagementRate: round(totals.engagementRate / usable.length),
    averageDurationSeconds: Math.round(totals.durationSeconds / usable.length),
    lastPublishedAt: sorted[0]?.publishedAt || null
  };
}

module.exports = {
  getVideoDetails,
  getChannelDetails,
  getPublicCommentThreads,
  getCommentReplies,
  getRecentChannelVideoIds,
  getVideosStats,
  getBestThumbnail,
  getVideoCategoryName,
  normalizeVideo,
  normalizeChannel,
  calculateCreatorAverage
};
