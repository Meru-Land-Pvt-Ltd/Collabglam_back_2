const axios = require("axios");

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
    return res.status(500).json({
      success: false,
      message: error?.response?.data?.message || error.message,
      details: error?.response?.data || null,
    });
  }
};