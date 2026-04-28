const instantlyService = require("../services/instantlyService");

exports.testInstantlyConnection = async (req, res) => {
  try {
    const result = await instantlyService.listAccounts();
    return res.status(200).json({
      success: true,
      message: "Instantly connected successfully",
      data: result,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error?.response?.data?.message || error.message || "Instantly connection failed",
      details: error?.response?.data || null,
    });
  }
};