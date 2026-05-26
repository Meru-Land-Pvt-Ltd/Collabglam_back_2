const axios = require("axios");
const saveErrorLog = require("../services/errorLog.service");

exports.initInstantlyGoogleOAuth = async (req, res) => {
  try {
    const response = await axios.post(
      "https://api.instantly.ai/api/v2/oauth/google/init",
      {},
      {
        headers: {
          Authorization: `Bearer ${process.env.INSTANTLY_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const data = response.data || {};

    return res.status(200).json({
      success: true,
      sessionId: data.session_id,
      authUrl: data.auth_url,
      expiresAt: data.expires_at,
      raw: data,
    });
  } catch (error) {
    await saveErrorLog(
      req,
      error,
      error?.response?.status || error?.statusCode || 500,
      "INIT_INSTANTLY_GOOGLE_OAUTH_ERROR"
    );

    return res.status(500).json({
      success: false,
      message: error?.response?.data?.message || error.message,
      details: error?.response?.data || null,
    });
  }
};

exports.getInstantlyOAuthStatus = async (req, res) => {
  try {
    const { sessionId } = req.params;

    const response = await axios.get(
      `https://api.instantly.ai/api/v2/oauth/session/status/${sessionId}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.INSTANTLY_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    return res.status(200).json({
      success: true,
      data: response.data,
    });
  } catch (error) {
    await saveErrorLog(
      req,
      error,
      error?.response?.status || error?.statusCode || 500,
      "GET_INSTANTLY_OAUTH_STATUS_ERROR"
    );

    return res.status(500).json({
      success: false,
      message: error?.response?.data?.message || error.message,
      details: error?.response?.data || null,
    });
  }
};