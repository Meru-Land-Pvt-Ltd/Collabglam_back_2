const jwt = require("jsonwebtoken");
const ErrorLog = require("../models/errorLog");

const sanitizeData = (data = {}) => {
  const clonedData = { ...data };

  const sensitiveFields = [
    "password",
    "confirmPassword",
    "oldPassword",
    "newPassword",
    "token",
    "accessToken",
    "refreshToken",
    "otp",
    "pin",
  ];

  sensitiveFields.forEach((field) => {
    if (clonedData[field]) {
      clonedData[field] = "***hidden***";
    }
  });

  return clonedData;
};

const getBearerToken = (req) => {
  const authHeader = req.headers?.authorization || "";

  if (!authHeader) return null;

  const parts = authHeader.split(" ");

  if (parts.length === 2 && parts[0] === "Bearer") {
    return parts[1];
  }

  return null;
};

const getTokenPayload = (req) => {
  const token = getBearerToken(req);

  if (!token) {
    return {
      tokenAvailable: false,
      payload: null,
    };
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    return {
      tokenAvailable: true,
      payload,
    };
  } catch (error) {
    return {
      tokenAvailable: true,
      payload: null,
    };
  }
};

const getActorDetails = (req) => {
  const { tokenAvailable, payload } = getTokenPayload(req);

  const actor = req.admin || req.user || payload || {};

  const role = String(
    actor.role ||
      actor.userRole ||
      actor.userType ||
      actor.type ||
      ""
  )
    .trim()
    .toLowerCase();

  const adminId =
    actor.adminId ||
    actor.admin_id ||
    actor.admin ||
    null;

  const brandId =
    actor.brandId ||
    actor.brand_id ||
    actor.brand ||
    null;

  const influencerId =
    actor.influencerId ||
    actor.influencer_id ||
    actor.influencer ||
    null;

  const userId =
    actor.userId ||
    actor._id ||
    actor.id ||
    adminId ||
    brandId ||
    influencerId ||
    null;

  return {
    tokenAvailable,
    role: role || null,
    adminId: adminId ? String(adminId) : null,
    brandId: brandId ? String(brandId) : null,
    influencerId: influencerId ? String(influencerId) : null,
    userId: userId ? String(userId) : null,
    actorEmail: actor.email ? String(actor.email).toLowerCase() : null,
  };
};

const saveErrorLog = async (req, error, statusCode = 500, errorCode = null) => {
  try {
    const actorDetails = getActorDetails(req);

    await ErrorLog.create({
      message: error.message || "Internal Server Error",
      name: error.name || "Error",
      statusCode,
      errorCode,
      stack: error.stack,

      method: req.method,
      url: req.originalUrl,

      ip: req.ip,
      userAgent: req.get("user-agent"),

      role: actorDetails.role,
      adminId: actorDetails.adminId,
      brandId: actorDetails.brandId,
      influencerId: actorDetails.influencerId,
      userId: actorDetails.userId,
      actorEmail: actorDetails.actorEmail,
      tokenAvailable: actorDetails.tokenAvailable,

      requestBody: sanitizeData(req.body),
      requestParams: req.params || {},
      requestQuery: req.query || {},

      environment: process.env.NODE_ENV || "development",
    });
  } catch (logError) {
    console.error("Error log save failed:", logError.message);
  }
};

module.exports = saveErrorLog;