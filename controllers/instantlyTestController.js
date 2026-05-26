const instantlyService = require("../services/instantlyService");
const saveErrorLog = require("../services/errorLog.service");

exports.testInstantlyConnection = async (req, res) => {
  try {
    const result = await instantlyService.listAccounts();
    return res.status(200).json({
      success: true,
      message: "Instantly connected successfully",
      data: result,
    });
  } catch (error) {
    await saveErrorLog(
      req,
      error,
      error?.response?.status || error?.statusCode || 500,
      "TEST_INSTANTLY_CONNECTION_ERROR"
    );

    return res.status(500).json({
      success: false,
      message: error?.response?.data?.message || error.message || "Instantly connection failed",
      details: error?.response?.data || null,
    });
  }
};