'use strict';

const axios = require('axios');
const { toNumber, round } = require('../utils/number');

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const PROMPT_VERSION = 'collabglam-youtube-report-v1';

function clean(value) {
  return String(value || '').trim();
}

function safeJsonParse(value, fallback = null) {
  try {
    if (typeof value === 'object' && value !== null) return value;
    return JSON.parse(String(value || ''));
  } catch (error) {
    return fallback;
  }
}

function compactForPrompt(input = {}) {
  return JSON.stringify(input, null, 2).slice(0, Number(process.env.AI_PROMPT_MAX_CHARS || 18000));
}

function hasOpenAiConfig() {
  return Boolean(process.env.OPENAI_API_KEY);
}

async function callOpenAiJson({ system, user, model, temperature = 0.25 }) {
  if (!hasOpenAiConfig()) return null;

  const response = await axios.post(
    OPENAI_API_URL,
    {
      model: model || process.env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: Number(process.env.OPENAI_TIMEOUT_MS || 25000)
    }
  );

  const content = response.data?.choices?.[0]?.message?.content || '{}';
  return safeJsonParse(content, {});
}

const BASE_SYSTEM_PROMPT = [
  'You are an AI campaign analyst for Collabglam, an influencer marketing platform.',
  'Write professional, concise, brand-facing analysis.',
  'Do not repeat every raw metric. Explain what the metrics mean.',
  'Only use the data provided. If a metric is missing, say it is unavailable or needs tracking.',
  'Return strict JSON only. No markdown.'
].join(' ');

function buildOverallCampaignPrompt(context) {
  return {
    key: 'campaignExecutiveSummary',
    system: BASE_SYSTEM_PROMPT,
    user: `Analyze the overall influencer campaign performance using the provided campaign metrics.

Your task:
- Explain how the campaign performed overall
- Identify strengths and weaknesses
- Mention which influencer/content patterns performed best
- Mention audience response quality
- Mention conversion or purchase intent signals if visible
- Keep tone executive, concise, and insight-focused

Return JSON with keys:
{
  "overallCampaignSummary": "string",
  "keyPerformanceDrivers": ["string"],
  "weaknessesOrRisks": ["string"],
  "finalCampaignVerdict": "string"
}

Campaign Data:
${compactForPrompt(context)}`
  };
}

function buildInfluencerPerformancePrompt(context) {
  return {
    key: 'influencerPerformance',
    system: BASE_SYSTEM_PROMPT,
    user: `Analyze this influencer's campaign performance.

Focus on:
- engagement quality
- audience interaction
- audience trust
- content effectiveness
- purchase intent indicators
- conversion potential

Avoid simply repeating metrics.

Return JSON with keys:
{
  "influencerPerformanceSummary": "string",
  "audienceBehaviorInsight": "string",
  "contentEffectivenessInsight": "string",
  "finalInfluencerVerdict": "string",
  "futureCollaborationRecommendation": "string"
}

Influencer Report Data:
${compactForPrompt(context)}`
  };
}

function buildCommentInsightPrompt(context) {
  return {
    key: 'commentIntelligence',
    system: BASE_SYSTEM_PROMPT,
    user: `Analyze the public YouTube comment intelligence for this campaign post.

Focus on:
- sentiment
- purchase intent
- pricing or availability questions
- audience curiosity
- trust signals
- objections or skepticism
- spam/noise level

Return JSON with keys:
{
  "commentQualitySummary": "string",
  "commonThemes": ["string"],
  "buyingIntentInterpretation": "string",
  "brandTrustInterpretation": "string",
  "risksOrObjections": ["string"],
  "recommendedRepliesOrActions": ["string"]
}

Comment Data:
${compactForPrompt(context)}`
  };
}

function buildContentQualityPrompt(context) {
  return {
    key: 'contentQuality',
    system: BASE_SYSTEM_PROMPT,
    user: `Analyze the content quality for this influencer campaign post using title, description, tags, thumbnail, duration, CTA, and audience response.

Return JSON with keys:
{
  "contentQualitySummary": "string",
  "bestPerformingContentSignals": ["string"],
  "contentWeaknesses": ["string"],
  "ctaImprovementSuggestions": ["string"]
}

Content Data:
${compactForPrompt(context)}`
  };
}

function fallbackYoutubeAiSections({ videoMetrics = {}, channelMetrics = {}, commentIntelligence = {}, contentQuality = {}, performanceComparison = {}, roiMetrics = {}, scores = {}, finalVerdict = {} }) {
  const comments = commentIntelligence.categories || {};
  const purchaseIntent = toNumber(comments.purchaseIntent?.count);
  const positiveSentiment = toNumber(commentIntelligence.sentiment?.positive);
  const negativeSentiment = toNumber(commentIntelligence.sentiment?.negative);
  const finalScore = toNumber(scores.finalAiScore || finalVerdict.finalScore);
  const views = toNumber(videoMetrics.viewCount);
  const engagementRate = toNumber(videoMetrics.engagementRate);
  const roas = roiMetrics.roas;

  const summaryTone = finalScore >= 80 ? 'strong' : finalScore >= 65 ? 'good' : finalScore >= 50 ? 'moderate' : 'weak';
  const conversionTone = purchaseIntent > 0 ? 'visible purchase intent' : 'limited purchase intent signals';

  return {
    source: 'rule_based_fallback',
    model: null,
    generatedAt: new Date(),
    promptVersion: PROMPT_VERSION,
    fallbackUsed: true,
    sections: {
      campaignExecutiveSummary: {
        overallCampaignSummary: `${channelMetrics.title || 'The influencer'} generated ${views} views with ${engagementRate}% engagement. Overall performance is ${summaryTone}, with ${conversionTone} in public comments.`,
        keyPerformanceDrivers: [
          `${round(engagementRate)}% engagement rate`,
          `${positiveSentiment}% positive comment sentiment`,
          performanceComparison.comparisonResult || 'Creator baseline comparison available in report',
          roas ? `${roas}x ROAS from provided tracking data` : 'ROI requires brand-side tracking data'
        ].filter(Boolean),
        weaknessesOrRisks: [
          negativeSentiment > 20 ? 'Negative or skeptical comments need review.' : null,
          purchaseIntent <= 0 ? 'Visible purchase intent is limited in public comments.' : null,
          !roiMetrics.estimatedClicks ? 'Clicks are unavailable without UTM, affiliate, or short-link tracking.' : null,
          !roiMetrics.conversions ? 'Conversions are unavailable without brand-side tracking.' : null
        ].filter(Boolean),
        finalCampaignVerdict: finalVerdict.verdict || 'Recommended with improvements'
      },
      influencerPerformance: {
        influencerPerformanceSummary: `${channelMetrics.title || 'This creator'} is ${finalVerdict.verdict || 'rated'} with a ${finalScore}/100 AI score.`,
        audienceBehaviorInsight: positiveSentiment >= 50
          ? 'Audience response is positive enough to support brand consideration.'
          : 'Audience response is mixed, so the campaign should be optimized before scaling.',
        contentEffectivenessInsight: contentQuality.insight || 'Content quality was reviewed using title, description, duration, thumbnail, and CTA signals.',
        finalInfluencerVerdict: finalVerdict.reason || '',
        futureCollaborationRecommendation: finalVerdict.futureCollaborationRecommendation || ''
      },
      commentIntelligence: {
        commentQualitySummary: `Comments show ${purchaseIntent} purchase-intent signals, ${commentIntelligence.rawCounts?.questions || 0} questions, and ${comments.negativeSkeptical?.count || 0} negative/skeptical comments.`,
        commonThemes: (commentIntelligence.commonThemes || []).map((row) => row.theme).filter(Boolean),
        buyingIntentInterpretation: purchaseIntent > 0
          ? 'Commercial interest is visible through buying, pricing, availability, link, or coupon language.'
          : 'Commercial interest is not strongly visible from public comments.',
        brandTrustInterpretation: comments.trustSignals?.count > 0
          ? 'Some trust language is visible, which improves creator value for consideration campaigns.'
          : 'Trust language is limited, so brand trust should be strengthened with proof, demo, replies, and pinned FAQs.',
        risksOrObjections: commentIntelligence.topObjections || [],
        recommendedRepliesOrActions: [
          'Pin a comment with product link, price, availability, coupon, and FAQ.',
          'Reply to top purchase, pricing, availability, and product-proof questions.',
          'Use unique UTM or affiliate links to validate conversion impact.'
        ]
      },
      contentQuality: {
        contentQualitySummary: contentQuality.insight || '',
        bestPerformingContentSignals: [
          contentQuality.contentFormat ? `Content format: ${contentQuality.contentFormat}` : null,
          contentQuality.thumbnailAvailable ? 'Thumbnail is available.' : null,
          contentQuality.hasDescriptionLink ? 'Description includes a link.' : null,
          contentQuality.hasCouponOrDiscountLanguage ? 'Discount/coupon language is present.' : null
        ].filter(Boolean),
        contentWeaknesses: (contentQuality.improvementSuggestions || []).filter(Boolean),
        ctaImprovementSuggestions: [
          'Make the description CTA clear.',
          'Add trackable link and coupon code.',
          'Add pricing and availability clarity.'
        ]
      }
    }
  };
}

async function generateModularYoutubeAiInsights(context = {}) {
  const fallback = fallbackYoutubeAiSections(context);

  if (!hasOpenAiConfig() || process.env.ENABLE_AI_INSIGHTS === 'false') {
    return fallback;
  }

  const prompts = [
    buildOverallCampaignPrompt(context),
    buildInfluencerPerformancePrompt(context),
    buildCommentInsightPrompt(context),
    buildContentQualityPrompt(context)
  ];

  const sections = {};
  const errors = [];
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  for (const prompt of prompts) {
    try {
      sections[prompt.key] = await callOpenAiJson({
        system: prompt.system,
        user: prompt.user,
        model
      });
    } catch (error) {
      sections[prompt.key] = fallback.sections[prompt.key];
      errors.push({ key: prompt.key, message: error.message });
    }
  }

  return {
    source: errors.length === prompts.length ? 'rule_based_fallback' : 'openai',
    model: errors.length === prompts.length ? null : model,
    generatedAt: new Date(),
    promptVersion: PROMPT_VERSION,
    fallbackUsed: errors.length > 0,
    errors,
    sections: {
      ...fallback.sections,
      ...sections
    }
  };
}

function mapModularAiToLegacyAiInsights(modularAi = {}, existingAiInsights = {}) {
  const sections = modularAi.sections || {};
  const executive = sections.campaignExecutiveSummary || {};
  const influencer = sections.influencerPerformance || {};
  const comments = sections.commentIntelligence || {};
  const content = sections.contentQuality || {};

  return {
    ...existingAiInsights,
    campaignPerformanceSummary: executive.overallCampaignSummary || existingAiInsights.campaignPerformanceSummary,
    audienceBehaviorInsight: influencer.audienceBehaviorInsight || existingAiInsights.audienceBehaviorInsight,
    commentQualityInsight: comments.commentQualitySummary || existingAiInsights.commentQualityInsight,
    contentEffectivenessInsight: influencer.contentEffectivenessInsight || content.contentQualitySummary || existingAiInsights.contentEffectivenessInsight,
    purchaseIntentInsight: comments.buyingIntentInterpretation || existingAiInsights.purchaseIntentInsight,
    improvementSuggestions: [
      ...(existingAiInsights.improvementSuggestions || []),
      ...(comments.recommendedRepliesOrActions || []),
      ...(content.ctaImprovementSuggestions || [])
    ].filter(Boolean).slice(0, 12)
  };
}

module.exports = {
  PROMPT_VERSION,
  generateModularYoutubeAiInsights,
  mapModularAiToLegacyAiInsights,
  fallbackYoutubeAiSections
};
