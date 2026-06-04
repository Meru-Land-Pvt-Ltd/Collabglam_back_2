const ErrorLog = require("../models/errorLog");

exports.getAllErrorLogs = async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const skip = (page - 1) * limit;

    const filter = {};

    if (req.query.statusCode) {
      filter.statusCode = Number(req.query.statusCode);
    }

    if (req.query.errorCode) {
      filter.errorCode = req.query.errorCode;
    }

    if (req.query.role) {
      filter.role = req.query.role;
    }

    if (req.query.adminId) {
      filter.adminId = req.query.adminId;
    }

    if (req.query.brandId) {
      filter.brandId = req.query.brandId;
    }

    if (req.query.influencerId) {
      filter.influencerId = req.query.influencerId;
    }

    if (req.query.actorEmail) {
      filter.actorEmail = { $regex: req.query.actorEmail, $options: "i" };
    }

    if (req.query.method) {
      filter.method = req.query.method.toUpperCase();
    }

    if (req.query.url) {
      filter.url = { $regex: req.query.url, $options: "i" };
    }

    if (req.query.search) {
      const searchRegex = { $regex: req.query.search, $options: "i" };

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

    const groupedLogsPipeline = [
      { $match: filter },

      // Latest error should become the first document inside each group
      { $sort: { createdAt: -1 } },

      {
        $group: {
          _id: {
            message: "$message",
            name: "$name",
            statusCode: "$statusCode",
            errorCode: "$errorCode",

            // Keep method in group so GET/POST same error stays separate
            method: "$method",

            // Keep actor fields so same error from different role/user is visible separately
            role: "$role",
            actorEmail: "$actorEmail",
            adminId: "$adminId",
            brandId: "$brandId",
            influencerId: "$influencerId",
          },

          count: { $sum: 1 },
          occurrences: { $sum: 1 },

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

 { $sort: { count: -1, lastSeen: -1 } },

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
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

exports.getSingleErrorLog = async (req, res) => {
  try {
    const log = await ErrorLog.findById(req.params.id);

    if (!log) {
      return res.status(404).json({
        success: false,
        message: "Error log not found",
      });
    }

    return res.status(200).json({
      success: true,
      log,
    });
  } catch (error) {
    console.error("getSingleErrorLog error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

exports.deleteErrorLog = async (req, res) => {
  try {
    const log = await ErrorLog.findByIdAndDelete(req.params.id);

    if (!log) {
      return res.status(404).json({
        success: false,
        message: "Error log not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Error log deleted successfully",
    });
  } catch (error) {
    console.error("deleteErrorLog error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

exports.clearAllErrorLogs = async (req, res) => {
  try {
    await ErrorLog.deleteMany({});

    return res.status(200).json({
      success: true,
      message: "All error logs cleared successfully",
    });
  } catch (error) {
    console.error("clearAllErrorLogs error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};