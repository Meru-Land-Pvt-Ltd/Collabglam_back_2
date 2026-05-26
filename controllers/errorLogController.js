const ErrorLog = require("../models/errorLog");

exports.getAllErrorLogs = async (req, res) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
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

    if (req.query.method) {
      filter.method = req.query.method.toUpperCase();
    }

    if (req.query.url) {
      filter.url = { $regex: req.query.url, $options: "i" };
    }

    const logs = await ErrorLog.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const totalLogs = await ErrorLog.countDocuments(filter);

    return res.status(200).json({
      success: true,
      totalLogs,
      currentPage: page,
      totalPages: Math.ceil(totalLogs / limit),
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