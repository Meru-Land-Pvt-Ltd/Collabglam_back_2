'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const YoutubeInsightReport = require('../models/youtubeInsightReport');
const YoutubeInsightPublicShare = require('../models/youtubeInsightPublicShare');
const { createInsightReport } = require('../services/youtubeInsight.service');
const {
  formatYoutubeInsightReport,
  getYoutubeLinkInsightSummary
} = require('../services/youtubeReportDashboard.service');
const saveErrorLog = require('../services/errorLog.service');

const ADMIN_ROLES_WITH_FULL_REPORT_ACCESS = new Set(['super_admin', 'revenue_head']);

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clean(value) {
  return String(value || '').trim();
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toObjectId(value) {
  const id = clean(value);
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null;
}

function getBrandIdFromRequest(req = {}) {
  return clean(
    req.brand?._id ||
    req.brand?.id ||
    req.brand?.brandId ||
    req.user?.brandId ||
    req.user?.brand?._id ||
    req.user?.brand?.id ||
    req.admin?.brandId ||
    req.body?.brandId ||
    req.query?.brandId
  );
}

function getBrandNameFromRequest(req = {}) {
  return clean(
    req.brand?.brandName ||
    req.brand?.name ||
    req.user?.brandName ||
    req.user?.brand?.brandName ||
    req.admin?.brandName ||
    req.body?.brandName ||
    req.query?.brandName
  );
}

function shouldPersistFromRequest(req = {}) {
  const body = req.body || {};
  const sourceContext = clean(body.sourceContext || req.query?.sourceContext).toLowerCase();
  if (body.saveReport === false || body.persist === false || sourceContext === 'public_insight_os') return false;
  return true;
}

function getRequestActor(req = {}) {
  const admin = req.admin || null;
  const user = req.user || null;
  const adminId = clean(admin?.adminId || admin?._id);
  const userId = clean(user?._id || user?.id);
  return {
    adminId: adminId || null,
    userId: userId || null,
    id: adminId || userId || null,
    role: clean(admin?.role || user?.role).toLowerCase(),
    email: clean(admin?.email || user?.email).toLowerCase(),
    name: clean(admin?.name || user?.name),
    isAdmin: Boolean(adminId)
  };
}

function getYoutubeLinkFromRequest(req = {}) {
  const body = req.body || {};
  const query = req.query || {};
  return clean(
    body.videoUrl ||
    body.youtubeVideoUrl ||
    body.youtubeUrl ||
    body.videoLink ||
    body.link ||
    body.url ||
    body.videoId ||
    query.videoUrl ||
    query.youtubeUrl ||
    query.link ||
    query.url ||
    query.videoId
  );
}

function canViewAllReports(req = {}) {
  const actor = getRequestActor(req);
  return actor.isAdmin && ADMIN_ROLES_WITH_FULL_REPORT_ACCESS.has(actor.role);
}

function buildAccessFilter(req = {}) {
  const actor = getRequestActor(req);
  const brandObjectId = toObjectId(getBrandIdFromRequest(req));
  if (brandObjectId) return { brandId: brandObjectId };
  if (canViewAllReports(req)) return {};
  if (actor.adminId && mongoose.Types.ObjectId.isValid(actor.adminId)) return { createdByAdminId: actor.adminId };
  if (actor.userId && mongoose.Types.ObjectId.isValid(actor.userId)) return { userId: actor.userId };
  return { _id: null };
}

function getListInput(req = {}) {
  return { ...(req.query || {}), ...(req.body || {}) };
}

function addOptionalFilters(filter, input = {}) {
  const brandObjectId = toObjectId(input.brandId);
  if (brandObjectId) filter.brandId = brandObjectId;
  if (input.sourceContext) filter.sourceContext = clean(input.sourceContext);
  if (input.videoId) filter.videoId = clean(input.videoId);
  if (input.channelId) filter['channelMetrics.channelId'] = clean(input.channelId);
  if (input.reportStatus) filter.reportStatus = clean(input.reportStatus);
  if (input.category) filter['creatorInsights.primaryCategory'] = new RegExp(escapeRegex(clean(input.category)), 'i');
  if (input.influencerName) filter['hero.influencerName'] = new RegExp(escapeRegex(clean(input.influencerName)), 'i');
  if (input.search) {
    const search = new RegExp(escapeRegex(clean(input.search)), 'i');
    filter.$or = [
      { 'hero.influencerName': search },
      { 'videoMetrics.title': search },
      { 'channelMetrics.title': search },
      { 'creatorInsights.primaryCategory': search }
    ];
  }
  const fromDate = input.fromDate || input.startDate;
  const toDate = input.toDate || input.endDate;
  if (fromDate || toDate) {
    filter.createdAt = {};
    if (fromDate) filter.createdAt.$gte = new Date(fromDate);
    if (toDate) filter.createdAt.$lte = new Date(toDate);
  }
  return filter;
}

function formatYoutubeInsightListItem(report = {}) {
  const dashboard = report.dashboard || {};
  const hero = dashboard.hero || report.hero || {};
  const profile = dashboard.profile || {};
  const video = report.videoMetrics || {};
  const channel = report.channelMetrics || {};
  const finalVerdict = dashboard.finalVerdict || report.finalVerdict || {};
  const revenue = dashboard.estimatedRevenue || {};
  const watch = dashboard.estimatedWatchTime || {};
  const creator = dashboard.creatorFit || dashboard.influencerCategory || report.creatorInsights || {};

  return {
    reportId: String(report._id || report.reportId || ''),
    reportType: report.reportType || 'YouTube Link Intelligence Report',
    platform: 'YouTube',
    reportStatus: report.reportStatus || 'Published',
    generatedAt: report.createdAt || report.generatedAt || null,
    influencerName: profile.name || hero.influencerName || channel.title || '',
    influencerCategory: creator.primaryCategory || video.categoryName || '',
    videoTitle: dashboard.videoOverview?.title || hero.videoTitle || video.title || '',
    thumbnailUrl: dashboard.videoOverview?.thumbnailUrl || hero.thumbnailUrl || video.thumbnailUrl || '',
    channelLogo: profile.avatarUrl || hero.channelThumbnailUrl || channel.thumbnailUrl || '',
    videoUrl: dashboard.videoOverview?.videoUrl || hero.livePublishedLink || report.videoUrl || '',
    channelUrl: profile.channelUrl || hero.channelUrl || channel.channelUrl || '',
    subscribersDisplay: profile.subscriberCountDisplay || channel.subscriberCountDisplay || '',
    channelTotalViewsDisplay: profile.totalViewCountDisplay || channel.totalViewCountDisplay || '',
    channelTotalVideosDisplay: profile.videoCountDisplay || channel.videoCountDisplay || '',
    views: video.viewCount || 0,
    likes: video.likeCount || 0,
    comments: video.commentCount || 0,
    engagementRate: video.engagementRate || 0,
    durationDisplay: video.durationDisplay || dashboard.videoOverview?.durationDisplay || '',
    estimatedCtrDisplay: report.performanceEstimates?.estimatedCtr?.displayValue || '',
    estimatedConversionRateDisplay: report.performanceEstimates?.estimatedConversionRate?.displayValue || '',
    estimatedWatchTimeHoursDisplay: watch.totalWatchTimeHours?.displayValue || '',
    estimatedRevenueRangeDisplay: revenue.estimatedRevenueRangeDisplay || '',
    finalAiScore: finalVerdict.finalScore || report.aiScores?.finalAiScore || 0,
    verdict: finalVerdict.verdict || ''
  };
}


function getPublicWebBaseUrl(req = {}, body = {}) {
  const direct = clean(body.publicBaseUrl || body.origin || body.siteUrl || body.webBaseUrl);
  const envUrl = clean(process.env.PUBLIC_WEB_URL || process.env.NEXT_PUBLIC_APP_URL || process.env.FRONTEND_URL || process.env.CLIENT_URL);
  const host = clean(req.headers?.origin) || clean(req.headers?.referer).replace(/\/[^/]*$/, '');
  return (direct || envUrl || host || 'https://collabglam.com').replace(/\/+$/, '');
}

function makePublicReportUrl(token, req = {}, body = {}) {
  const base = getPublicWebBaseUrl(req, body);
  return `${base}/insight-os/report?share=${encodeURIComponent(token)}`;
}

function getSnapshotFromRequest(body = {}) {
  if (isObject(body.frontendReport)) return body.frontendReport;
  if (isObject(body.dashboard)) return body.dashboard;
  if (isObject(body.report)) return body.report;
  if (isObject(body.data)) return body.data;
  return null;
}

function getSnapshotTitle(snapshot = {}) {
  if (!isObject(snapshot)) return '';
  return clean(
    snapshot.videoOverview?.title ||
    snapshot.hero?.videoTitle ||
    snapshot.videoTitle ||
    snapshot.title ||
    snapshot.profile?.name ||
    snapshot.hero?.influencerName
  );
}

function getSnapshotCreatorName(snapshot = {}) {
  if (!isObject(snapshot)) return '';
  return clean(
    snapshot.profile?.name ||
    snapshot.hero?.influencerName ||
    snapshot.influencerName ||
    snapshot.channelOverview?.name ||
    snapshot.creatorName
  );
}

function getSnapshotVideoUrl(snapshot = {}) {
  if (!isObject(snapshot)) return '';
  return clean(
    snapshot.videoOverview?.videoUrl ||
    snapshot.hero?.livePublishedLink ||
    snapshot.videoUrl ||
    snapshot.url
  );
}

function getRequestActorIds(req = {}) {
  const actor = getRequestActor(req);
  return {
    actor,
    createdByAdminId: actor.adminId && mongoose.Types.ObjectId.isValid(actor.adminId) ? actor.adminId : null,
    createdByUserId: actor.userId && mongoose.Types.ObjectId.isValid(actor.userId) ? actor.userId : null,
    createdByEmail: actor.email || ''
  };
}

function makeShareToken() {
  return crypto.randomBytes(24).toString('base64url');
}

async function createYoutubeInsightPublicLink(req, res, next) {
  try {
    const body = req.body || {};
    const reportId = clean(body.reportId || body.id || body._id);
    const snapshot = getSnapshotFromRequest(body);
    const sourceContext = clean(body.sourceContext || body.context).toLowerCase() || 'unknown';
    const { actor, createdByAdminId, createdByUserId, createdByEmail } = getRequestActorIds(req);

    let report = null;

    if (reportId) {
      if (!mongoose.Types.ObjectId.isValid(reportId)) {
        return res.status(400).json({ success: false, message: 'Invalid YouTube insight report id.' });
      }

      // Authenticated brand/admin users may share a saved report. Public users can
      // still share the report snapshot without requiring DB report access.
      const accessFilter = actor.id ? buildAccessFilter(req) : null;
      if (accessFilter) {
        report = await YoutubeInsightReport.findOne({ ...accessFilter, _id: reportId }).lean();
        if (!report && !snapshot) {
          return res.status(404).json({ success: false, message: 'YouTube insight report not found.' });
        }
      }
    }

    if (!report && !snapshot) {
      return res.status(400).json({
        success: false,
        message: 'reportId or frontendReport/dashboard snapshot is required to create a public link.'
      });
    }

    const token = makeShareToken();
    const reportObjectId = report?._id || (reportId && mongoose.Types.ObjectId.isValid(reportId) && actor.id ? reportId : null);
    const brandObjectId = report?.brandId || toObjectId(body.brandId) || toObjectId(getBrandIdFromRequest(req));
    const frontendSnapshot = snapshot || null;

    const share = await YoutubeInsightPublicShare.create({
      token,
      reportId: reportObjectId,
      brandId: brandObjectId,
      brandName: clean(report?.brandName || body.brandName || getBrandNameFromRequest(req)),
      sourceContext: ['public_insight_os', 'brand_insight_os'].includes(sourceContext) ? sourceContext : (report?.sourceContext || 'unknown'),
      title: clean(report?.videoMetrics?.title || report?.hero?.videoTitle || getSnapshotTitle(frontendSnapshot)),
      creatorName: clean(report?.hero?.influencerName || report?.channelMetrics?.title || getSnapshotCreatorName(frontendSnapshot)),
      videoUrl: clean(report?.videoUrl || report?.hero?.livePublishedLink || getSnapshotVideoUrl(frontendSnapshot)),
      snapshot: frontendSnapshot,
      createdByAdminId,
      createdByUserId,
      createdByEmail
    });

    const publicUrl = makePublicReportUrl(share.token, req, body);

    return res.status(201).json({
      success: true,
      message: 'Public Insight OS report link created successfully.',
      data: {
        token: share.token,
        shareToken: share.token,
        publicUrl,
        url: publicUrl,
        reportId: share.reportId ? String(share.reportId) : ''
      }
    });
  } catch (error) {
    await saveErrorLog(
      req,
      error,
      error?.response?.status || error?.statusCode || error?.status || 500,
      "CREATE_YOUTUBE_INSIGHT_PUBLIC_LINK_ERROR"
    );

    return next(error);
  }
}

async function getYoutubeInsightPublicShare(req, res, next) {
  try {
    const token = clean(req.params.token || req.query.share || req.query.token);
    if (!token) return res.status(400).json({ success: false, message: 'Public report token is required.' });

    const share = await YoutubeInsightPublicShare.findOne({ token, isActive: true }).lean();
    if (!share) return res.status(404).json({ success: false, message: 'Public Insight OS report link not found.' });

    if (share.expiresAt && new Date(share.expiresAt).getTime() < Date.now()) {
      return res.status(410).json({ success: false, message: 'This public Insight OS report link has expired.' });
    }

    await YoutubeInsightPublicShare.updateOne(
      { _id: share._id },
      { $inc: { accessCount: 1 }, $set: { lastAccessedAt: new Date() } }
    ).catch(() => null);

    if (share.reportId) {
      const report = await YoutubeInsightReport.findById(share.reportId).lean();
      if (report) {
        const formattedReport = formatYoutubeInsightReport(report, {
          includeRawData: false,
          includeRawReport: false,
          includeDebug: false
        });

        return res.status(200).json({
          success: true,
          data: formattedReport,
          reportId: formattedReport.reportId,
          frontendReport: formattedReport.frontendReport,
          dashboard: formattedReport.dashboard,
          aiSummary: formattedReport.aiSummary,
          aiInsights: formattedReport.aiInsights,
          finalVerdict: formattedReport.finalVerdict,
          publicShare: {
            token: share.token,
            title: share.title,
            creatorName: share.creatorName,
            createdAt: share.createdAt
          }
        });
      }
    }

    if (!share.snapshot) {
      return res.status(404).json({ success: false, message: 'Public report snapshot is not available.' });
    }

    return res.status(200).json({
      success: true,
      data: {
        reportId: share.reportId ? String(share.reportId) : '',
        frontendReport: share.snapshot,
        dashboard: share.snapshot,
        publicShare: {
          token: share.token,
          title: share.title,
          creatorName: share.creatorName,
          createdAt: share.createdAt
        }
      },
      reportId: share.reportId ? String(share.reportId) : '',
      frontendReport: share.snapshot,
      dashboard: share.snapshot,
      publicShare: {
        token: share.token,
        title: share.title,
        creatorName: share.creatorName,
        createdAt: share.createdAt
      }
    });
  } catch (error) {
    await saveErrorLog(
      req,
      error,
      error?.response?.status || error?.statusCode || error?.status || 500,
      "GET_YOUTUBE_INSIGHT_PUBLIC_SHARE_ERROR"
    );

    return next(error);
  }
}


async function analyzeYoutubeVideo(req, res, next) {
  try {
    const actor = getRequestActor(req);
    const videoUrl = getYoutubeLinkFromRequest(req);
    const body = req.body || {};
    const persistReport = shouldPersistFromRequest(req);
    const brandId = getBrandIdFromRequest(req);
    const brandName = getBrandNameFromRequest(req);

    if (persistReport && !brandId) {
      return res.status(400).json({ success: false, message: 'brandId is required for brand Insight OS saved reports.' });
    }

    const report = await createInsightReport({
      actor,
      payload: {
        videoUrl,
        saveReport: persistReport,
        sourceContext: persistReport ? 'brand_insight_os' : 'public_insight_os',
        brandId,
        brandName,
        maxComments: body.maxComments,
        creatorAverageLimit: body.creatorAverageLimit,
        includeReplies: body.includeReplies,
        includeRepliesInAnalysis: body.includeRepliesInAnalysis,
        maxRepliesPerThread: body.maxRepliesPerThread,
        commentOrder: body.commentOrder,
        rpmLow: body.rpmLow,
        rpmHigh: body.rpmHigh
      }
    });

    const formattedReport = formatYoutubeInsightReport(report, {
      includeRawData: req.query.includeRaw === 'true',
      includeRawReport: req.query.includeRaw === 'true',
      includeDebug: req.query.debug === 'true'
    });

    return res.status(201).json({
      success: true,
      message: 'YouTube link insight generated successfully.',
      saved: persistReport,
      data: formattedReport,
      reportId: formattedReport.reportId,
      frontendReport: formattedReport.frontendReport,
      dashboard: formattedReport.dashboard,
      aiSummary: formattedReport.aiSummary,
      aiInsights: formattedReport.aiInsights,
      finalVerdict: formattedReport.finalVerdict
    });
  } catch (error) {
    await saveErrorLog(
      req,
      error,
      error?.response?.status || error?.statusCode || error?.status || 500,
      "ANALYZE_YOUTUBE_VIDEO_ERROR"
    );

    return next(error);
  }
}

async function getYoutubeInsightReports(req, res, next) {
  try {
    const input = getListInput(req);
    const page = Math.max(Number(input.page || 1), 1);
    const limit = Math.min(Math.max(Number(input.limit || 20), 1), 100);
    const skip = (page - 1) * limit;
    const sortBy = clean(input.sortBy) || 'createdAt';
    const sortOrder = clean(input.sortOrder).toLowerCase() === 'asc' ? 1 : -1;
    const allowedSorts = new Set(['createdAt', 'updatedAt', 'videoId', 'hero.influencerName', 'videoMetrics.title', 'videoMetrics.viewCount', 'videoMetrics.likeCount', 'videoMetrics.commentCount', 'videoMetrics.engagementRate', 'channelMetrics.subscriberCount', 'channelMetrics.totalViewCount', 'aiScores.finalAiScore', 'creatorInsights.primaryCategory']);
    const filter = addOptionalFilters(buildAccessFilter(req), input);
    const sort = { [allowedSorts.has(sortBy) ? sortBy : 'createdAt']: sortOrder };
    const [items, total] = await Promise.all([
      YoutubeInsightReport.find(filter).sort(sort).skip(skip).limit(limit).lean(),
      YoutubeInsightReport.countDocuments(filter)
    ]);
    return res.status(200).json({ success: true, data: items.map(formatYoutubeInsightListItem), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (error) {
    await saveErrorLog(
      req,
      error,
      error?.response?.status || error?.statusCode || error?.status || 500,
      "GET_YOUTUBE_INSIGHT_REPORTS_ERROR"
    );

    return next(error);
  }
}

async function getYoutubeInsightReportById(req, res, next) {
  try {
    const reportId = clean(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(reportId)) return res.status(400).json({ success: false, message: 'Invalid YouTube insight report id.' });
    const report = await YoutubeInsightReport.findOne({ ...buildAccessFilter(req), _id: reportId }).lean();
    if (!report) return res.status(404).json({ success: false, message: 'YouTube insight report not found.' });
    const formattedReport = formatYoutubeInsightReport(report, {
      includeRawData: req.query.includeRaw === 'true',
      includeRawReport: req.query.includeRaw === 'true',
      includeDebug: req.query.debug === 'true'
    });

    return res.status(200).json({
      success: true,
      data: formattedReport,
      reportId: formattedReport.reportId,
      frontendReport: formattedReport.frontendReport,
      dashboard: formattedReport.dashboard,
      aiSummary: formattedReport.aiSummary,
      aiInsights: formattedReport.aiInsights,
      finalVerdict: formattedReport.finalVerdict
    });
  } catch (error) {
    await saveErrorLog(
      req,
      error,
      error?.response?.status || error?.statusCode || error?.status || 500,
      "GET_YOUTUBE_INSIGHT_REPORT_BY_ID_ERROR"
    );

    return next(error);
  }
}

async function refreshYoutubeInsightReportById(req, res, next) {
  try {
    const reportId = clean(req.params.id);

    if (!mongoose.Types.ObjectId.isValid(reportId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid YouTube insight report id.'
      });
    }

    const existingReport = await YoutubeInsightReport.findOne({
      ...buildAccessFilter(req),
      _id: reportId
    }).lean();

    if (!existingReport) {
      return res.status(404).json({
        success: false,
        message: 'YouTube insight report not found.'
      });
    }

    const videoUrl = clean(
      existingReport.videoUrl ||
      existingReport.hero?.livePublishedLink ||
      existingReport.videoMetrics?.videoUrl ||
      existingReport.dashboard?.videoOverview?.videoUrl
    );

    if (!videoUrl) {
      return res.status(400).json({
        success: false,
        message: 'Video URL is missing for this report.'
      });
    }

    const actor = getRequestActor(req);

    const refreshedReport = await createInsightReport({
      actor,
      payload: {
        videoUrl,
        saveReport: false,
        sourceContext: existingReport.sourceContext || 'brand_insight_os',
        brandId: existingReport.brandId ? String(existingReport.brandId) : getBrandIdFromRequest(req),
        brandName: existingReport.brandName || getBrandNameFromRequest(req),

        maxComments: req.body?.maxComments,
        creatorAverageLimit: req.body?.creatorAverageLimit,
        includeReplies: req.body?.includeReplies,
        includeRepliesInAnalysis: req.body?.includeRepliesInAnalysis,
        maxRepliesPerThread: req.body?.maxRepliesPerThread,
        commentOrder: req.body?.commentOrder,
        rpmLow: req.body?.rpmLow,
        rpmHigh: req.body?.rpmHigh
      }
    });

    const updateData = refreshedReport.toObject
      ? refreshedReport.toObject()
      : { ...refreshedReport };

    delete updateData._id;
    delete updateData.id;
    delete updateData.reportId;
    delete updateData.createdAt;
    delete updateData.updatedAt;
    delete updateData.brandId;
    delete updateData.brandName;
    delete updateData.createdByAdminId;
    delete updateData.createdByUserId;
    delete updateData.createdByEmail;
    delete updateData.userId;

    updateData.lastRefreshedAt = new Date();

    const updatedReport = await YoutubeInsightReport.findOneAndUpdate(
      {
        ...buildAccessFilter(req),
        _id: reportId
      },
      {
        $set: updateData
      },
      {
        new: true
      }
    ).lean();

    if (!updatedReport) {
      return res.status(404).json({
        success: false,
        message: 'YouTube insight report not found after refresh.'
      });
    }

    const formattedReport = formatYoutubeInsightReport(updatedReport, {
      includeRawData: req.query.includeRaw === 'true',
      includeRawReport: req.query.includeRaw === 'true',
      includeDebug: req.query.debug === 'true'
    });

    return res.status(200).json({
      success: true,
      message: 'YouTube insight report refreshed successfully.',
      data: formattedReport,
      reportId: formattedReport.reportId,
      frontendReport: formattedReport.frontendReport,
      dashboard: formattedReport.dashboard,
      aiSummary: formattedReport.aiSummary,
      aiInsights: formattedReport.aiInsights,
      finalVerdict: formattedReport.finalVerdict
    });
  } catch (error) {
    return next(error);
  }
}

async function getYoutubeInsightSummary(req, res, next) {
  try {
    const input = getListInput(req);
    const filter = addOptionalFilters(buildAccessFilter(req), input);
    const summary = await getYoutubeLinkInsightSummary({ filter, limit: input.limit || 500 });
    return res.status(200).json({ success: true, data: summary });
  } catch (error) {
    await saveErrorLog(
      req,
      error,
      error?.response?.status || error?.statusCode || error?.status || 500,
      "GET_YOUTUBE_INSIGHT_SUMMARY_ERROR"
    );

    return next(error);
  }
}

async function deleteYoutubeInsightReport(req, res, next) {
  try {
    const reportId = clean(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(reportId)) return res.status(400).json({ success: false, message: 'Invalid YouTube insight report id.' });
    const report = await YoutubeInsightReport.findOneAndDelete({ ...buildAccessFilter(req), _id: reportId });
    if (!report) return res.status(404).json({ success: false, message: 'YouTube insight report not found.' });
    return res.status(200).json({ success: true, message: 'YouTube insight report deleted successfully.' });
  } catch (error) {
    await saveErrorLog(
      req,
      error,
      error?.response?.status || error?.statusCode || error?.status || 500,
      "DELETE_YOUTUBE_INSIGHT_REPORT_ERROR"
    );

    return next(error);
  }
}

module.exports = {
  analyzeYoutubeVideo,
  getYoutubeInsightReports,
  getYoutubeInsightReportById,
  refreshYoutubeInsightReportById,
  getYoutubeInsightSummary,
  deleteYoutubeInsightReport,
  createYoutubeInsightPublicLink,
  getYoutubeInsightPublicShare
};