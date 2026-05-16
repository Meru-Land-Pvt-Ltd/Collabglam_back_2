'use strict';

const YoutubeInsightReport = require('../models/youtubeInsightReport');
const { toNumber, round, compactNumber, money, percent, formatDurationFromSeconds } = require('../utils/number');

const MS_PER_DAY = 86400000;

function toPlain(doc) {
  if (!doc) return {};
  if (typeof doc.toObject === 'function') return doc.toObject();
  return doc;
}

function safeDivide(n, d) {
  const denominator = toNumber(d);
  return denominator ? toNumber(n) / denominator : 0;
}

function daysSince(value) {
  if (!value) return 1;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 1;
  return Math.max(1, Math.floor((Date.now() - date.getTime()) / MS_PER_DAY));
}

function ageLabel(value) {
  const days = daysSince(value);
  if (days <= 1) return '1 day ago';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

function buildChannelUrl(channel = {}) {
  if (channel.channelUrl) return channel.channelUrl;
  if (channel.customUrl) return `https://www.youtube.com/${String(channel.customUrl).replace(/^\//, '')}`;
  if (channel.channelId) return `https://www.youtube.com/channel/${channel.channelId}`;
  return '';
}

function buildVideoUrl(report = {}) {
  if (report.videoUrl) return report.videoUrl;
  if (report.videoId) return `https://www.youtube.com/watch?v=${report.videoId}`;
  return '';
}

function scoreTone(score) {
  const value = toNumber(score);
  if (value >= 82) return 'excellent';
  if (value >= 68) return 'good';
  if (value >= 52) return 'average';
  return 'weak';
}

function buildHero(report) {
  const video = report.videoMetrics || {};
  const channel = report.channelMetrics || {};
  const hero = report.hero || {};
  return {
    influencerName: hero.influencerName || channel.title || video.channelTitle || 'YouTube Creator',
    platform: 'YouTube',
    livePublishedLink: hero.livePublishedLink || buildVideoUrl(report),
    thumbnailUrl: hero.thumbnailUrl || video.thumbnailUrl || '',
    publishDate: hero.publishDate || video.publishedAt || null,
    status: hero.status || report.reportStatus || 'Published',
    videoType: hero.videoType || (toNumber(video.durationSeconds) <= 90 ? 'short_form' : 'long_form'),
    videoTitle: hero.videoTitle || video.title || 'YouTube Video',
    channelThumbnailUrl: hero.channelThumbnailUrl || channel.thumbnailUrl || '',
    channelUrl: hero.channelUrl || buildChannelUrl(channel)
  };
}

function buildProfile(report) {
  const channel = report.channelMetrics || {};
  const hero = buildHero(report);
  const creator = report.creatorInsights || report.influencerInsights || {};
  return {
    name: hero.influencerName,
    handle: channel.customUrl || '',
    platform: 'YouTube',
    country: channel.country || '',
    avatarUrl: hero.channelThumbnailUrl,
    channelUrl: hero.channelUrl,
    subscriberCount: channel.subscriberCount || 0,
    subscriberCountDisplay: channel.hiddenSubscriberCount ? 'Hidden' : compactNumber(channel.subscriberCount),
    totalViewCount: channel.totalViewCount || 0,
    totalViewCountDisplay: compactNumber(channel.totalViewCount),
    videoCount: channel.videoCount || 0,
    videoCountDisplay: compactNumber(channel.videoCount),
    channelAge: channel.channelAge || '',
    status: 'Active',
    category: creator.primaryCategory || '',
    sizeTier: creator.sizeTier || '',
    authorityLevel: creator.authorityLevel || '',
    summary: report.aiInsights?.influencerSummary || `${hero.influencerName} is evaluated from public YouTube channel, video, comment, and recent-upload signals.`
  };
}

function buildVideoOverview(report) {
  const video = report.videoMetrics || {};
  const hero = buildHero(report);
  const creator = report.creatorInsights || report.influencerInsights || {};
  return {
    title: video.title || hero.videoTitle,
    description: video.description || '',
    descriptionPreview: String(video.description || '').slice(0, 220),
    thumbnailUrl: hero.thumbnailUrl,
    videoUrl: hero.livePublishedLink,
    channelUrl: hero.channelUrl,
    platform: 'YouTube',
    contentFormat: creator.contentFormat || '',
    publishedOn: video.publishedAt || hero.publishDate,
    duration: video.durationDisplay || formatDurationFromSeconds(video.durationSeconds),
    durationDisplay: video.durationDisplay || formatDurationFromSeconds(video.durationSeconds),
    durationSeconds: video.durationSeconds || 0,
    campaignStatus: 'Published',
    creatorName: hero.influencerName,
    creatorAvatarUrl: hero.channelThumbnailUrl,
    categoryName: video.categoryName || '',
    tags: video.tags || []
  };
}

function buildOverviewCards(report) {
  const video = report.videoMetrics || {};

  return [
    { key: 'video_views', label: 'Views', value: video.viewCount, displayValue: compactNumber(video.viewCount), subLabel: 'Current video', tone: 'success' },
    { key: 'video_likes', label: 'Likes', value: video.likeCount, displayValue: compactNumber(video.likeCount), subLabel: `${round(video.likeRate, 2)}% like rate`, tone: 'success' },
    { key: 'video_comments', label: 'Comments', value: video.commentCount, displayValue: compactNumber(video.commentCount), subLabel: `${round(video.commentRate, 2)}% comment rate`, tone: 'success' },
    { key: 'engagement_rate', label: 'Engagement', value: video.engagementRate, displayValue: `${round(video.engagementRate, 2)}%`, subLabel: 'Likes + comments / views', tone: toNumber(video.engagementRate) >= 3 ? 'success' : 'warning' }
  ];
}

function buildChannelOverview(report) {
  const channel = report.channelMetrics || {};
  return {
    name: channel.title || '',
    avatarUrl: channel.thumbnailUrl || '',
    handle: channel.customUrl || '',
    channelUrl: buildChannelUrl(channel),
    country: channel.country || '',
    channelAge: channel.channelAge || '',
    subscribers: channel.subscriberCount || 0,
    subscribersDisplay: channel.hiddenSubscriberCount ? 'Hidden' : compactNumber(channel.subscriberCount),
    totalViews: channel.totalViewCount || 0,
    totalViewsDisplay: compactNumber(channel.totalViewCount),
    totalVideos: channel.videoCount || 0,
    totalVideosDisplay: compactNumber(channel.videoCount),
    totalLikesAvailable: false,
    totalLikesNote: 'YouTube Data API does not expose total channel likes publicly.'
  };
}

function buildPerformanceEstimateCards(report) {
  const e = report.performanceEstimates || {};
  return [
    { key: 'estimated_ctr', label: 'Estimated CTR', displayValue: e.estimatedCtr?.displayValue || 'N/A', formula: e.estimatedCtr?.formula, note: e.estimatedCtr?.note, tone: 'warning' },
    { key: 'estimated_clicks', label: 'Estimated Clicks', displayValue: e.estimatedClicks?.displayValue || 'N/A', formula: e.estimatedClicks?.formula, note: e.estimatedClicks?.note, tone: 'warning' },
    { key: 'estimated_share_rate', label: 'Estimated Share Rate', displayValue: e.estimatedShareRate?.displayValue || 'N/A', formula: e.estimatedShareRate?.formula, note: e.estimatedShareRate?.note, tone: 'warning' },
    { key: 'estimated_shares', label: 'Estimated Shares', displayValue: e.estimatedShares?.displayValue || 'N/A', formula: e.estimatedShares?.formula, note: e.estimatedShares?.note, tone: 'warning' },
    { key: 'estimated_conversion_rate', label: 'Estimated Conversion Rate', displayValue: e.estimatedConversionRate?.displayValue || 'N/A', formula: e.estimatedConversionRate?.formula, note: e.estimatedConversionRate?.note, tone: 'warning' },
    { key: 'estimated_conversions', label: 'Estimated Conversions', displayValue: e.estimatedConversions?.displayValue || 'N/A', formula: e.estimatedConversions?.formula, note: e.estimatedConversions?.note, tone: 'warning' },
    { key: 'estimated_save_rate', label: 'Estimated Save Rate', displayValue: e.estimatedSaveRate?.displayValue || 'N/A', formula: e.estimatedSaveRate?.formula, note: e.estimatedSaveRate?.note, tone: 'warning' },
    { key: 'estimated_saves', label: 'Estimated Saves', displayValue: e.estimatedSaves?.displayValue || 'N/A', formula: e.estimatedSaves?.formula, note: e.estimatedSaves?.note, tone: 'warning' }
  ];
}

function buildEstimatedWatchTime(report) {
  const e = report.performanceEstimates || {};
  return {
    retentionRate: e.estimatedRetentionRate,
    averageViewDurationSeconds: e.estimatedAverageViewDurationSeconds,
    totalWatchTimeMinutes: e.estimatedWatchTimeMinutes,
    totalWatchTimeHours: e.estimatedWatchTimeHours,
    formula: e.estimatedWatchTimeMinutes?.formula || 'views * averageViewDurationSeconds / 60',
    note: 'Estimated from public views, duration, engagement, sentiment, and duration benchmark. Actual watch time requires YouTube Analytics OAuth.'
  };
}

function buildEstimatedRevenue(report) {
  const video = report.videoMetrics || {};
  const e = report.performanceEstimates || {};
  const low = toNumber(e.estimatedRevenueLow?.value);
  const high = toNumber(e.estimatedRevenueHigh?.value);
  return {
    title: 'Estimated YouTube Revenue',
    subtitle: 'Public estimate',
    source: 'Estimated from public views and assumed RPM range. Not actual YouTube Analytics revenue.',
    rpmLow: e.rpmLow || 1.36,
    rpmHigh: e.rpmHigh || 3.4,
    totalVideoViews: video.viewCount || 0,
    totalVideoViewsDisplay: compactNumber(video.viewCount),
    estimatedRevenueLow: low,
    estimatedRevenueHigh: high,
    estimatedRevenueRangeDisplay: `${money(low)} - ${money(high)}`,
    available: true,
    isEstimate: true
  };
}

function buildAudienceMatch(report) {
  const score = report.aiScores?.channelFitScore || report.aiScores?.finalAiScore || report.finalVerdict?.finalScore || 0;
  return {
    score: Math.round(score),
    label: score >= 80 ? 'Audience Match Score is Excellent' : score >= 60 ? 'Audience Match Score is Good' : score >= 40 ? 'Audience Match Score is Average' : 'Audience Match Score is Low',
    note: 'This score shows fit between creator, channel baseline, topic, comments, and public engagement.'
  };
}

function buildAudienceSignals(report) {
  const sentiment = report.commentIntelligence?.sentiment || {};
  const country = report.channelMetrics?.country || '';
  return {
    available: Boolean(country),
    note: country ? 'Country is from public channel country. Detailed demographics require YouTube Analytics OAuth.' : 'Gender, age, device, and detailed geography require YouTube Analytics OAuth.',
    sentimentFallback: [
      { label: 'Positive', value: round(sentiment.positive, 2) },
      { label: 'Neutral', value: round(sentiment.neutral, 2) },
      { label: 'Negative', value: round(sentiment.negative, 2) }
    ],
    topCountries: country ? [{ country, percentage: 100, source: 'Public channel country' }] : []
  };
}

function buildTopInterests(report) {
  const video = report.videoMetrics || {};
  const channel = report.channelMetrics || {};
  const creator = report.creatorInsights || report.influencerInsights || {};
  return [creator.primaryCategory, creator.youtubeCategory, ...(creator.secondaryCategories || []), ...(video.tags || []), ...(channel.topicDetails?.topicCategories || []), creator.contentFormat]
    .filter(Boolean)
    .map((item) => String(item).split('/').pop().replace(/_/g, ' '))
    .filter(Boolean)
    .slice(0, 60);
}

function buildCreatorFit(report) {
  const creator = report.creatorInsights || report.influencerInsights || {};
  return {
    title: 'Creator Fit',
    primaryCategory: creator.primaryCategory || 'General Creator',
    youtubeCategory: creator.youtubeCategory || report.videoMetrics?.categoryName || '',
    categoryConfidence: creator.categoryConfidence || 0,
    secondaryCategories: creator.secondaryCategories || [],
    contentFormat: creator.contentFormat || '',
    sizeTier: creator.sizeTier || '',
    authorityLevel: creator.authorityLevel || '',
    bestUseCases: creator.bestUseCases || [],
    notBestFor: creator.notBestFor || [],
    positioning: creator.positioning || '',
    recommendation: creator.recommendation || ''
  };
}

function buildCommentRows(report) {
  const categories = report.commentIntelligence?.categories || {};
  const map = [
    ['purchaseIntent', 'Purchase Intent', 'success'],
    ['positiveReactions', 'Positive Reactions', 'success'],
    ['priceAvailabilityQuestions', 'Price / Availability', 'warning'],
    ['trustSignals', 'Trust Signals', 'success'],
    ['negativeSkeptical', 'Negative / Skeptical', 'danger'],
    ['spamIrrelevant', 'Spam / Irrelevant', 'danger'],
    ['sponsorshipConcerns', 'Sponsorship Concerns', 'warning'],
    ['productProofQuestions', 'Proof / Demo Questions', 'default']
  ];
  return map.filter(([key]) => categories[key]).map(([key, label, tone]) => ({ key, label, count: toNumber(categories[key]?.count), insight: categories[key]?.insight || '', tone }));
}

function buildCommentBreakdown(report) {
  const comment = report.commentIntelligence || {};
  const sentiment = comment.sentiment || {};
  const themeRows = [
    ...(comment.commonThemes || []),
    ...(comment.topQuestions || []).map((theme) => ({ theme, type: 'question' })),
    ...(comment.topPurchaseIntentExamples || []).map((theme) => ({ theme, type: 'purchase_intent' })),
    ...(comment.topTrustExamples || []).map((theme) => ({ theme, type: 'trust' })),
    ...(comment.topObjections || []).map((theme) => ({ theme, type: 'objection' }))
  ].slice(0, 20);
  return {
    title: 'Comment Breakdown',
    totalComments: comment.totalCommentsAnalyzed || 0,
    sentiment: { positive: round(sentiment.positive, 2), neutral: round(sentiment.neutral, 2), negative: round(sentiment.negative, 2), label: sentiment.label || 'Mixed / neutral' },
    rows: buildCommentRows(report),
    topCommentThemes: themeRows,
    topComments: comment.topComments || [],
    commentTabs: comment.commentTabs || {},
    topQuestions: comment.topQuestions || [],
    topPurchaseIntentExamples: comment.topPurchaseIntentExamples || [],
    topTrustExamples: comment.topTrustExamples || [],
    topObjections: comment.topObjections || []
  };
}

function normalizeRecentVideo(video) {
  const snippet = video.snippet || {};
  const stats = video.statistics || {};
  const contentDetails = video.contentDetails || {};
  const videoId = video.id || video.videoId || video.contentDetails?.videoId;
  return {
    videoId,
    title: snippet.title || video.title || '',
    url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : '',
    thumbnailUrl: snippet.thumbnails?.maxres?.url || snippet.thumbnails?.standard?.url || snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || video.thumbnailUrl || '',
    publishedAt: snippet.publishedAt || video.publishedAt || null,
    dateLabel: ageLabel(snippet.publishedAt || video.publishedAt || null),
    viewCount: toNumber(stats.viewCount || video.viewCount),
    likeCount: toNumber(stats.likeCount || video.likeCount),
    commentCount: toNumber(stats.commentCount || video.commentCount),
    duration: contentDetails.duration || video.duration || '',
    durationDisplay: video.durationDisplay || ''
  };
}

function buildLastVideosComparison(report) {
  const baseline = report.channelBaseline || report.performanceComparison || {};
  const current = report.videoMetrics || {};
  const rows = (report.rawData?.recentVideosSample || []).map(normalizeRecentVideo).filter((item) => item.videoId).slice(0, 10);
  const buildChange = (value, avg) => avg ? round(((toNumber(value) - toNumber(avg)) / toNumber(avg)) * 100, 1) : null;
  return {
    title: 'Recent Uploads Comparison',
    averageViews: baseline.creatorAverageViews || 0,
    averageViewsDisplay: compactNumber(baseline.creatorAverageViews),
    averageLikes: baseline.creatorAverageLikes || 0,
    averageLikesDisplay: compactNumber(baseline.creatorAverageLikes),
    averageComments: baseline.creatorAverageComments || 0,
    averageCommentsDisplay: compactNumber(baseline.creatorAverageComments),
    tabs: ['Views', 'Likes', 'Comment'],
    rows: rows.map((row) => ({
      ...row,
      viewCountDisplay: compactNumber(row.viewCount),
      likeCountDisplay: compactNumber(row.likeCount),
      commentCountDisplay: compactNumber(row.commentCount),
      viewsChangePercentage: buildChange(row.viewCount, baseline.creatorAverageViews),
      likesChangePercentage: buildChange(row.likeCount, baseline.creatorAverageLikes),
      commentsChangePercentage: buildChange(row.commentCount, baseline.creatorAverageComments),
      viewsTrend: row.viewCount >= toNumber(baseline.creatorAverageViews) ? 'up' : 'down',
      likesTrend: row.likeCount >= toNumber(baseline.creatorAverageLikes) ? 'up' : 'down',
      commentsTrend: row.commentCount >= toNumber(baseline.creatorAverageComments) ? 'up' : 'down'
    })),
    currentVideo: {
      views: current.viewCount,
      likes: current.likeCount,
      comments: current.commentCount
    }
  };
}

function buildPerformanceComparison(report) {
  const baseline = report.channelBaseline || report.performanceComparison || {};
  return {
    title: 'Video vs Creator Average',
    summary: baseline.comparisonResult || '',
    comparisonResult: baseline.comparisonResult || '',
    rows: baseline.rows || []
  };
}

function buildContentPerformanceSummary(report) {
  const video = report.videoMetrics || {};
  const watch = buildEstimatedWatchTime(report);
  const revenue = buildEstimatedRevenue(report);
  const estimates = report.performanceEstimates || {};
  const days = daysSince(video.publishedAt || video.publishDate || report.hero?.publishDate);
  return {
    title: 'Video Performance Summary',
    rows: [
      { label: 'Engagement Rate', value: `${round(video.engagementRate, 2)}%` },
      { label: 'Like Rate', value: `${percent(video.likeCount, video.viewCount)}%` },
      { label: 'Comment Rate', value: `${percent(video.commentCount, video.viewCount)}%` },
      { label: 'Duration', value: video.durationDisplay || formatDurationFromSeconds(video.durationSeconds) },
      { label: 'Estimated CTR', value: estimates.estimatedCtr?.displayValue || 'N/A' },
      { label: 'Estimated Conversion Rate', value: estimates.estimatedConversionRate?.displayValue || 'N/A' },
      { label: 'Estimated Share Rate', value: estimates.estimatedShareRate?.displayValue || 'N/A' },
      { label: 'Estimated Shares', value: estimates.estimatedShares?.displayValue || 'N/A' },
      { label: 'Estimated Watch Time', value: `${watch.totalWatchTimeHours?.displayValue || '0'} hrs` },
      { label: 'Avg. Views / Day', value: compactNumber(safeDivide(video.viewCount, days)) },
      { label: 'Estimated Revenue', value: revenue.estimatedRevenueRangeDisplay }
    ]
  };
}

function buildAiSummary(report) {
  const ai = report.aiSummary || report.aiInsights || {};
  return {
    title: 'AI Summary',
    ...ai,
    finalReason: report.finalVerdict?.reason || ''
  };
}

function buildScoreCards(report) {
  const scores = report.aiScores || {};
  return [
    ['engagementQuality', 'Engagement Quality'],
    ['sentimentScore', 'Sentiment Score'],
    ['commentQualityScore', 'Comment Quality'],
    ['creatorAuthorityScore', 'Creator Authority'],
    ['contentEffectivenessScore', 'Content Effectiveness'],
    ['conversionPotentialScore', 'Conversion Potential'],
    ['channelFitScore', 'Audience Match'],
    ['finalAiScore', 'Final Creator Score']
  ].map(([key, label]) => ({ key, label, value: scores[key] || 0, displayValue: `${Math.round(toNumber(scores[key]))}/100`, tone: scoreTone(scores[key]) }));
}

function buildOtherDeliverables(report) {
  const hero = buildHero(report);
  const profile = buildProfile(report);
  return (report.rawData?.recentVideosSample || []).map(normalizeRecentVideo).filter((item) => item.videoId && item.videoId !== report.videoId).slice(0, 3).map((item) => ({
    videoId: item.videoId,
    title: item.title,
    url: item.url,
    thumbnailUrl: item.thumbnailUrl,
    platform: 'YouTube',
    creatorName: profile.name,
    creatorAvatarUrl: profile.avatarUrl,
    publishedAt: item.publishedAt,
    durationDisplay: item.durationDisplay || hero.videoType
  }));
}

function buildChartData(report) {
  const comment = report.commentIntelligence || {};
  const sentiment = comment.sentiment || {};
  return {
    sentimentDonut: [
      { label: 'Positive', value: round(sentiment.positive, 2) },
      { label: 'Neutral', value: round(sentiment.neutral, 2) },
      { label: 'Negative', value: round(sentiment.negative, 2) }
    ],
    recentVideos: buildLastVideosComparison(report).rows,
    estimateCards: buildPerformanceEstimateCards(report)
  };
}

function buildYoutubeInsightDashboard(inputReport) {
  const report = toPlain(inputReport);
  return {
    reportId: String(report._id || report.reportId || ''),
    reportType: report.reportType || 'YouTube Link Intelligence Report',
    platform: 'YouTube',
    reportStatus: report.reportStatus || 'Published',
    generatedAt: report.createdAt || report.generatedAt || null,
    hero: buildHero(report),
    profile: buildProfile(report),
    channelOverview: buildChannelOverview(report),
    videoOverview: buildVideoOverview(report),
    overviewCards: buildOverviewCards(report),
    kpiCards: buildOverviewCards(report),
    aiSummary: buildAiSummary(report),
    creatorFit: buildCreatorFit(report),
    influencerCategory: buildCreatorFit(report),
    topInterests: buildTopInterests(report),
    performanceEstimates: report.performanceEstimates || {},
    performanceEstimateCards: buildPerformanceEstimateCards(report),
    estimatedWatchTime: buildEstimatedWatchTime(report),
    estimatedRevenue: buildEstimatedRevenue(report),
    audienceMatch: buildAudienceMatch(report),
    audienceDemographic: buildAudienceSignals(report),
    contentPerformanceSummary: buildContentPerformanceSummary(report),
    performanceComparison: buildPerformanceComparison(report),
    commentBreakdown: buildCommentBreakdown(report),
    lastVideosComparison: buildLastVideosComparison(report),
    scoreCards: buildScoreCards(report),
    finalVerdict: report.finalVerdict || {},
    otherDeliverables: buildOtherDeliverables(report),
    dataAvailability: { ...(report.dataAvailability || {}), notes: (report.dataAvailability?.notes || []).length ? report.dataAvailability.notes : ['This report uses public YouTube data only. CTR, shares, saves, conversions, retention, watch time, and revenue are formula estimates unless Analytics/tracking is connected.'] }
  };
}

function formatYoutubeInsightReport(report, options = {}) {
  const plain = toPlain(report);
  const dashboard = plain.dashboard || buildYoutubeInsightDashboard(plain);
  const output = {
    reportId: String(plain._id || plain.reportId || dashboard.reportId || ''),
    frontendReport: dashboard,
    dashboard,
    aiSummary: dashboard.aiSummary || plain.aiSummary || plain.aiInsights || {},
    aiInsights: plain.aiInsights || plain.aiSummary || dashboard.aiSummary || {},
    finalVerdict: dashboard.finalVerdict || plain.finalVerdict || {},
    performanceEstimates: dashboard.performanceEstimates || plain.performanceEstimates || {},
    estimatedWatchTime: dashboard.estimatedWatchTime || plain.estimatedWatchTime || {},
    estimatedRevenue: dashboard.estimatedRevenue || plain.estimatedRevenue || {}
  };
  if (options.includeRawData) output.rawData = plain.rawData || {};
  if (options.includeRawReport) output.report = plain;
  if (options.includeDebug) {
    output.debug = {
      aiSource: plain.aiSummary?.source || plain.aiInsights?.source || dashboard.aiSummary?.source,
      openAiModel: plain.aiSummary?._rawModel || plain.aiInsights?._rawModel || '',
      estimatedMetricsUsed: true
    };
  }
  return output;
}

async function getYoutubeLinkInsightSummary({ filter = {}, limit = 500 } = {}) {
  const reports = await YoutubeInsightReport.find(filter).sort({ createdAt: -1 }).limit(Math.min(Math.max(toNumber(limit, 500), 1), 1000)).lean();
  const total = reports.length;
  const totals = reports.reduce((acc, report) => {
    acc.views += toNumber(report.videoMetrics?.viewCount);
    acc.likes += toNumber(report.videoMetrics?.likeCount);
    acc.comments += toNumber(report.videoMetrics?.commentCount);
    acc.score += toNumber(report.aiScores?.finalAiScore);
    return acc;
  }, { views: 0, likes: 0, comments: 0, score: 0 });
  return {
    totalReports: total,
    totalViews: totals.views,
    totalViewsDisplay: compactNumber(totals.views),
    totalLikes: totals.likes,
    totalComments: totals.comments,
    averageCreatorScore: total ? round(totals.score / total, 1) : 0,
    latestReports: reports.slice(0, 10).map((report) => formatYoutubeInsightReport(report).dashboard)
  };
}

module.exports = {
  buildYoutubeInsightDashboard,
  buildChartData,
  buildEstimatedRevenue,
  formatYoutubeInsightReport,
  getYoutubeLinkInsightSummary
};
