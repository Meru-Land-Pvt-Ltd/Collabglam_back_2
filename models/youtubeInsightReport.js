'use strict';

const mongoose = require('mongoose');

const { Schema } = mongoose;
const Mixed = Schema.Types.Mixed;

const MetricValueSchema = new Schema(
  {
    value: { type: Number, default: null },
    displayValue: { type: String, trim: true, default: '' },
    source: { type: String, trim: true, default: '' },
    available: { type: Boolean, default: false },
    estimated: { type: Boolean, default: false },
    formula: { type: String, trim: true, default: '' },
    note: { type: String, trim: true, default: '' }
  },
  { _id: false }
);

const CreatorInsightSchema = new Schema(
  {
    primaryCategory: String,
    youtubeCategory: String,
    categoryConfidence: Number,
    secondaryCategories: [String],
    contentFormat: String,
    sizeTier: String,
    authorityLevel: String,
    bestUseCases: [String],
    notBestFor: [String],
    positioning: String,
    recommendation: String
  },
  { _id: false }
);

const YoutubeInsightReportSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    createdByAdminId: { type: Schema.Types.ObjectId, ref: 'Master', default: null, index: true },
    createdByAdminName: { type: String, trim: true, default: '' },
    createdByAdminEmail: { type: String, trim: true, lowercase: true, default: '' },
    createdByAdminRole: { type: String, trim: true, lowercase: true, default: '' },
    brandId: { type: Schema.Types.ObjectId, ref: 'Brand', default: null, index: true },
    brandName: { type: String, trim: true, default: '' },
    sourceContext: { type: String, trim: true, default: 'brand_insight_os', index: true },

    reportType: { type: String, default: 'YouTube Public Video Insight Report' },
    platform: { type: String, default: 'YouTube', index: true },
    reportStatus: { type: String, enum: ['Published', 'Completed', 'Failed'], default: 'Published', index: true },
    sourceType: { type: String, default: 'public_youtube_link', index: true },

    videoUrl: { type: String, required: true, trim: true },
    videoId: { type: String, required: true, trim: true, index: true },

    hero: {
      influencerName: { type: String, default: '' },
      platform: { type: String, default: 'YouTube' },
      livePublishedLink: { type: String, default: '' },
      thumbnailUrl: { type: String, default: '' },
      publishDate: { type: Date, default: null },
      status: { type: String, default: 'Published' },
      campaignStatus: { type: String, default: 'Published' },
      videoType: { type: String, default: '' },
      videoTitle: { type: String, default: '' },
      channelThumbnailUrl: { type: String, default: '' },
      channelUrl: { type: String, default: '' }
    },

    videoMetrics: {
      videoId: String,
      title: String,
      description: String,
      channelId: String,
      channelTitle: String,
      publishedAt: Date,
      publishDate: Date,
      thumbnails: Mixed,
      thumbnailUrl: String,
      tags: [String],
      categoryId: String,
      categoryName: String,
      defaultLanguage: String,
      defaultAudioLanguage: String,
      liveBroadcastContent: String,
      duration: String,
      durationSeconds: Number,
      durationDisplay: String,
      definition: String,
      captionAvailable: Boolean,
      licensedContent: Boolean,
      projection: String,
      privacyStatus: String,
      uploadStatus: String,
      embeddable: Boolean,
      publicStatsViewable: Boolean,
      madeForKids: Boolean,
      containsSyntheticMedia: Boolean,
      hasPaidProductPlacement: Boolean,
      viewCount: Number,
      likeCount: Number,
      commentCount: Number,
      favoriteCount: Number,
      engagementRate: Number,
      likeRate: Number,
      commentRate: Number,
      player: Mixed,
      topicDetails: Mixed,
      recordingDetails: Mixed,
      liveStreamingDetails: Mixed
    },

    channelMetrics: {
      channelId: { type: String, index: true },
      title: String,
      description: String,
      customUrl: String,
      channelUrl: String,
      publishedAt: Date,
      channelAge: String,
      country: String,
      thumbnails: Mixed,
      thumbnailUrl: String,
      subscriberCount: Number,
      subscriberCountDisplay: String,
      hiddenSubscriberCount: Boolean,
      totalViewCount: Number,
      totalViewCountDisplay: String,
      videoCount: Number,
      videoCountDisplay: String,
      uploadsPlaylistId: String,
      likesPlaylistId: String,
      privacyStatus: String,
      isLinked: Boolean,
      longUploadsStatus: String,
      madeForKids: Boolean,
      branding: Mixed,
      topicDetails: Mixed,
      localized: Mixed
    },

    // Keep both names. Old code reads influencerInsights; newer YouTube-only code can read creatorInsights.
    influencerInsights: CreatorInsightSchema,
    creatorInsights: CreatorInsightSchema,

    channelInsights: {
      channelSizeTier: String,
      creatorAverageViews: Number,
      creatorAverageLikes: Number,
      creatorAverageComments: Number,
      creatorAverageEngagementRate: Number,
      creatorAverageDurationSeconds: Number,
      recentVideosAnalyzed: Number,
      postingConsistency: String,
      categoryFit: String,
      insight: String
    },

    channelBaseline: {
      creatorAverageViews: Number,
      creatorAverageLikes: Number,
      creatorAverageComments: Number,
      creatorAverageEngagementRate: Number,
      creatorAverageDurationSeconds: Number,
      recentVideosAnalyzed: Number,
      comparisonResult: String,
      rows: [Mixed]
    },

    contentQuality: {
      contentFormat: String,
      titleQualityScore: Number,
      descriptionCompletenessScore: Number,
      thumbnailAvailable: Boolean,
      durationCategory: String,
      hasDescriptionLink: Boolean,
      hasHashtags: Boolean,
      hasPinnedCtaPotential: Boolean,
      insight: String,
      improvementSuggestions: [String]
    },

    performanceEstimates: {
      estimatedCtr: MetricValueSchema,
      estimatedClicks: MetricValueSchema,
      estimatedShareRate: MetricValueSchema,
      estimatedShares: MetricValueSchema,
      estimatedSaveRate: MetricValueSchema,
      estimatedSaves: MetricValueSchema,
      estimatedConversionRate: MetricValueSchema,
      estimatedConversions: MetricValueSchema,
      estimatedRetentionRate: MetricValueSchema,
      estimatedAverageViewDurationSeconds: MetricValueSchema,
      estimatedWatchTimeMinutes: MetricValueSchema,
      estimatedWatchTimeHours: MetricValueSchema,
      estimatedRevenueLow: MetricValueSchema,
      estimatedRevenueHigh: MetricValueSchema,
      rpmLow: Number,
      rpmHigh: Number,
      note: String
    },

    estimatedWatchTime: {
      retentionRate: MetricValueSchema,
      averageViewDurationSeconds: MetricValueSchema,
      totalWatchTimeMinutes: MetricValueSchema,
      totalWatchTimeHours: MetricValueSchema,
      formula: { type: String, default: 'views * averageViewDurationSeconds / 60' },
      note: { type: String, default: 'Estimated from public views, duration, engagement, sentiment, and creator baseline. Actual watch time requires YouTube Analytics OAuth.' }
    },

    estimatedRevenue: {
      rpmLow: Number,
      rpmHigh: Number,
      totalVideoViews: Number,
      totalVideoViewsDisplay: String,
      estimatedRevenueLow: Number,
      estimatedRevenueHigh: Number,
      estimatedRevenueRangeDisplay: String,
      source: String,
      available: Boolean,
      isEstimate: Boolean
    },

    publicStats: {
      videoViews: Number,
      videoLikes: Number,
      videoComments: Number,
      videoFavorites: Number,
      channelSubscribers: Number,
      channelTotalViews: Number,
      channelTotalVideos: Number,
      channelTotalLikesAvailable: { type: Boolean, default: false },
      channelTotalLikesNote: { type: String, default: 'YouTube Data API does not expose total channel likes publicly.' }
    },

    commentIntelligence: {
      totalCommentsAnalyzed: Number,
      totalRepliesAnalyzed: { type: Number, default: 0 },
      sentiment: {
        positive: Number,
        neutral: Number,
        negative: Number,
        label: String
      },
      categories: Mixed,
      commonThemes: [Mixed],
      topComments: [Mixed],
      commentTabs: Mixed,
      topQuestions: [String],
      topPurchaseIntentExamples: [String],
      topTrustExamples: [String],
      topObjections: [String],
      rawCounts: Mixed
    },

    advancedCommentInsights: {
      repeatedThemes: [Mixed],
      buyingSignals: [String],
      pricingQuestions: [String],
      availabilityQuestions: [String],
      sponsorshipConcerns: [String],
      productProofQuestions: [String],
      aiInterpretation: String
    },

    performanceComparison: {
      currentVideo: Mixed,
      creatorAverage: Mixed,
      rows: [Mixed],
      comparisonResult: String
    },

    aiScores: {
      videoPerformanceScore: Number,
      engagementQuality: Number,
      sentimentScore: Number,
      commentQualityScore: Number,
      audienceCuriosityScore: Number,
      creatorAuthorityScore: Number,
      contentEffectivenessScore: Number,
      channelFitScore: Number,
      conversionPotentialScore: Number,
      finalAiScore: Number
    },

    aiInsights: {
      source: { type: String, default: 'fallback' },
      heroSummary: String,
      influencerSummary: String,
      performanceSummary: String,
      audienceBehaviorInsight: String,
      commentQualityInsight: String,
      contentEffectivenessInsight: String,
      categoryInsight: String,
      bestUseCaseInsight: String,
      watchTimeInsight: String,
      riskInsight: String,
      recommendation: String,
      brandDecision: String,
      strengths: [String],
      risks: [String],
      bestUseCases: [String],
      nextActions: [String],
      improvementSuggestions: [String]
    },

    // Duplicate alias intentionally kept so frontend can read either aiSummary or aiInsights.
    aiSummary: {
      source: { type: String, default: 'fallback' },
      heroSummary: String,
      influencerSummary: String,
      performanceSummary: String,
      audienceBehaviorInsight: String,
      commentQualityInsight: String,
      contentEffectivenessInsight: String,
      categoryInsight: String,
      bestUseCaseInsight: String,
      watchTimeInsight: String,
      riskInsight: String,
      recommendation: String,
      brandDecision: String,
      strengths: [String],
      risks: [String],
      bestUseCases: [String],
      nextActions: [String],
      improvementSuggestions: [String]
    },

    finalVerdict: {
      verdict: String,
      finalScore: Number,
      reason: String,
      bestFor: [String],
      bestUseCases: [String],
      notBestFor: [String],
      futureCollaborationRecommendation: String,
      nextSteps: [String]
    },

    dashboard: { type: Mixed, default: null },
    chartData: { type: Mixed, default: null },

    dataAvailability: {
      publicYoutubeDataAvailable: { type: Boolean, default: true },
      youtubeAnalyticsConnected: { type: Boolean, default: false },
      commentsDisabled: { type: Boolean, default: false },
      commentsFetchError: { type: String, default: '' },
      repliesFullyFetched: { type: Boolean, default: false },
      estimatedWatchTimeUsed: { type: Boolean, default: true },
      estimatedMetricsUsed: { type: Boolean, default: true },
      missingMetrics: [String],
      notes: [String]
    },

    rawData: {
      video: Mixed,
      channel: Mixed,
      recentVideoIds: [String],
      recentVideosSample: [Mixed],
      commentsSample: [Mixed],
      topComments: [Mixed],
      commentTabs: Mixed,
      openAiRaw: Mixed
    }
  },
  { timestamps: true }
);

YoutubeInsightReportSchema.index({ createdByAdminId: 1, createdAt: -1 });
YoutubeInsightReportSchema.index({ userId: 1, createdAt: -1 });
YoutubeInsightReportSchema.index({ brandId: 1, createdAt: -1 });
YoutubeInsightReportSchema.index({ videoId: 1, createdAt: -1 });
YoutubeInsightReportSchema.index({ 'channelMetrics.channelId': 1, createdAt: -1 });
YoutubeInsightReportSchema.index({ 'aiScores.finalAiScore': -1 });
YoutubeInsightReportSchema.index({ 'influencerInsights.primaryCategory': 1, createdAt: -1 });
YoutubeInsightReportSchema.index({ 'creatorInsights.primaryCategory': 1, createdAt: -1 });

module.exports =
  mongoose.models.YoutubeInsightReport ||
  mongoose.model('YoutubeInsightReport', YoutubeInsightReportSchema);