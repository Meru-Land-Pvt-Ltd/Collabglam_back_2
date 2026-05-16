'use strict';

function clean(value) {
  return String(value || '').trim();
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toArray(value, fallback = []) {
  if (Array.isArray(value)) return value.map((item) => clean(item)).filter(Boolean).slice(0, 8);
  if (typeof value === 'string' && clean(value)) return [clean(value)];
  return fallback;
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch (error) {
    const match = String(value || '').match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (_error) {
      return null;
    }
  }
}

function shorten(value, max = 900) {
  const text = clean(value).replace(/\s+/g, ' ');
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function compactForOpenAi(value, depth = 0) {
  if (depth > 4) return undefined;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return shorten(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => compactForOpenAi(item, depth + 1));
  if (typeof value === 'object') {
    return Object.entries(value).reduce((acc, [key, item]) => {
      if (key.startsWith('_')) return acc;
      const compact = compactForOpenAi(item, depth + 1);
      if (typeof compact !== 'undefined') acc[key] = compact;
      return acc;
    }, {});
  }
  return undefined;
}

function fallbackAiSummary(context = {}) {
  const channel = context.channelMetrics || {};
  const video = context.videoMetrics || {};
  const creator = context.creatorInsights || {};
  const scores = context.scores || {};
  const comments = context.commentIntelligence || {};
  const estimates = context.performanceEstimates || {};

  const score = Math.round(toNumber(scores.finalAiScore, 0));
  const creatorName = channel.title || video.channelTitle || 'this creator';
  const category = creator.primaryCategory || video.categoryName || 'general content';
  const views = toNumber(video.viewCount, 0);
  const engagement = toNumber(video.engagementRate, 0);
  const positive = toNumber(comments.sentiment?.positive, 0);
  const negative = toNumber(comments.sentiment?.negative, 0);
  const ctr = estimates.estimatedCtr?.displayValue || 'not estimated';
  const conversions = estimates.estimatedConversions?.displayValue || 'not estimated';

  return {
    source: 'fallback',
    heroSummary: `${creatorName} is a ${category} YouTube creator evaluated using public channel, video, comment, and recent-upload signals.`,
    influencerSummary: `${creatorName} should be judged by channel authority, recent public upload baseline, comment quality, audience intent, and brand-category fit.`,
    performanceSummary: `This video has ${views.toLocaleString('en-US')} public views and ${engagement}% engagement. Estimated CTR is ${ctr}, and estimated conversions are ${conversions}; these are public-formula estimates, not private analytics.`,
    audienceBehaviorInsight: `Comment sentiment is ${positive}% positive and ${negative}% negative. Buying, question, trust, objection, and sponsorship signals should be reviewed before approval.`,
    commentQualityInsight: 'Comments are grouped into latest, positive, neutral, negative, purchase intent, questions, trust signals, proof requests, sponsorship concerns, and spam/low-value buckets.',
    contentEffectivenessInsight: `The format looks like ${creator.contentFormat || 'creator-led YouTube content'}. Stronger pinned CTA, product proof, and description links can improve measurable action.`,
    categoryInsight: `Creator category is ${category}. Use this creator when the brand objective fits the content topic and audience tone.`,
    bestUseCaseInsight: `Best for ${(creator.bestUseCases || []).slice(0, 3).join(', ') || 'awareness, consideration, product education, and creator-fit testing'}.`,
    watchTimeInsight: 'Watch time is estimated from public views, duration, and retention assumptions. Actual watch time requires YouTube Analytics OAuth.',
    riskInsight: 'Public data cannot confirm true CTR, shares, saves, conversions, audience demographics, traffic source, retention, or actual revenue. Use UTM links, affiliate links, and coupon codes for proof.',
    recommendation: score >= 80 ? 'Strong candidate for brand shortlist.' : score >= 65 ? 'Good creator to test with clear tracking.' : score >= 45 ? 'Use for controlled awareness tests only.' : 'Review carefully before shortlisting.',
    brandDecision: score >= 80 ? 'Shortlist for brand collaboration.' : score >= 65 ? 'Test with a focused brief and tracking.' : 'Use only after reviewing fit, comments, and category relevance.',
    strengths: [
      'Public video and channel metrics are available.',
      'Comment intelligence provides audience intent and risk signals.',
      'Recent uploads provide a creator baseline.'
    ],
    risks: [
      'CTR, shares, saves, conversions, demographics, and watch time are estimated.',
      'Actual sales impact requires UTM, affiliate, coupon, or checkout tracking.'
    ],
    bestUseCases: creator.bestUseCases || ['Awareness', 'Consideration', 'Creator-fit testing'],
    nextActions: [
      'Use a pinned CTA with link, price, availability, and FAQ.',
      'Use UTM, affiliate link, or coupon code for real conversion tracking.',
      'Review negative and question comments before approval.'
    ],
    improvementSuggestions: [
      'Add clear tracking link in the description and pinned comment.',
      'Ask creator to reply to top price, availability, and proof questions.',
      'Compare against future public uploads after the campaign.'
    ]
  };
}

async function buildOpenAiClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  try {
    const OpenAI = require('openai');
    return new OpenAI({ apiKey });
  } catch (error) {
    console.error('[YouTube Insight OpenAI] openai package missing or failed to load:', error.message);
    return null;
  }
}

function normalizeAiSummary(parsed = {}, fallback = {}, model = '') {
  const source = parsed.source || 'openai';
  const summary = parsed.aiSummary && typeof parsed.aiSummary === 'object' ? parsed.aiSummary : parsed;

  return {
    source,
    heroSummary: clean(summary.heroSummary) || fallback.heroSummary,
    influencerSummary: clean(summary.influencerSummary) || fallback.influencerSummary,
    performanceSummary: clean(summary.performanceSummary) || fallback.performanceSummary,
    audienceBehaviorInsight: clean(summary.audienceBehaviorInsight) || fallback.audienceBehaviorInsight,
    commentQualityInsight: clean(summary.commentQualityInsight) || fallback.commentQualityInsight,
    contentEffectivenessInsight: clean(summary.contentEffectivenessInsight) || fallback.contentEffectivenessInsight,
    categoryInsight: clean(summary.categoryInsight) || fallback.categoryInsight,
    bestUseCaseInsight: clean(summary.bestUseCaseInsight) || fallback.bestUseCaseInsight,
    watchTimeInsight: clean(summary.watchTimeInsight) || fallback.watchTimeInsight,
    riskInsight: clean(summary.riskInsight) || fallback.riskInsight,
    recommendation: clean(summary.recommendation) || fallback.recommendation,
    brandDecision: clean(summary.brandDecision) || fallback.brandDecision,
    strengths: toArray(summary.strengths, fallback.strengths),
    risks: toArray(summary.risks, fallback.risks),
    bestUseCases: toArray(summary.bestUseCases, fallback.bestUseCases),
    nextActions: toArray(summary.nextActions, fallback.nextActions),
    improvementSuggestions: toArray(summary.improvementSuggestions, fallback.improvementSuggestions),
    _rawModel: clean(model)
  };
}

function buildPromptPayload(context = {}) {
  const channel = context.channelMetrics || {};
  const video = context.videoMetrics || {};
  const creator = context.creatorInsights || {};
  const comments = context.commentIntelligence || {};
  const estimates = context.performanceEstimates || {};
  const baseline = context.channelBaseline || {};
  const scores = context.scores || {};

  return compactForOpenAi({
    channel: {
      title: channel.title,
      country: channel.country,
      subscribers: channel.subscriberCount,
      totalViews: channel.totalViewCount,
      totalVideos: channel.videoCount,
      sizeTier: creator.sizeTier,
      authorityLevel: creator.authorityLevel
    },
    video: {
      title: video.title,
      category: video.categoryName,
      duration: video.durationDisplay,
      views: video.viewCount,
      likes: video.likeCount,
      comments: video.commentCount,
      engagementRate: video.engagementRate,
      description: video.description,
      tags: video.tags
    },
    creatorFit: creator,
    commentSignals: {
      total: comments.totalCommentsAnalyzed,
      sentiment: comments.sentiment,
      themes: comments.commonThemes,
      categories: comments.categories,
      topQuestions: comments.topQuestions,
      topPurchaseIntentExamples: comments.topPurchaseIntentExamples,
      topTrustExamples: comments.topTrustExamples,
      topObjections: comments.topObjections
    },
    publicFormulaEstimates: {
      ctr: estimates.estimatedCtr,
      clicks: estimates.estimatedClicks,
      shareRate: estimates.estimatedShareRate,
      shares: estimates.estimatedShares,
      saveRate: estimates.estimatedSaveRate,
      saves: estimates.estimatedSaves,
      conversionRate: estimates.estimatedConversionRate,
      conversions: estimates.estimatedConversions,
      watchTimeHours: estimates.estimatedWatchTimeHours,
      revenueLow: estimates.estimatedRevenueLow,
      revenueHigh: estimates.estimatedRevenueHigh
    },
    creatorBaseline: baseline,
    scores,
    existingVerdict: context.finalVerdict || {},
    contentQuality: context.contentQuality || {}
  });
}

async function generateYoutubeAiSummary(context = {}) {
  const fallback = fallbackAiSummary(context);
  const client = await buildOpenAiClient();
  if (!client) return fallback;

  const model = process.env.OPENAI_YOUTUBE_INSIGHT_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const temperature = Number.isFinite(Number(process.env.OPENAI_YOUTUBE_INSIGHT_TEMPERATURE))
    ? Number(process.env.OPENAI_YOUTUBE_INSIGHT_TEMPERATURE)
    : 0.2;
  const payload = buildPromptPayload(context);

  const system = [
    'You are a senior influencer marketing analyst for a brand team.',
    'Use only the public YouTube data and formula estimates provided.',
    'Do not invent private YouTube Analytics, demographics, traffic sources, true CTR, true shares, true saves, true revenue, or real conversions.',
    'Write concise, professional, brand-facing insights that explain whether to use the creator, what campaign types fit, what risks exist, and what actions the brand should take.',
    'Return JSON only. No markdown.'
  ].join(' ');

  const user = [
    'Create a YouTube creator AI Summary for a brand dashboard.',
    'Return exactly this JSON shape:',
    '{"heroSummary":"","influencerSummary":"","performanceSummary":"","audienceBehaviorInsight":"","commentQualityInsight":"","contentEffectivenessInsight":"","categoryInsight":"","bestUseCaseInsight":"","watchTimeInsight":"","riskInsight":"","recommendation":"","brandDecision":"","strengths":[],"risks":[],"bestUseCases":[],"nextActions":[],"improvementSuggestions":[]}',
    'Data:',
    JSON.stringify(payload)
  ].join('\n');

  try {
    const response = await client.chat.completions.create({
      model,
      temperature,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    });

    const content = response.choices?.[0]?.message?.content || '';
    const parsed = safeJsonParse(content);
    if (!parsed) return fallback;

    return normalizeAiSummary(parsed, fallback, model);
  } catch (error) {
    console.error('[YouTube Insight OpenAI] summary generation failed:', error.message);
    return fallback;
  }
}

module.exports = {
  generateYoutubeAiSummary,
  fallbackAiSummary
};
