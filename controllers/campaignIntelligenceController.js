// controllers/campaignIntelligenceController.js

const mongoose = require("mongoose");
const OpenAI = require("openai");

const Campaign = require("../models/campaign");
const CampaignPerformance = require("../models/campaignPerformance");
const { InfluencerModel: Influencer } = require("../models/influencer");
const Milestone = require("../models/milestone");
const Contract = require("../models/contract");
const saveErrorLog = require("../services/errorLog.service");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const num = (value) => Number(value || 0);

const calcEngagement = (m = {}) =>
  num(m.likes) + num(m.comments) + num(m.shares) + num(m.saves);

const calcEngagementRate = (engagement, reach) => {
  if (!reach) return 0;
  return Number(((engagement / reach) * 100).toFixed(2));
};

const groupBy = (items, keyFn) => {
  return items.reduce((acc, item) => {
    const key = keyFn(item) || "unknown";
    acc[key] = acc[key] || [];
    acc[key].push(item);
    return acc;
  }, {});
};

exports.getCampaignIntelligence = async (req, res) => {
  try {
    const { campaignId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(campaignId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid campaignId",
      });
    }

    const campaign = await Campaign.findById(campaignId).lean();

    if (!campaign) {
      return res.status(404).json({
        success: false,
        message: "Campaign not found",
      });
    }

    const performances = await CampaignPerformance.find({
      campaignId: new mongoose.Types.ObjectId(campaignId),
    }).lean();

    const influencerIds = [
      ...new Set(performances.map((p) => String(p.influencerId))),
    ];

    const influencers = await Influencer.find({
      _id: { $in: influencerIds },
    })
      .select("_id name handle category")
      .lean();

    const influencerMap = new Map(
      influencers.map((inf) => [String(inf._id), inf])
    );

    const totals = performances.reduce(
      (acc, item) => {
        const m = item.metrics || {};

        acc.reach += num(m.reach);
        acc.views += num(m.views);
        acc.likes += num(m.likes);
        acc.comments += num(m.comments);
        acc.shares += num(m.shares);
        acc.saves += num(m.saves);
        acc.clicks += num(m.clicks);
        acc.conversions += num(m.conversions);
        acc.revenue += num(m.revenue);
        acc.engagement += calcEngagement(m);

        return acc;
      },
      {
        reach: 0,
        views: 0,
        likes: 0,
        comments: 0,
        shares: 0,
        saves: 0,
        clicks: 0,
        conversions: 0,
        revenue: 0,
        engagement: 0,
      }
    );

    const campaignCost = num(campaign.campaignBudget || campaign.budget);
    const roi = campaignCost > 0 ? Number((totals.revenue / campaignCost).toFixed(2)) : 0;

    const avgEngagementRate = calcEngagementRate(
      totals.engagement,
      totals.reach
    );

    const byInfluencer = groupBy(performances, (p) => String(p.influencerId));

    const influencerRanking = Object.entries(byInfluencer)
      .map(([influencerId, rows]) => {
        const influencer = influencerMap.get(influencerId);

        const total = rows.reduce(
          (acc, row) => {
            const m = row.metrics || {};
            acc.reach += num(m.reach);
            acc.views += num(m.views);
            acc.engagement += calcEngagement(m);
            acc.clicks += num(m.clicks);
            acc.conversions += num(m.conversions);
            acc.revenue += num(m.revenue);
            return acc;
          },
          {
            reach: 0,
            views: 0,
            engagement: 0,
            clicks: 0,
            conversions: 0,
            revenue: 0,
          }
        );

        const engagementRate = calcEngagementRate(
          total.engagement,
          total.reach
        );

        const influencerCost = campaignCost / Math.max(influencerIds.length, 1);
        const influencerRoi =
          influencerCost > 0
            ? Number((total.revenue / influencerCost).toFixed(2))
            : 0;

        const performanceScore = Number(
          Math.min(
            10,
            engagementRate * 0.5 + influencerRoi * 1.2 + total.conversions * 0.02
          ).toFixed(1)
        );

        return {
          influencerId,
          influencerName: influencer?.name || "Influencer",
          handle: influencer?.handle || "",
          reach: total.reach,
          views: total.views,
          engagement: total.engagement,
          engagementRate,
          clicks: total.clicks,
          conversions: total.conversions,
          revenue: total.revenue,
          roi: influencerRoi,
          performanceScore,
        };
      })
      .sort((a, b) => b.performanceScore - a.performanceScore);

    const byContentType = groupBy(performances, (p) => p.contentType);

    const contentFormatPerformance = Object.entries(byContentType).map(
      ([contentType, rows]) => {
        const total = rows.reduce(
          (acc, row) => {
            const m = row.metrics || {};
            acc.reach += num(m.reach);
            acc.engagement += calcEngagement(m);
            acc.revenue += num(m.revenue);
            return acc;
          },
          { reach: 0, engagement: 0, revenue: 0 }
        );

        return {
          contentType,
          posts: rows.length,
          avgEngagementRate: calcEngagementRate(total.engagement, total.reach),
          avgRoi:
            campaignCost > 0
              ? Number((total.revenue / campaignCost).toFixed(2))
              : 0,
        };
      }
    );

    const byDate = groupBy(performances, (p) => {
      if (!p.postedAt) return "unknown";
      return new Date(p.postedAt).toISOString().slice(0, 10);
    });

    const timeline = Object.entries(byDate)
      .map(([date, rows]) => {
        const total = rows.reduce(
          (acc, row) => {
            const m = row.metrics || {};
            acc.views += num(m.views);
            acc.reach += num(m.reach);
            acc.engagement += calcEngagement(m);
            acc.clicks += num(m.clicks);
            acc.conversions += num(m.conversions);
            return acc;
          },
          { views: 0, reach: 0, engagement: 0, clicks: 0, conversions: 0 }
        );

        return { date, ...total };
      })
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));

    const commentIntelligence = performances.reduce(
      (acc, row) => {
        const ai = row.aiCommentAnalysis || {};
        acc.positiveFeedback += num(ai.positiveCount);
        acc.negativeReactions += num(ai.negativeCount);
        acc.purchaseIntent += num(ai.purchaseIntentCount);
        acc.priceQuestions += num(ai.priceQuestionCount);
        acc.brandMentions += num(ai.brandMentionCount);
        return acc;
      },
      {
        positiveFeedback: 0,
        negativeReactions: 0,
        purchaseIntent: 0,
        priceQuestions: 0,
        brandMentions: 0,
      }
    );

    const aiInput = {
      campaign: {
        title: campaign.campaignTitle,
        status: campaign.status,
        platformSelection: campaign.platformSelection,
        budget: campaignCost,
      },
      totals,
      avgEngagementRate,
      roi,
      influencerRanking: influencerRanking.slice(0, 5),
      contentFormatPerformance,
      commentIntelligence,
      timeline,
    };

    const aiResult = await generateCampaignAI(aiInput);

    return res.status(200).json({
      success: true,
      data: {
        overview: {
          campaignName: campaign.campaignTitle || campaign.productOrServiceName,
          totalInfluencers: influencerIds.length,
          campaignDuration: getDurationLabel(campaign.startAt, campaign.endAt),
          platform: campaign.platformSelection || [],
          campaignStatus: campaign.status,
        },

        kpis: {
          totalReach: totals.reach,
          totalViews: totals.views,
          totalEngagement: totals.engagement,
          avgEngagementRate,
          totalClicks: totals.clicks,
          estimatedROI: roi,
          revenue: totals.revenue,
          campaignCost,
        },

        aiSummary: aiResult.aiSummary,
        influencerRanking,

        expectedVsActual: buildExpectedVsActual({
          campaign,
          totals,
          avgEngagementRate,
          roi,
        }),

        audienceIntelligence: buildAudienceIntelligence(performances),
        commentIntelligence,
        contentFormatPerformance,
        timeline,

        learnings: aiResult.learnings,
        risks: aiResult.risks,
        finalVerdict: aiResult.finalVerdict,
      },
    });
  } catch (error) {
    console.error("Campaign intelligence error:", error);
    await saveErrorLog(req, error, 500, "GET_CAMPAIGN_INTELLIGENCE_ERROR");

    return res.status(500).json({
      success: false,
      message: "Failed to build campaign intelligence dashboard",
      error: error.message,
    });
  }
};

function getDurationLabel(startAt, endAt) {
  if (!startAt || !endAt) return "";
  const start = new Date(startAt);
  const end = new Date(endAt);
  const days = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
  return `${days} Days`;
}

function buildExpectedVsActual({ campaign, totals, avgEngagementRate, roi }) {
  const predictedReach = Number(campaign.expectedReach || 0);
  const predictedEngagementRate = Number(campaign.expectedEngagementRate || 0);
  const predictedClicks = Number(campaign.expectedClicks || 0);
  const predictedRoi = Number(campaign.expectedRoi || 0);

  return [
    {
      metric: "Reach",
      predicted: predictedReach,
      actual: totals.reach,
      result: totals.reach >= predictedReach ? "Above target" : "Below target",
    },
    {
      metric: "Engagement Rate",
      predicted: predictedEngagementRate,
      actual: avgEngagementRate,
      result:
        avgEngagementRate >= predictedEngagementRate
          ? "Strong"
          : "Needs improvement",
    },
    {
      metric: "Clicks",
      predicted: predictedClicks,
      actual: totals.clicks,
      result: totals.clicks >= predictedClicks ? "Excellent" : "Below target",
    },
    {
      metric: "ROI",
      predicted: predictedRoi,
      actual: roi,
      result: roi >= predictedRoi ? "Outperformed" : "Underperformed",
    },
  ];
}

function buildAudienceIntelligence(performances = []) {
  let female = 0;
  let male = 0;
  let other = 0;
  let weightTotal = 0;

  const countries = {};
  const ageGroups = {};
  const interests = {};

  performances.forEach((row) => {
    const reach = num(row.metrics?.reach) || 1;
    const audience = row.audience || {};

    female += num(audience.gender?.female) * reach;
    male += num(audience.gender?.male) * reach;
    other += num(audience.gender?.other) * reach;
    weightTotal += reach;

    (audience.countries || []).forEach((c) => {
      countries[c.country] = (countries[c.country] || 0) + num(c.percentage) * reach;
    });

    (audience.ageGroups || []).forEach((a) => {
      ageGroups[a.range] = (ageGroups[a.range] || 0) + num(a.percentage) * reach;
    });

    (audience.interests || []).forEach((interest) => {
      interests[interest] = (interests[interest] || 0) + 1;
    });
  });

  const topCountry =
    Object.entries(countries).sort((a, b) => b[1] - a[1])[0]?.[0] || "";

  const topAgeGroup =
    Object.entries(ageGroups).sort((a, b) => b[1] - a[1])[0]?.[0] || "";

  const topInterest =
    Object.entries(interests).sort((a, b) => b[1] - a[1])[0]?.[0] || "";

  return {
    femaleAudience: weightTotal ? Number((female / weightTotal).toFixed(1)) : 0,
    maleAudience: weightTotal ? Number((male / weightTotal).toFixed(1)) : 0,
    otherAudience: weightTotal ? Number((other / weightTotal).toFixed(1)) : 0,
    topCountry,
    topAgeGroup,
    topInterest,
  };
}

async function generateCampaignAI(input) {
  const prompt = `
You are an expert influencer marketing campaign analyst.

Return ONLY valid JSON with this shape:
{
  "aiSummary": "",
  "learnings": [],
  "risks": [],
  "finalVerdict": {
    "campaignScore": 0,
    "label": "",
    "summary": ""
  }
}

Analyze this campaign performance:
${JSON.stringify(input, null, 2)}
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
    response_format: { type: "json_object" },
  });

  return JSON.parse(completion.choices[0].message.content);
}