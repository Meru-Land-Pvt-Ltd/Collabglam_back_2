const instantlyService = require("../services/instantlyService");
const saveErrorLog = require("../services/errorLog.service");

function getErrorPayload(error) {
  return {
    message:
      error?.response?.data?.message ||
      error?.response?.data?.error ||
      error?.message ||
      "Instantly request failed",
    details: error?.response?.data || null,
    statusCode: error?.response?.status || 500,
  };
}

exports.testInstantlyConnection = async (req, res) => {
  try {
    const data = await instantlyService.listAccounts();
    return res.status(200).json({
      success: true,
      message: "Instantly connected successfully",
      data,
    });
  } catch (error) {
    const payload = getErrorPayload(error);
    await saveErrorLog(req, error, payload.statusCode, "TEST_INSTANTLY_CONNECTION_ERROR");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

exports.listInstantlyAccounts = async (req, res) => {
  try {
    const data = await instantlyService.listAccounts(req.query || {});
    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    const payload = getErrorPayload(error);
    await saveErrorLog(req, error, payload.statusCode, "LIST_INSTANTLY_ACCOUNTS_ERROR");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

exports.getInstantlyAccount = async (req, res) => {
  try {
    const email = decodeURIComponent(String(req.params.email || "").trim());
    const data = await instantlyService.getAccount(email);

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    const payload = getErrorPayload(error);
    await saveErrorLog(req, error, payload.statusCode, "GET_INSTANTLY_ACCOUNT_ERROR");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

exports.pauseInstantlyAccount = async (req, res) => {
  try {
    const email = decodeURIComponent(String(req.params.email || "").trim());
    const data = await instantlyService.pauseAccount(email);

    return res.status(200).json({
      success: true,
      message: "Account paused successfully",
      data,
    });
  } catch (error) {
    const payload = getErrorPayload(error);
    await saveErrorLog(req, error, payload.statusCode, "PAUSE_INSTANTLY_ACCOUNT_ERROR");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

exports.resumeInstantlyAccount = async (req, res) => {
  try {
    const email = decodeURIComponent(String(req.params.email || "").trim());
    const data = await instantlyService.resumeAccount(email);

    return res.status(200).json({
      success: true,
      message: "Account resumed successfully",
      data,
    });
  } catch (error) {
    const payload = getErrorPayload(error);
    await saveErrorLog(req, error, payload.statusCode, "RESUME_INSTANTLY_ACCOUNT_ERROR");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

exports.enableInstantlyWarmup = async (req, res) => {
  try {
    const email = decodeURIComponent(String(req.params.email || "").trim());
    const data = await instantlyService.enableWarmup({
      emails: [email],
    });

    return res.status(200).json({
      success: true,
      message: "Warmup enable job started",
      data,
    });
  } catch (error) {
    const payload = getErrorPayload(error);
    await saveErrorLog(req, error, payload.statusCode, "ENABLE_INSTANTLY_WARMUP_ERROR");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

exports.disableInstantlyWarmup = async (req, res) => {
  try {
    const email = decodeURIComponent(String(req.params.email || "").trim());
    const data = await instantlyService.disableWarmup({
      emails: [email],
    });

    return res.status(200).json({
      success: true,
      message: "Warmup disable job started",
      data,
    });
  } catch (error) {
    const payload = getErrorPayload(error);
    await saveErrorLog(req, error, payload.statusCode, "DISABLE_INSTANTLY_WARMUP_ERROR");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

exports.initInstantlyOAuth = async (req, res) => {
  try {
    const provider = String(req.params.provider || "").trim().toLowerCase();

    if (!["google", "microsoft"].includes(provider)) {
      return res.status(400).json({
        success: false,
        message: "provider must be google or microsoft",
      });
    }

    const data =
      provider === "google"
        ? await instantlyService.initGoogleOAuth()
        : await instantlyService.initMicrosoftOAuth();

    return res.status(200).json({
      success: true,
      provider,
      sessionId: data?.session_id || "",
      authUrl: data?.auth_url || "",
      expiresAt: data?.expires_at || "",
      data,
    });
  } catch (error) {
    const payload = getErrorPayload(error);
    await saveErrorLog(req, error, payload.statusCode, "INIT_INSTANTLY_OAUTH_ERROR");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};

exports.getInstantlyOAuthSessionStatus = async (req, res) => {
  try {
    const sessionId = String(req.params.sessionId || "").trim();
    const data = await instantlyService.getOAuthSessionStatus(sessionId);

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    const payload = getErrorPayload(error);
    await saveErrorLog(req, error, payload.statusCode, "GET_INSTANTLY_OAUTH_SESSION_STATUS_ERROR");
    return res.status(payload.statusCode).json({
      success: false,
      ...payload,
    });
  }
};