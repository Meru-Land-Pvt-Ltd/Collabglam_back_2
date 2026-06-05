const ErrorLog = require("../models/errorLog");

function normalizeBoolean(value) {
  if (typeof value === "boolean") return value;
  const text = String(value || "").trim().toLowerCase();
  if (["true", "1", "yes"].includes(text)) return true;
  if (["false", "0", "no"].includes(text)) return false;
  return null;
}

function normalizePriority(value) {
  const text = String(value || "").trim().toLowerCase();
  return ["high", "medium", "low"].includes(text) ? text : null;
}

function regexFilter(value) {
  return { $regex: String(value || "").trim(), $options: "i" };
}

function getPriorityWeightExpression(field = "$priority") {
  return {
    $switch: {
      branches: [
        { case: { $eq: [field, "high"] }, then: 3 },
        { case: { $eq: [field, "medium"] }, then: 2 },
        { case: { $eq: [field, "low"] }, then: 1 },
      ],
      default: 2,
    },
  };
}

function buildBaseFilter(query = {}) {
  const filter = {};

  if (query.statusCode) filter.statusCode = Number(query.statusCode);
  if (query.errorCode) filter.errorCode = query.errorCode;
  if (query.role) filter.role = query.role;
  if (query.adminId) filter.adminId = query.adminId;
  if (query.brandId) filter.brandId = query.brandId;
  if (query.influencerId) filter.influencerId = query.influencerId;
  if (query.actorEmail) filter.actorEmail = regexFilter(query.actorEmail);
  if (query.method) filter.method = String(query.method).toUpperCase();
  if (query.url) filter.url = regexFilter(query.url);

  const priority = normalizePriority(query.priority);
  if (priority) filter.priority = priority;

  const isResolved = normalizeBoolean(query.isResolved ?? query.resolved);
  if (isResolved !== null) filter.isResolved = isResolved;

  if (query.environment) filter.environment = query.environment;

  if (query.search) {
    const searchRegex = regexFilter(query.search);
    filter.$or = [
      { message: searchRegex },
      { name: searchRegex },
      { errorCode: searchRegex },
      { url: searchRegex },
      { actorEmail: searchRegex },
      { role: searchRegex },
      { brandId: searchRegex },
      { influencerId: searchRegex },
      { adminId: searchRegex },
    ];
  }

  return filter;
}

function groupValue(value) {
  if (value === undefined || value === null || value === "") return null;
  return value;
}

function buildGroupMatchFromLog(log = {}) {
  return {
    message: groupValue(log.message),
    name: groupValue(log.name),
    statusCode: groupValue(log.statusCode),
    errorCode: groupValue(log.errorCode),
    method: groupValue(log.method),
    role: groupValue(log.role),
    actorEmail: groupValue(log.actorEmail),
    adminId: groupValue(log.adminId),
    brandId: groupValue(log.brandId),
    influencerId: groupValue(log.influencerId),
  };
}

exports.getAllErrorLogs = async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const skip = (page - 1) * limit;

    const filter = buildBaseFilter(req.query || {});

    const groupedLogsPipeline = [
      { $match: filter },
      {
        $addFields: {
          normalizedPriority: { $ifNull: ["$priority", "medium"] },
          normalizedIsResolved: { $ifNull: ["$isResolved", false] },
        },
      },
      {
        $addFields: {
          priorityWeight: getPriorityWeightExpression("$normalizedPriority"),
        },
      },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: {
            message: "$message",
            name: "$name",
            statusCode: "$statusCode",
            errorCode: "$errorCode",
            method: "$method",
            role: "$role",
            actorEmail: "$actorEmail",
            adminId: "$adminId",
            brandId: "$brandId",
            influencerId: "$influencerId",
          },

          count: { $sum: 1 },
          occurrences: { $sum: 1 },
          unresolvedCount: { $sum: { $cond: [{ $eq: ["$normalizedIsResolved", false] }, 1, 0] } },
          resolvedCount: { $sum: { $cond: [{ $eq: ["$normalizedIsResolved", true] }, 1, 0] } },
          priorityWeight: { $max: "$priorityWeight" },

          firstSeen: { $min: "$createdAt" },
          lastSeen: { $max: "$createdAt" },

          latestLogId: { $first: "$_id" },
          latestStack: { $first: "$stack" },
          latestUrl: { $first: "$url" },
          latestIp: { $first: "$ip" },
          latestUserAgent: { $first: "$userAgent" },
          latestUserId: { $first: "$userId" },
          latestTokenAvailable: { $first: "$tokenAvailable" },
          latestRequestBody: { $first: "$requestBody" },
          latestRequestParams: { $first: "$requestParams" },
          latestRequestQuery: { $first: "$requestQuery" },
          latestEnvironment: { $first: "$environment" },
          latestCreatedAt: { $first: "$createdAt" },
          latestUpdatedAt: { $first: "$updatedAt" },
        },
      },
      {
        $addFields: {
          isResolved: { $eq: ["$unresolvedCount", 0] },
          priority: {
            $switch: {
              branches: [
                { case: { $eq: ["$priorityWeight", 3] }, then: "high" },
                { case: { $eq: ["$priorityWeight", 2] }, then: "medium" },
                { case: { $eq: ["$priorityWeight", 1] }, then: "low" },
              ],
              default: "medium",
            },
          },
        },
      },
      {
        $project: {
          _id: "$latestLogId",
          message: "$_id.message",
          name: "$_id.name",
          statusCode: "$_id.statusCode",
          errorCode: "$_id.errorCode",
          method: "$_id.method",
          role: "$_id.role",
          actorEmail: "$_id.actorEmail",
          adminId: "$_id.adminId",
          brandId: "$_id.brandId",
          influencerId: "$_id.influencerId",
          priority: 1,
          priorityWeight: 1,
          isResolved: 1,
          unresolvedCount: 1,
          resolvedCount: 1,
          count: 1,
          occurrences: 1,
          firstSeen: 1,
          lastSeen: 1,
          stack: "$latestStack",
          url: "$latestUrl",
          ip: "$latestIp",
          userAgent: "$latestUserAgent",
          userId: "$latestUserId",
          tokenAvailable: "$latestTokenAvailable",
          requestBody: "$latestRequestBody",
          requestParams: "$latestRequestParams",
          requestQuery: "$latestRequestQuery",
          environment: "$latestEnvironment",
          createdAt: "$latestCreatedAt",
          updatedAt: "$latestUpdatedAt",
        },
      },
      { $sort: { isResolved: 1, priorityWeight: -1, count: -1, lastSeen: -1 } },
      {
        $facet: {
          logs: [{ $skip: skip }, { $limit: limit }],
          total: [{ $count: "count" }],
        },
      },
    ];

    const result = await ErrorLog.aggregate(groupedLogsPipeline);
    const logs = result?.[0]?.logs || [];
    const totalGroups = result?.[0]?.total?.[0]?.count || 0;

    return res.status(200).json({
      success: true,
      totalLogs: totalGroups,
      totalGroups,
      currentPage: page,
      totalPages: Math.ceil(totalGroups / limit),
      logs,
    });
  } catch (error) {
    console.error("getAllErrorLogs error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

exports.updateErrorLogResolved = async (req, res) => {
  try {
    const { id } = req.params;
    const isResolved = normalizeBoolean(req.body?.isResolved ?? req.body?.resolved);

    if (isResolved === null) {
      return res.status(400).json({ success: false, message: "isResolved must be true or false" });
    }

    const latestLog = await ErrorLog.findById(id).lean();
    if (!latestLog) {
      return res.status(404).json({ success: false, message: "Error log not found" });
    }

    const groupMatch = buildGroupMatchFromLog(latestLog);
    const result = await ErrorLog.updateMany(groupMatch, { $set: { isResolved } });

    return res.status(200).json({
      success: true,
      message: isResolved ? "Error marked as resolved" : "Error reopened",
      isResolved,
      matchedCount: result.matchedCount || 0,
      modifiedCount: result.modifiedCount || 0,
    });
  } catch (error) {
    console.error("updateErrorLogResolved error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

exports.updateErrorLogPriority = async (req, res) => {
  try {
    const { id } = req.params;
    const priority = normalizePriority(req.body?.priority);

    if (!priority) {
      return res.status(400).json({ success: false, message: "priority must be high, medium, or low" });
    }

    const latestLog = await ErrorLog.findById(id).lean();
    if (!latestLog) {
      return res.status(404).json({ success: false, message: "Error log not found" });
    }

    const groupMatch = buildGroupMatchFromLog(latestLog);
    const result = await ErrorLog.updateMany(groupMatch, { $set: { priority } });

    return res.status(200).json({
      success: true,
      message: "Priority updated",
      priority,
      matchedCount: result.matchedCount || 0,
      modifiedCount: result.modifiedCount || 0,
    });
  } catch (error) {
    console.error("updateErrorLogPriority error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};