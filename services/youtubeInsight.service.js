'use strict';

const mongoose = require('mongoose');
const YoutubeInsightReport = require('../models/youtubeInsightReport');
const { extractYouTubeVideoId, buildYouTubeWatchUrl } = require('../utils/youtubeUrl');
const {
  clamp,
  percent,
  toNumber,
  round,
  compactNumber,
  money,
  formatDurationFromSeconds
} = require('../utils/number');
const {
  getVideoDetails,
  getChannelDetails,
  getPublicCommentThreads,
  getRecentChannelVideoIds,
  getVideosStats,
  normalizeVideo,
  normalizeChannel,
  calculateCreatorAverage
} = require('./youtubeApi.service');
const { buildYoutubeInsightDashboard, buildChartData } = require('./youtubeReportDashboard.service');
const { generateYoutubeAiSummary } = require('./youtubeOpenAi.service');

const POSITIVE_WORDS = ['good', 'great', 'amazing', 'awesome', 'excellent', 'best', 'nice', 'love', 'perfect', 'helpful', 'useful', 'wow', 'super', 'impressive', 'beautiful', 'cool', 'valuable', 'thanks', 'trusted', 'genuine', 'honest', 'quality', 'recommend', 'badhiya', 'acha', 'accha', 'informative'];
const NEGATIVE_WORDS = ['bad', 'worst', 'fake', 'scam', 'useless', 'poor', 'hate', 'issue', 'problem', 'misleading', 'expensive', 'overpriced', 'not worth', 'waste', 'broken', 'fraud', 'lie', 'lying', 'bakwas', 'boring', 'confusing', 'clickbait'];
const PURCHASE_WORDS = ['buy', 'bought', 'purchase', 'order', 'ordered', 'need this', 'want this', 'send link', 'link please', 'where can i buy', 'where to buy', 'shop', 'cart', 'checkout', 'available', 'discount', 'coupon', 'code', 'price', 'take my money', 'buying', 'book now', 'purchase link', 'order link', 'kaha milega', 'kidhar milega', 'kaise kharide', 'mujhe chahiye', 'need one', 'how much'];
const PRICE_WORDS = ['price', 'cost', 'kitna', 'how much', 'mrp', 'rate', 'expensive', 'cheap', 'discount', 'coupon', 'offer', 'sale', 'budget', 'emi'];
const AVAILABILITY_WORDS = ['available', 'availability', 'where', 'link', 'india', 'shipping', 'delivery', 'cod', 'amazon', 'flipkart', 'website', 'store', 'stock', 'out of stock', 'kaha', 'kidhar'];
const TRUST_WORDS = ['honest', 'genuine', 'real review', 'trusted', 'trust', 'unbiased', 'detailed review', 'thanks for testing', 'tested', 'proof', 'credible', 'authentic', 'real testing', 'i trust you', 'true review'];
const SPONSORSHIP_WORDS = ['sponsored', 'paid promotion', 'paid review', 'collab', 'promotion', 'ad?', 'advertisement'];
const PRODUCT_PROOF_WORDS = ['does it work', 'proof', 'result', 'before after', 'battery', 'durability', 'warranty', 'guarantee', 'real result', 'long term', 'after use', 'review after', 'performance'];
const SPAM_WORDS = ['sub4sub', 'subscribe to my channel', 'check my channel', 'free subscribers', 'telegram me', 'whatsapp me', 'earn money fast', 'crypto giveaway', 'forex', 'dm me', 'loan available'];
const CTA_WORDS = ['buy', 'shop', 'order', 'link', 'coupon', 'discount', 'visit', 'website', 'check out', 'use code', 'available', 'learn more', 'download', 'sign up', 'subscribe', 'follow'];

const CATEGORY_KEYWORDS = [
  { category: 'Technology', words: ['tech', 'technology', 'gadget', 'smartphone', 'laptop', 'ai', 'software', 'app', 'camera', 'earbuds', 'headphones', 'pc', 'computer', 'review', 'unboxing'] },
  { category: 'Gaming', words: ['gaming', 'gameplay', 'game', 'esports', 'minecraft', 'pubg', 'valorant', 'fortnite', 'ps5', 'xbox'] },
  { category: 'Beauty & Fashion', words: ['beauty', 'makeup', 'skincare', 'fashion', 'outfit', 'style', 'haul', 'cosmetic', 'hair'] },
  { category: 'Lifestyle & Vlogging', words: ['vlog', 'daily life', 'routine', 'lifestyle', 'family', 'home', 'day in my life'] },
  { category: 'Travel', words: ['travel', 'trip', 'tour', 'hotel', 'flight', 'japan', 'dubai', 'beach', 'destination'] },
  { category: 'Food', words: ['food', 'recipe', 'cooking', 'restaurant', 'street food', 'taste', 'kitchen', 'meal'] },
  { category: 'Fitness & Health', words: ['fitness', 'gym', 'workout', 'health', 'diet', 'weight loss', 'yoga', 'exercise'] },
  { category: 'Education', words: ['education', 'tutorial', 'course', 'learn', 'study', 'exam', 'guide', 'explained'] },
  { category: 'Finance & Business', words: ['finance', 'business', 'money', 'stock', 'crypto', 'investment', 'startup', 'marketing', 'sales'] },
  { category: 'Automotive', words: ['car', 'bike', 'auto', 'automotive', 'ev', 'scooter', 'motorcycle', 'vehicle'] },
  { category: 'Entertainment', words: ['entertainment', 'reaction', 'funny', 'comedy', 'movie', 'music', 'dance', 'celebrity'] },
  { category: 'Sports', words: ['sports', 'football', 'cricket', 'basketball', 'match', 'training'] },
  { category: 'Pets & Animals', words: ['pet', 'dog', 'cat', 'animal', 'monkey', 'zoo', 'wildlife'] }
];

function clean(value) {
  return String(value || '').trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function includesAny(text, words) {
  return words.some((word) => text.includes(word));
}

function tokenize(text) {
  return lower(text).replace(/https?:\/\/\S+/g, '').replace(/[^a-z0-9?\s]/g, ' ').split(/\s+/).filter(Boolean);
}

function uniqueTop(items, limit = 8) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const value = clean(item);
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

function getVideoUrlFromPayload(payload = {}, videoId = '') {
  const direct = clean(payload.videoUrl || payload.youtubeVideoUrl || payload.youtubeUrl || payload.videoLink || payload.link || payload.url || payload.videoId);
  return direct || buildYouTubeWatchUrl(videoId);
}

function buildYoutubeOnlyInput(payload = {}) {
  return {
    videoUrl: getVideoUrlFromPayload(payload),
    maxComments: Math.min(Math.max(toNumber(payload.maxComments, 300), 0), 500),
    creatorAverageLimit: Math.min(Math.max(toNumber(payload.creatorAverageLimit, 12), 1), 50),
    includeReplies: Boolean(payload.includeReplies),
    includeRepliesInAnalysis: Boolean(payload.includeRepliesInAnalysis),
    maxRepliesPerThread: Math.min(Math.max(toNumber(payload.maxRepliesPerThread, 25), 0), 100),
    commentOrder: payload.commentOrder === 'time' ? 'time' : 'relevance',
    rpmLow: Math.max(0, toNumber(payload.rpmLow, 1.36)),
    rpmHigh: Math.max(0, toNumber(payload.rpmHigh, 3.4))
  };
}

function classifyComment(comment) {
  const rawText = comment.text || '';
  const text = lower(rawText);
  const words = tokenize(rawText);
  const isQuestion = rawText.includes('?') || /\b(what|where|when|how|why|does|is|can|will|price|kitna|kaha|kidhar|kaise)\b/i.test(rawText);
  const hasLink = /https?:\/\//i.test(rawText);
  const lowValueEmojiOnly = words.length === 0 && rawText.trim().length > 0;
  const tooShort = words.length <= 2 && !isQuestion && !includesAny(text, PURCHASE_WORDS);
  const spam = includesAny(text, SPAM_WORDS) || (hasLink && words.length <= 5) || lowValueEmojiOnly;

  const positive = includesAny(text, POSITIVE_WORDS);
  const negative = includesAny(text, NEGATIVE_WORDS);
  const purchaseIntent = includesAny(text, PURCHASE_WORDS);
  const priceQuestion = includesAny(text, PRICE_WORDS) && isQuestion;
  const availabilityQuestion = includesAny(text, AVAILABILITY_WORDS) && isQuestion;
  const trustSignal = includesAny(text, TRUST_WORDS);
  const sponsorshipConcern = includesAny(text, SPONSORSHIP_WORDS);
  const productProofQuestion = includesAny(text, PRODUCT_PROOF_WORDS) && isQuestion;

  const labels = [];
  if (purchaseIntent) labels.push('Purchase intent');
  if (priceQuestion) labels.push('Price question');
  if (availabilityQuestion) labels.push('Availability question');
  if (trustSignal) labels.push('Trust signal');
  if (sponsorshipConcern) labels.push('Sponsorship concern');
  if (productProofQuestion) labels.push('Proof request');
  if (isQuestion) labels.push('Question');
  if (positive) labels.push('Positive');
  if (negative) labels.push('Negative');
  if (spam) labels.push('Spam / low value');

  return {
    positive,
    negative,
    neutral: !positive && !negative,
    purchaseIntent,
    priceQuestion,
    availabilityQuestion,
    priceAvailabilityQuestion: priceQuestion || availabilityQuestion,
    trustSignal,
    sponsorshipConcern,
    productProofQuestion,
    question: isQuestion,
    spamIrrelevant: spam,
    meaningful: !spam && !tooShort && words.length >= 3,
    labels,
    text: rawText,
    isReply: Boolean(comment.isReply)
  };
}

function getCommentPublishedTime(comment = {}) {
  const date = new Date(comment.publishedAt || comment.updatedAt || 0);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function normalizeCommentForInsight(comment = {}, classification = null) {
  const result = classification || classifyComment(comment);
  const score =
    toNumber(comment.likeCount) * 3 +
    toNumber(comment.replyCount) * 2 +
    (result.meaningful ? 10 : 0) +
    (result.question ? 4 : 0) +
    (result.purchaseIntent ? 6 : 0) +
    (result.trustSignal ? 5 : 0) -
    (result.spamIrrelevant ? 25 : 0);

  return {
    commentId: comment.commentId,
    authorDisplayName: comment.authorDisplayName || '',
    authorProfileImageUrl: comment.authorProfileImageUrl || '',
    text: comment.text || '',
    likeCount: toNumber(comment.likeCount),
    replyCount: toNumber(comment.replyCount),
    publishedAt: comment.publishedAt || null,
    updatedAt: comment.updatedAt || null,
    labels: result.labels,
    sentiment: result.positive ? 'positive' : result.negative ? 'negative' : 'neutral',
    insightScore: score
  };
}

function dedupeComments(comments = []) {
  const seen = new Set();
  const out = [];
  for (const comment of comments || []) {
    const textKey = clean(comment.text).toLowerCase();
    const key = comment.commentId || `${comment.authorDisplayName || ''}-${textKey}`;
    if (!textKey || seen.has(key)) continue;
    seen.add(key);
    out.push(comment);
  }
  return out;
}

function buildCommentTabs(comments = [], classifications = []) {
  const enriched = dedupeComments(comments)
    .map((comment, index) => ({
      ...normalizeCommentForInsight(comment, classifications[index]),
      classification: classifications[index] || classifyComment(comment)
    }))
    .filter((item) => item.text && item.insightScore > -25);

  const sortByLatest = (items = []) => [...items].sort((a, b) => getCommentPublishedTime(b) - getCommentPublishedTime(a));
  const sortBySignal = (items = []) => [...items].sort((a, b) => toNumber(b.insightScore) - toNumber(a.insightScore) || getCommentPublishedTime(b) - getCommentPublishedTime(a));
  const cleanForTab = (items = []) => items.slice(0, 10).map(({ classification, ...item }) => item);
  const makeTab = (key, label, items, latest = false) => ({ key, label, count: items.length, comments: cleanForTab(latest ? sortByLatest(items) : sortBySignal(items)) });
  const bySentiment = (sentiment) => enriched.filter((item) => item.sentiment === sentiment);
  const byClassification = (predicate) => enriched.filter((item) => predicate(item.classification || {}));

  return {
    latest: makeTab('latest', 'Latest 10', enriched, true),
    positive: makeTab('positive', 'Positive 10', bySentiment('positive')),
    neutral: makeTab('neutral', 'Neutral 10', bySentiment('neutral')),
    negative: makeTab('negative', 'Negative 10', bySentiment('negative')),
    purchaseIntent: makeTab('purchaseIntent', 'Purchase Intent', byClassification((item) => item.purchaseIntent)),
    priceAvailability: makeTab('priceAvailability', 'Price / Availability', byClassification((item) => item.priceAvailabilityQuestion)),
    questions: makeTab('questions', 'Questions', byClassification((item) => item.question)),
    trustSignals: makeTab('trustSignals', 'Trust Signals', byClassification((item) => item.trustSignal)),
    productProof: makeTab('productProof', 'Proof Requests', byClassification((item) => item.productProofQuestion)),
    sponsorshipConcerns: makeTab('sponsorshipConcerns', 'Sponsorship', byClassification((item) => item.sponsorshipConcern)),
    spamIrrelevant: makeTab('spamIrrelevant', 'Spam / Low Value', byClassification((item) => item.spamIrrelevant))
  };
}

function buildCommonThemes(counts) {
  const themes = [];
  if (counts.purchaseIntent) themes.push({ theme: 'Buying interest', count: counts.purchaseIntent, interpretation: 'Viewers are showing commercial intent.' });
  if (counts.priceQuestions) themes.push({ theme: 'Price questions', count: counts.priceQuestions, interpretation: 'Viewers need price clarity before purchase.' });
  if (counts.availabilityQuestions) themes.push({ theme: 'Availability questions', count: counts.availabilityQuestions, interpretation: 'Audience is considering where or how to access the topic/product.' });
  if (counts.trustSignals) themes.push({ theme: 'Creator trust', count: counts.trustSignals, interpretation: 'Audience language suggests trust in the creator recommendation.' });
  if (counts.questions) themes.push({ theme: 'Audience curiosity', count: counts.questions, interpretation: 'Viewers are asking for more details.' });
  if (counts.sponsorshipConcerns) themes.push({ theme: 'Sponsorship transparency', count: counts.sponsorshipConcerns, interpretation: 'Some viewers are checking whether content is paid or sponsored.' });
  if (counts.productProofQuestions) themes.push({ theme: 'Proof / demo requests', count: counts.productProofQuestions, interpretation: 'Viewers want evidence, durability, result, or demo clarity.' });
  if (counts.negativeSkeptical) themes.push({ theme: 'Objections or skepticism', count: counts.negativeSkeptical, interpretation: 'Some resistance or negative sentiment is visible.' });
  if (counts.spamIrrelevant) themes.push({ theme: 'Spam / irrelevant noise', count: counts.spamIrrelevant, interpretation: 'Some comments are not useful for insight.' });
  return themes;
}

function getSentimentLabel(sentiment = {}) {
  const positive = toNumber(sentiment.positive);
  const negative = toNumber(sentiment.negative);
  if (positive >= 60 && negative <= 15) return 'Positive';
  if (negative >= 25) return 'Needs Review';
  if (positive >= 35) return 'Mixed';
  return 'Mixed / neutral';
}

function analyzeComments(comments = [], replies = [], options = {}) {
  const topLevel = Array.isArray(comments) ? comments : [];
  const replyRows = Array.isArray(replies) ? replies : [];
  const rows = options.includeRepliesInAnalysis ? [...topLevel, ...replyRows] : topLevel;
  const total = rows.length;
  const initial = {
    positive: 0, neutral: 0, negative: 0, purchaseIntent: 0, positiveReactions: 0,
    priceQuestions: 0, availabilityQuestions: 0, priceAvailabilityQuestions: 0, trustSignals: 0,
    negativeSkeptical: 0, spamIrrelevant: 0, sponsorshipConcerns: 0, productProofQuestions: 0,
    questions: 0, meaningful: 0,
    examples: { purchaseIntent: [], priceQuestions: [], availabilityQuestions: [], trustSignals: [], negativeSkeptical: [], positiveReactions: [], sponsorshipConcerns: [], productProofQuestions: [], questions: [] },
    classifications: []
  };

  const result = rows.reduce((acc, comment) => {
    const classification = classifyComment(comment);
    acc.classifications.push(classification);
    if (classification.positive) acc.positive += 1;
    if (classification.negative) acc.negative += 1;
    if (!classification.positive && !classification.negative) acc.neutral += 1;
    if (classification.purchaseIntent) { acc.purchaseIntent += 1; acc.examples.purchaseIntent.push(classification.text); }
    if (classification.positive) { acc.positiveReactions += 1; acc.examples.positiveReactions.push(classification.text); }
    if (classification.priceQuestion) { acc.priceQuestions += 1; acc.examples.priceQuestions.push(classification.text); }
    if (classification.availabilityQuestion) { acc.availabilityQuestions += 1; acc.examples.availabilityQuestions.push(classification.text); }
    if (classification.priceAvailabilityQuestion) acc.priceAvailabilityQuestions += 1;
    if (classification.trustSignal) { acc.trustSignals += 1; acc.examples.trustSignals.push(classification.text); }
    if (classification.negative) { acc.negativeSkeptical += 1; acc.examples.negativeSkeptical.push(classification.text); }
    if (classification.spamIrrelevant) acc.spamIrrelevant += 1;
    if (classification.sponsorshipConcern) { acc.sponsorshipConcerns += 1; acc.examples.sponsorshipConcerns.push(classification.text); }
    if (classification.productProofQuestion) { acc.productProofQuestions += 1; acc.examples.productProofQuestions.push(classification.text); }
    if (classification.question) { acc.questions += 1; acc.examples.questions.push(classification.text); }
    if (classification.meaningful) acc.meaningful += 1;
    return acc;
  }, initial);

  const sentiment = {
    positive: percent(result.positive, total),
    neutral: percent(result.neutral, total),
    negative: percent(result.negative, total)
  };
  sentiment.label = getSentimentLabel(sentiment);

  const topLevelClassifications = result.classifications.slice(0, topLevel.length);
  const normalizedTop = dedupeComments(topLevel)
    .map((comment, index) => normalizeCommentForInsight(comment, topLevelClassifications[index]))
    .filter((item) => item.text && item.insightScore > -10)
    .sort((a, b) => toNumber(b.insightScore) - toNumber(a.insightScore))
    .slice(0, 15);

  return {
    totalCommentsAnalyzed: total,
    totalRepliesAnalyzed: replyRows.length,
    sentiment,
    categories: {
      purchaseIntent: { count: result.purchaseIntent, insight: result.purchaseIntent > total * 0.12 ? 'Strong commercial interest visible' : result.purchaseIntent > 0 ? 'Some buying interest visible' : 'No strong buying signal detected' },
      positiveReactions: { count: result.positiveReactions, insight: result.positiveReactions > result.negativeSkeptical ? 'Audience response is mostly positive' : 'Positive response should be improved' },
      priceAvailabilityQuestions: { count: result.priceAvailabilityQuestions, insight: result.priceAvailabilityQuestions > 0 ? 'Viewers are asking practical access or buying questions' : 'Limited price or availability curiosity' },
      trustSignals: { count: result.trustSignals, insight: result.trustSignals > 0 ? 'Creator trust is visible in audience language' : 'Trust language is limited in comments' },
      negativeSkeptical: { count: result.negativeSkeptical, insight: result.negativeSkeptical <= total * 0.05 ? 'Low visible resistance' : 'Audience resistance should be reviewed' },
      spamIrrelevant: { count: result.spamIrrelevant, insight: result.spamIrrelevant <= total * 0.1 ? 'Normal noise level' : 'Comment quality is affected by spam or low-value comments' },
      sponsorshipConcerns: { count: result.sponsorshipConcerns, insight: result.sponsorshipConcerns > 0 ? 'Some viewers are checking sponsorship transparency' : 'No major sponsorship concern detected' },
      productProofQuestions: { count: result.productProofQuestions, insight: result.productProofQuestions > 0 ? 'Audience wants proof, demo, result, or durability clarity' : 'Limited proof-request comments detected' }
    },
    commonThemes: buildCommonThemes(result),
    topComments: normalizedTop,
    commentTabs: buildCommentTabs(topLevel, topLevelClassifications),
    topQuestions: uniqueTop(result.examples.questions),
    topPurchaseIntentExamples: uniqueTop(result.examples.purchaseIntent),
    topTrustExamples: uniqueTop(result.examples.trustSignals),
    topObjections: uniqueTop(result.examples.negativeSkeptical),
    rawCounts: { ...result, classifications: undefined }
  };
}

function inferContentFormat(videoMetrics) {
  const text = `${videoMetrics.title || ''} ${videoMetrics.description || ''} ${(videoMetrics.tags || []).join(' ')}`.toLowerCase();
  if (/\b(review|honest review|tested|testing)\b/.test(text)) return 'Review / testing';
  if (/\b(tutorial|how to|guide|step by step|explained)\b/.test(text)) return 'Tutorial / educational';
  if (/\b(demo|demonstration|try on|unboxing|test)\b/.test(text)) return 'Demo / unboxing';
  if (/\b(vs|versus|compare|comparison|better than)\b/.test(text)) return 'Comparison';
  if (/\b(my experience|story|journey|testimonial)\b/.test(text)) return 'Experience / testimonial';
  if (/\b(vlog|day in my life|travel)\b/.test(text)) return 'Vlog / lifestyle';
  if (videoMetrics.durationSeconds > 0 && videoMetrics.durationSeconds <= 90) return 'Short-form awareness';
  return 'General YouTube content';
}

function analyzeContentQuality(videoMetrics) {
  const title = clean(videoMetrics.title);
  const description = clean(videoMetrics.description);
  const hasDescriptionLink = /https?:\/\//i.test(description);
  const hasHashtags = /#[\w-]+/i.test(`${title} ${description}`);
  const hasCta = includesAny(lower(description), CTA_WORDS);
  let titleQualityScore = 50;
  if (title.length >= 25 && title.length <= 90) titleQualityScore += 15;
  if (/\b(review|demo|test|tutorial|how|best|vs|launch|unboxing|vlog|explained)\b/i.test(title)) titleQualityScore += 10;
  if (videoMetrics.thumbnailUrl) titleQualityScore += 10;
  if (videoMetrics.viewCount > 0) titleQualityScore += 5;
  let descriptionCompletenessScore = 35;
  if (description.length >= 80) descriptionCompletenessScore += 15;
  if (description.length >= 250) descriptionCompletenessScore += 10;
  if (hasDescriptionLink) descriptionCompletenessScore += 15;
  if (hasHashtags) descriptionCompletenessScore += 10;
  if (hasCta) descriptionCompletenessScore += 15;
  return {
    contentFormat: inferContentFormat(videoMetrics),
    titleQualityScore: round(clamp(titleQualityScore)),
    descriptionCompletenessScore: round(clamp(descriptionCompletenessScore)),
    thumbnailAvailable: Boolean(videoMetrics.thumbnailUrl),
    hasDescriptionLink,
    hasHashtags,
    hasPinnedCtaPotential: true,
    insight: 'Content quality is estimated from public metadata, title clarity, description completeness, CTA signals, and thumbnail availability.'
  };
}

function inferInfluencerCategory(videoMetrics, channelMetrics, contentQuality) {
  const topicText = [videoMetrics.categoryName, videoMetrics.title, videoMetrics.description, ...(videoMetrics.tags || []), channelMetrics.title, channelMetrics.description, ...(channelMetrics.topicDetails?.topicCategories || [])].join(' ').toLowerCase();
  const scored = CATEGORY_KEYWORDS.map((row) => ({ category: row.category, score: row.words.reduce((sum, word) => sum + (topicText.includes(word) ? 1 : 0), 0) })).sort((a, b) => b.score - a.score);
  const best = scored[0];
  const primaryCategory = best?.score > 0 ? best.category : (videoMetrics.categoryName || 'General Creator');
  const secondaryCategories = scored.filter((row) => row.score > 0 && row.category !== primaryCategory).slice(0, 4).map((row) => row.category);
  const subscribers = toNumber(channelMetrics.subscriberCount);
  const totalViews = toNumber(channelMetrics.totalViewCount);
  const sizeTier = subscribers === 0 ? 'Hidden / unknown subscribers' : subscribers < 10000 ? 'Nano / emerging' : subscribers < 100000 ? 'Micro' : subscribers < 1000000 ? 'Mid-tier' : 'Macro';
  const authorityLevel = totalViews > 10000000 || subscribers > 500000 ? 'High public authority' : totalViews > 1000000 || subscribers > 100000 ? 'Established public authority' : 'Emerging public authority';
  const contentFormat = contentQuality.contentFormat || inferContentFormat(videoMetrics);
  const bestUseCases = [];
  if (/review|testing|demo|unboxing|comparison/i.test(contentFormat)) bestUseCases.push('Product review', 'Consideration content', 'Demo / proof content');
  if (/vlog|lifestyle|entertainment|short/i.test(contentFormat)) bestUseCases.push('Awareness', 'Lifestyle integration', 'Top-of-funnel reach');
  if (/tutorial|educational/i.test(contentFormat)) bestUseCases.push('Education-led campaigns', 'Explainer content');
  bestUseCases.push('Creator-fit validation');
  return {
    primaryCategory,
    youtubeCategory: videoMetrics.categoryName || '',
    categoryConfidence: clamp((best?.score || 0) * 18 + (videoMetrics.categoryName ? 20 : 0)),
    secondaryCategories,
    contentFormat,
    sizeTier,
    authorityLevel,
    bestUseCases: uniqueTop(bestUseCases, 6),
    notBestFor: ['Exact sales guarantee without tracking', 'Detailed demographic targeting without creator OAuth'],
    positioning: `${channelMetrics.title} appears to fit ${primaryCategory} with ${contentFormat.toLowerCase()} content and ${sizeTier.toLowerCase()} reach.`,
    recommendation: 'Validate against brand category, public comment tone, and recent-video consistency before final approval.'
  };
}

function metric(value, displayValue, formula, note = '') {
  return { value: value === null || typeof value === 'undefined' ? null : Number(value), displayValue, source: 'public_estimate', available: true, estimated: true, formula, note };
}

function buildPerformanceEstimates({ videoMetrics, commentIntelligence, creatorAverage, contentQuality, input = {} }) {
  const views = toNumber(videoMetrics.viewCount);
  const likes = toNumber(videoMetrics.likeCount);
  const comments = toNumber(videoMetrics.commentCount);
  const durationSeconds = toNumber(videoMetrics.durationSeconds);
  const engagementRate = toNumber(videoMetrics.engagementRate);
  const positive = toNumber(commentIntelligence.sentiment?.positive);
  const negative = toNumber(commentIntelligence.sentiment?.negative);
  const totalComments = toNumber(commentIntelligence.totalCommentsAnalyzed);
  const purchaseCount = toNumber(commentIntelligence.categories?.purchaseIntent?.count);
  const trustCount = toNumber(commentIntelligence.categories?.trustSignals?.count);
  const questionCount = toNumber(commentIntelligence.rawCounts?.questions);
  const purchaseRate = percent(purchaseCount, totalComments);
  const trustRate = percent(trustCount, totalComments);
  const questionRate = percent(questionCount, totalComments);
  const descriptionBoost = contentQuality.hasDescriptionLink ? 0.25 : 0;
  const ctaBoost = contentQuality.hasHashtags ? 0.05 : 0;
  const baselineComparisonBoost = creatorAverage.sampleSize && views >= toNumber(creatorAverage.averageViews) ? 0.2 : 0;
  const estimatedCtr = clamp(0.2 + engagementRate * 0.18 + purchaseRate * 0.12 + trustRate * 0.05 + descriptionBoost + ctaBoost + baselineComparisonBoost, 0.15, 8);
  const estimatedClicks = Math.round(views * estimatedCtr / 100);
  const estimatedConversionRate = clamp(0.15 + purchaseRate * 0.14 + trustRate * 0.08 + questionRate * 0.02 + positive * 0.01 - negative * 0.015, 0.05, 5);
  const estimatedConversions = Math.round(estimatedClicks * estimatedConversionRate / 100);
  const estimatedShareRate = clamp(0.03 + engagementRate * 0.09 + positive * 0.004 + (comments > 0 ? 0.03 : 0), 0.01, 3);
  const estimatedShares = Math.round(views * estimatedShareRate / 100);
  const estimatedSaveRate = clamp(0.02 + questionRate * 0.02 + purchaseRate * 0.03 + trustRate * 0.015, 0.01, 2);
  const estimatedSaves = Math.round(views * estimatedSaveRate / 100);
  const durationFactor = durationSeconds <= 60 ? 0.58 : durationSeconds <= 180 ? 0.46 : durationSeconds <= 600 ? 0.36 : durationSeconds <= 1200 ? 0.28 : 0.22;
  const retentionRate = clamp(durationFactor * 100 + engagementRate * 0.9 + positive * 0.04 - negative * 0.06 + (creatorAverage.sampleSize ? 2 : 0), 8, 82);
  const averageViewDurationSeconds = Math.round(durationSeconds * retentionRate / 100);
  const watchMinutes = Math.round(views * averageViewDurationSeconds / 60);
  const watchHours = round(watchMinutes / 60, 1);
  const rpmLow = Math.max(0, toNumber(input.rpmLow, 1.36));
  const rpmHigh = Math.max(0, toNumber(input.rpmHigh, 3.4));
  const revenueLow = round((views / 1000) * rpmLow, 2);
  const revenueHigh = round((views / 1000) * rpmHigh, 2);

  return {
    estimatedCtr: metric(round(estimatedCtr, 2), `${round(estimatedCtr, 2)}%`, 'base 0.2 + engagementRate*0.18 + purchaseIntentRate*0.12 + trustRate*0.05 + metadata boosts', 'Estimated CTA/click-through potential from public data. Actual thumbnail CTR requires YouTube Analytics.'),
    estimatedClicks: metric(estimatedClicks, compactNumber(estimatedClicks), 'videoViews * estimatedCtr / 100', 'Estimated clicks from description, pinned comment, and visible CTA potential.'),
    estimatedConversionRate: metric(round(estimatedConversionRate, 2), `${round(estimatedConversionRate, 2)}%`, 'base 0.15 + purchaseIntentRate*0.14 + trustRate*0.08 + questionRate*0.02 + sentiment adjustment', 'Estimated conversion potential without brand inputs. Actual conversions require UTM, coupon, affiliate, or checkout tracking.'),
    estimatedConversions: metric(estimatedConversions, compactNumber(estimatedConversions), 'estimatedClicks * estimatedConversionRate / 100', 'Formula estimate only. Requires brand tracking to confirm.'),
    estimatedShareRate: metric(round(estimatedShareRate, 2), `${round(estimatedShareRate, 2)}%`, 'base 0.03 + engagementRate*0.09 + positiveSentiment*0.004 + comment boost', 'Share rate is estimated because YouTube Data API does not expose public share counts.'),
    estimatedShares: metric(estimatedShares, compactNumber(estimatedShares), 'videoViews * estimatedShareRate / 100', 'Estimated share count from public engagement and sentiment signals.'),
    estimatedSaveRate: metric(round(estimatedSaveRate, 2), `${round(estimatedSaveRate, 2)}%`, '0.02 + questionRate*0.02 + purchaseIntentRate*0.03 + trustRate*0.015', 'YouTube public API does not expose saves.'),
    estimatedSaves: metric(estimatedSaves, compactNumber(estimatedSaves), 'views * estimatedSaveRate / 100', 'Public estimate only.'),
    estimatedRetentionRate: metric(round(retentionRate, 1), `${round(retentionRate, 1)}%`, 'duration benchmark + engagement + sentiment + creator baseline boost', 'Actual retention requires YouTube Analytics OAuth.'),
    estimatedAverageViewDurationSeconds: metric(averageViewDurationSeconds, formatDurationFromSeconds(averageViewDurationSeconds), 'durationSeconds * estimatedRetentionRate', 'Estimated average view duration.'),
    estimatedWatchTimeMinutes: metric(watchMinutes, compactNumber(watchMinutes), 'views * averageViewDurationSeconds / 60', 'Estimated total watch minutes.'),
    estimatedWatchTimeHours: metric(watchHours, compactNumber(watchHours), 'watchMinutes / 60', 'Estimated total watch hours.'),
    estimatedRevenueLow: metric(revenueLow, money(revenueLow), 'views / 1000 * rpmLow', 'Estimated from public views and assumed RPM.'),
    estimatedRevenueHigh: metric(revenueHigh, money(revenueHigh), 'views / 1000 * rpmHigh', 'Estimated from public views and assumed RPM.'),
    rpmLow,
    rpmHigh,
    note: 'CTR, clicks, conversions, shares, saves, retention, watch time, and revenue are formula estimates from public YouTube data only. No brand/campaign input is required and none of these are verified YouTube Analytics or sales-tracking metrics.'
  };
}

function calculateScores(videoMetrics, comments, channelMetrics, creatorAverage, estimates) {
  const engagementRate = toNumber(videoMetrics.engagementRate);
  const views = toNumber(videoMetrics.viewCount);
  const aboveCreatorViews = creatorAverage.sampleSize > 0 && views >= toNumber(creatorAverage.averageViews);
  const aboveCreatorEngagement = creatorAverage.sampleSize > 0 && engagementRate >= toNumber(creatorAverage.averageEngagementRate);
  const engagementQuality = clamp(engagementRate * 12 + (aboveCreatorViews ? 12 : 0) + (aboveCreatorEngagement ? 8 : 0));
  const positive = toNumber(comments.sentiment?.positive);
  const negative = toNumber(comments.sentiment?.negative);
  const sentimentScore = clamp(positive - negative + 50);
  const totalComments = toNumber(comments.totalCommentsAnalyzed);
  const purchaseRate = percent(comments.categories?.purchaseIntent?.count, totalComments);
  const questionRate = percent(comments.rawCounts?.questions, totalComments);
  const spamRate = percent(comments.categories?.spamIrrelevant?.count, totalComments);
  const commentQualityScore = clamp(percent(comments.rawCounts?.meaningful, totalComments) * 0.65 + questionRate * 0.35 - spamRate * 0.4);
  const audienceCuriosityScore = clamp(questionRate * 4.5);
  const creatorAuthorityScore = clamp((toNumber(channelMetrics.subscriberCount) ? 20 : 0) + Math.log10(Math.max(1, toNumber(channelMetrics.totalViewCount))) * 9 + (creatorAverage.sampleSize ? 10 : 0));
  const contentEffectivenessScore = clamp(engagementQuality * 0.35 + commentQualityScore * 0.25 + purchaseRate * 3 + audienceCuriosityScore * 0.15);
  const channelFitScore = clamp(55 + (aboveCreatorViews ? 12 : 0) + (aboveCreatorEngagement ? 10 : 0) + (creatorAverage.sampleSize >= 8 ? 8 : 0) + (toNumber(channelMetrics.videoCount) >= 20 ? 7 : 0));
  const conversionPotentialScore = clamp(toNumber(estimates.estimatedCtr?.value) * 8 + toNumber(estimates.estimatedConversionRate?.value) * 10 + purchaseRate * 2 + sentimentScore * 0.25);
  const finalAiScore = clamp(engagementQuality * 0.22 + sentimentScore * 0.18 + commentQualityScore * 0.15 + contentEffectivenessScore * 0.15 + channelFitScore * 0.15 + creatorAuthorityScore * 0.07 + conversionPotentialScore * 0.08);
  return {
    videoPerformanceScore: round(clamp((aboveCreatorViews ? 70 : 45) + engagementRate * 4)),
    engagementQuality: round(engagementQuality),
    sentimentScore: round(sentimentScore),
    commentQualityScore: round(commentQualityScore),
    audienceCuriosityScore: round(audienceCuriosityScore),
    creatorAuthorityScore: round(creatorAuthorityScore),
    contentEffectivenessScore: round(contentEffectivenessScore),
    channelFitScore: round(channelFitScore),
    conversionPotentialScore: round(conversionPotentialScore),
    finalAiScore: round(finalAiScore)
  };
}

function compareMetric(current, base, decimals = 2) {
  const c = toNumber(current);
  const b = toNumber(base);
  if (!b) return { deltaPercent: null, direction: 'neutral', result: 'Needs baseline' };
  const delta = round(((c - b) / b) * 100, decimals);
  return { deltaPercent: delta, direction: delta >= 0 ? 'up' : 'down', result: delta >= 15 ? 'Above average' : delta >= 0 ? 'Near / slightly above' : delta >= -20 ? 'Slightly below' : 'Below average' };
}

function buildChannelBaseline(videoMetrics, creatorAverage) {
  const viewCompare = compareMetric(videoMetrics.viewCount, creatorAverage.averageViews);
  const likeCompare = compareMetric(videoMetrics.likeCount, creatorAverage.averageLikes);
  const commentCompare = compareMetric(videoMetrics.commentCount, creatorAverage.averageComments);
  const engagementCompare = compareMetric(videoMetrics.engagementRate, creatorAverage.averageEngagementRate);
  const rows = [
    { metric: 'Views', thisVideo: compactNumber(videoMetrics.viewCount), creatorAverage: compactNumber(creatorAverage.averageViews), ...viewCompare },
    { metric: 'Likes', thisVideo: compactNumber(videoMetrics.likeCount), creatorAverage: compactNumber(creatorAverage.averageLikes), ...likeCompare },
    { metric: 'Comments', thisVideo: compactNumber(videoMetrics.commentCount), creatorAverage: compactNumber(creatorAverage.averageComments), ...commentCompare },
    { metric: 'Engagement', thisVideo: `${round(videoMetrics.engagementRate, 2)}%`, creatorAverage: `${round(creatorAverage.averageEngagementRate, 2)}%`, ...engagementCompare }
  ];
  return {
    creatorAverageViews: creatorAverage.averageViews,
    creatorAverageLikes: creatorAverage.averageLikes,
    creatorAverageComments: creatorAverage.averageComments,
    creatorAverageEngagementRate: creatorAverage.averageEngagementRate,
    creatorAverageDurationSeconds: creatorAverage.averageDurationSeconds,
    recentVideosAnalyzed: creatorAverage.sampleSize,
    comparisonResult: creatorAverage.sampleSize ? `Compared with the creator's recent ${creatorAverage.sampleSize} public uploads, this video is ${viewCompare.result.toLowerCase()} on views and ${engagementCompare.result.toLowerCase()} on engagement.` : 'Recent public upload baseline was not available.',
    rows
  };
}

function determineVerdict(scores, creatorInsights) {
  const score = toNumber(scores.finalAiScore);
  const verdict = score >= 82 ? 'Strong creator fit' : score >= 68 ? 'Good test candidate' : score >= 52 ? 'Awareness-only candidate' : 'Review before shortlisting';
  return {
    verdict,
    finalScore: round(score),
    reason: score >= 68 ? 'Public channel, video, comment, and estimated-response signals are strong enough for a tracked brand test.' : 'Public signals need more review before using this creator for conversion or high-risk brand claims.',
    bestUseCases: creatorInsights.bestUseCases || [],
    notBestFor: creatorInsights.notBestFor || [],
    futureCollaborationRecommendation: score >= 68 ? 'Use with trackable link, pinned CTA, and clear brief.' : 'Use only after reviewing category fit, audience comments, and creator baseline.',
    nextSteps: ['Add UTM/affiliate/coupon tracking.', 'Pin a CTA and FAQ comment.', 'Review latest negative and question comments.', 'Compare with next public upload after campaign.']
  };
}

function getVideoType(videoMetrics) {
  if (videoMetrics.liveBroadcastContent === 'live' || Object.keys(videoMetrics.liveStreamingDetails || {}).length) return 'livestream';
  if (videoMetrics.durationSeconds > 0 && videoMetrics.durationSeconds <= 90) return 'short_form';
  return 'long_form';
}

function buildMissingMetrics() {
  return ['youtube_impressions', 'true_thumbnail_ctr', 'actual_shares', 'actual_saves', 'audience_retention', 'true_watch_time', 'traffic_sources', 'age_gender_demographics', 'subscriber_gain_loss', 'actual_youtube_revenue', 'actual_brand_conversions'];
}


function buildChannelInsightsFromBaseline(channelMetrics, creatorInsights, channelBaseline) {
  const analyzed = toNumber(channelBaseline.recentVideosAnalyzed);
  return {
    channelSizeTier: creatorInsights.sizeTier || '',
    creatorAverageViews: channelBaseline.creatorAverageViews || 0,
    creatorAverageLikes: channelBaseline.creatorAverageLikes || 0,
    creatorAverageComments: channelBaseline.creatorAverageComments || 0,
    creatorAverageEngagementRate: channelBaseline.creatorAverageEngagementRate || 0,
    creatorAverageDurationSeconds: channelBaseline.creatorAverageDurationSeconds || 0,
    recentVideosAnalyzed: analyzed,
    postingConsistency: analyzed >= 8 ? 'Enough recent uploads for a public creator baseline' : analyzed > 0 ? 'Limited public creator baseline' : 'Recent public upload baseline unavailable',
    categoryFit: creatorInsights.positioning || 'Creator fit is inferred from public channel/video metadata, comments, and recent uploads.',
    insight: channelBaseline.comparisonResult || 'Creator baseline comparison is not available for this report.'
  };
}

function buildEstimatedWatchTimeDocument(performanceEstimates) {
  return {
    retentionRate: performanceEstimates.estimatedRetentionRate,
    averageViewDurationSeconds: performanceEstimates.estimatedAverageViewDurationSeconds,
    totalWatchTimeMinutes: performanceEstimates.estimatedWatchTimeMinutes,
    totalWatchTimeHours: performanceEstimates.estimatedWatchTimeHours,
    formula: performanceEstimates.estimatedWatchTimeMinutes?.formula || 'views * averageViewDurationSeconds / 60',
    note: 'Estimated from public views, duration, engagement, sentiment, and creator baseline. Actual watch time requires YouTube Analytics OAuth.'
  };
}

function buildEstimatedRevenueDocument(videoMetrics, performanceEstimates) {
  const low = toNumber(performanceEstimates.estimatedRevenueLow?.value);
  const high = toNumber(performanceEstimates.estimatedRevenueHigh?.value);
  return {
    rpmLow: performanceEstimates.rpmLow || 1.36,
    rpmHigh: performanceEstimates.rpmHigh || 3.4,
    totalVideoViews: videoMetrics.viewCount || 0,
    totalVideoViewsDisplay: compactNumber(videoMetrics.viewCount),
    estimatedRevenueLow: low,
    estimatedRevenueHigh: high,
    estimatedRevenueRangeDisplay: `${money(low)} - ${money(high)}`,
    source: 'Estimated from public views and assumed RPM range. Not actual YouTube Analytics revenue.',
    available: true,
    isEstimate: true
  };
}

function buildPerformanceComparisonDocument(videoMetrics, creatorAverage, channelBaseline) {
  return {
    currentVideo: {
      views: videoMetrics.viewCount || 0,
      likes: videoMetrics.likeCount || 0,
      comments: videoMetrics.commentCount || 0,
      engagementRate: videoMetrics.engagementRate || 0
    },
    creatorAverage: {
      views: creatorAverage.averageViews || 0,
      likes: creatorAverage.averageLikes || 0,
      comments: creatorAverage.averageComments || 0,
      engagementRate: creatorAverage.averageEngagementRate || 0,
      sampleSize: creatorAverage.sampleSize || 0
    },
    rows: channelBaseline.rows || [],
    comparisonResult: channelBaseline.comparisonResult || ''
  };
}

function buildAdvancedCommentInsights(commentIntelligence) {
  const counts = commentIntelligence.rawCounts || {};
  const examples = counts.examples || {};
  return {
    repeatedThemes: commentIntelligence.commonThemes || [],
    buyingSignals: uniqueTop(examples.purchaseIntent || commentIntelligence.topPurchaseIntentExamples || []),
    pricingQuestions: uniqueTop(examples.priceQuestions || []),
    availabilityQuestions: uniqueTop(examples.availabilityQuestions || []),
    sponsorshipConcerns: uniqueTop(examples.sponsorshipConcerns || []),
    productProofQuestions: uniqueTop(examples.productProofQuestions || []),
    aiInterpretation: 'Comments are grouped into sentiment, purchase intent, price/availability, trust, proof requests, sponsorship concerns, objections, and spam/low-value buckets for brand readability.'
  };
}


function toObjectId(value) {
  const id = clean(value);
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null;
}

function shouldPersistReport(payload = {}) {
  if (payload.saveReport === false || payload.persist === false || payload.shouldSave === false) return false;
  if (clean(payload.mode).toLowerCase() === 'public' || clean(payload.sourceContext).toLowerCase() === 'public_insight_os') return false;
  return true;
}

async function createInsightReport({ actor = {}, payload = {} }) {
  const input = buildYoutubeOnlyInput(payload);
  const videoId = extractYouTubeVideoId(input.videoUrl);
  if (!videoId) {
    const error = new Error('Invalid YouTube video URL or video ID. Send videoUrl, youtubeUrl, videoLink, link, or a raw 11-character videoId.');
    error.statusCode = 400;
    throw error;
  }

  const videoUrl = buildYouTubeWatchUrl(videoId);
  const videoRaw = await getVideoDetails(videoId);
  const videoMetrics = normalizeVideo(videoRaw);
  const channelRaw = await getChannelDetails(videoMetrics.channelId);
  const channelMetrics = normalizeChannel(channelRaw);

  const [relevanceComments, latestComments] = await Promise.all([
    getPublicCommentThreads(videoId, input.maxComments, { includeReplies: input.includeReplies, maxRepliesPerThread: input.maxRepliesPerThread, order: input.commentOrder }),
    getPublicCommentThreads(videoId, Math.min(input.maxComments, 100), { includeReplies: false, order: 'time' })
  ]);

  const mergedComments = dedupeComments([...(relevanceComments.comments || []), ...(latestComments.comments || [])]);
  const mergedReplies = dedupeComments([...(relevanceComments.replies || []), ...(latestComments.replies || [])]);
  const commentIntelligence = analyzeComments(mergedComments, mergedReplies, { includeRepliesInAnalysis: input.includeRepliesInAnalysis });

  const recentVideoIds = await getRecentChannelVideoIds(channelMetrics.uploadsPlaylistId, input.creatorAverageLimit);
  const recentVideosRaw = await getVideosStats(recentVideoIds);
  const creatorAverage = calculateCreatorAverage(recentVideosRaw, videoId);
  const channelBaseline = buildChannelBaseline(videoMetrics, creatorAverage);
  const contentQuality = analyzeContentQuality(videoMetrics);
  const creatorInsights = inferInfluencerCategory(videoMetrics, channelMetrics, contentQuality);
  const performanceEstimates = buildPerformanceEstimates({ videoMetrics, commentIntelligence, creatorAverage, contentQuality, input });
  const channelInsights = buildChannelInsightsFromBaseline(channelMetrics, creatorInsights, channelBaseline);
  const estimatedWatchTime = buildEstimatedWatchTimeDocument(performanceEstimates);
  const estimatedRevenue = buildEstimatedRevenueDocument(videoMetrics, performanceEstimates);
  const performanceComparison = buildPerformanceComparisonDocument(videoMetrics, creatorAverage, channelBaseline);
  const advancedCommentInsights = buildAdvancedCommentInsights(commentIntelligence);
  const scores = calculateScores(videoMetrics, commentIntelligence, channelMetrics, creatorAverage, performanceEstimates);
  const finalVerdict = determineVerdict(scores, creatorInsights);
  const aiInsights = await generateYoutubeAiSummary({
    videoMetrics,
    channelMetrics,
    creatorInsights,
    commentIntelligence,
    performanceEstimates,
    scores,
    finalVerdict,
    channelBaseline,
    contentQuality,
    estimatedWatchTime,
    estimatedRevenue,
    performanceComparison,
    advancedCommentInsights
  });
  const aiSummary = { ...aiInsights };

  const brandObjectId = toObjectId(payload.brandId || actor.brandId);
  const persistReport = shouldPersistReport(payload);

  const reportPayload = {
    userId: actor.userId || null,
    brandId: brandObjectId,
    brandName: clean(payload.brandName || actor.brandName),
    createdByAdminId: actor.adminId || null,
    createdByAdminName: actor.name || '',
    createdByAdminEmail: actor.email || '',
    createdByAdminRole: actor.role || '',
    reportType: 'YouTube Link Intelligence Report',
    platform: 'YouTube',
    reportStatus: 'Published',
    sourceType: 'public_youtube_link',
    sourceContext: clean(payload.sourceContext) || (persistReport ? 'brand_insight_os' : 'public_insight_os'),
    videoUrl,
    videoId,
    hero: {
      influencerName: channelMetrics.title,
      platform: 'YouTube',
      livePublishedLink: videoUrl,
      thumbnailUrl: videoMetrics.thumbnailUrl,
      publishDate: videoMetrics.publishedAt,
      status: 'Published',
      videoType: getVideoType(videoMetrics),
      videoTitle: videoMetrics.title,
      channelThumbnailUrl: channelMetrics.thumbnailUrl,
      channelUrl: channelMetrics.channelUrl
    },
    channelMetrics,
    videoMetrics,
    influencerInsights: creatorInsights,
    creatorInsights,
    channelInsights,
    channelBaseline,
    contentQuality,
    performanceEstimates,
    estimatedWatchTime,
    estimatedRevenue,
    commentIntelligence,
    advancedCommentInsights,
    performanceComparison,
    aiScores: scores,
    aiInsights,
    aiSummary,
    finalVerdict,
    publicStats: {
      videoViews: videoMetrics.viewCount,
      videoLikes: videoMetrics.likeCount,
      videoComments: videoMetrics.commentCount,
      videoFavorites: videoMetrics.favoriteCount,
      channelSubscribers: channelMetrics.subscriberCount,
      channelTotalViews: channelMetrics.totalViewCount,
      channelTotalVideos: channelMetrics.videoCount,
      channelTotalLikesAvailable: false
    },
    dashboard: null,
    chartData: null,
    dataAvailability: {
      publicYoutubeDataAvailable: true,
      youtubeAnalyticsConnected: false,
      commentsDisabled: relevanceComments.disabled || latestComments.disabled,
      commentsFetchError: relevanceComments.error || latestComments.error || '',
      repliesFullyFetched: relevanceComments.repliesFullyFetched,
      estimatedMetricsUsed: true,
      missingMetrics: buildMissingMetrics(),
      notes: [
        'This report is generated only from public YouTube video, channel, comments, and recent-upload data.',
        'CTR, shares, saves, conversions, watch time, retention, demographics, and revenue are formula estimates unless YouTube Analytics or brand tracking is connected.',
        'For real conversion proof, use UTM links, affiliate links, coupon codes, or checkout-side tracking.'
      ]
    },
    rawData: {
      video: videoRaw,
      channel: channelRaw,
      recentVideoIds,
      recentVideosSample: recentVideosRaw.slice(0, 10),
      commentsSample: mergedComments.slice(0, 30),
      topComments: commentIntelligence.topComments,
      commentTabs: commentIntelligence.commentTabs,
      openAiRaw: aiInsights.source === 'openai' ? { model: aiInsights._rawModel || '' } : null
    }
    };


  if (!persistReport) {
    const previewReport = {
      ...reportPayload,
      _id: null,
      reportId: '',
      createdAt: new Date(),
      updatedAt: new Date()
    };
    previewReport.chartData = buildChartData(previewReport);
    previewReport.dashboard = buildYoutubeInsightDashboard(previewReport);
    return previewReport;
  }

  const report = await YoutubeInsightReport.create(reportPayload);

  report.chartData = buildChartData(report);
  report.dashboard = buildYoutubeInsightDashboard(report);
  await report.save();
  return report;
}

module.exports = {
  createInsightReport,
  analyzeComments,
  classifyComment,
  inferContentFormat,
  analyzeContentQuality,
  inferInfluencerCategory,
  buildPerformanceEstimates,
  calculateScores
};