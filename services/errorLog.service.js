const jwt = require("jsonwebtoken");
const ErrorLog = require("../models/errorLog");

const HIGH_PRIORITY_ROUTES = [
  { method: "POST", path: "/send-otp-signup" },
  { method: "POST", path: "/verify-otp-signup" },
  { method: "POST", path: "/save-brand-onboarding" },
  { method: "POST", path: "/signin" },
  { method: "POST", path: "/google-auth" },
  { method: "POST", path: "/send-otp-forgot" },
  { method: "POST", path: "/verify-otp-forgot" },
  { method: "POST", path: "/update-password" },
  { method: "POST", path: "/request-otp" },
  { method: "POST", path: "/verify-otp" },
  { method: "POST", path: "/create" },
  { method: "POST", path: "/create-ai" },
  { method: "PUT", path: "/update-manual" },
  { method: "GET", path: "/users" },
  { method: "POST", path: "/search" },
  { method: "POST", path: "/search-unified" },
  { method: "GET", path: "/report-preview" },
  { method: "GET", path: "/report" },
  { method: "POST", path: "/resolve-profile" },
  { method: "POST", path: "/search-legacy" },
  { method: "GET", path: "/saved" },
  { method: "GET", path: "/random" },
  { method: "POST", path: "/export-csv" },
  { method: "GET", path: "/media-kit-link" },
  { method: "POST", path: "/creator" },
  { method: "GET", path: "/creator/:userId" },
  { method: "GET", path: "/locations" },
  { method: "POST", path: "/campaign-recommendation-source" },
  { method: "POST", path: "/recommended-by-campaign" },
  { method: "POST", path: "/rate-card/suggested" },
];

function pickValue(...values) {
  for (const value of values) {
    const clean = String(value || "").trim();
    if (clean) return clean;
  }
  return null;
}

function normalizePath(path = "") {
  const cleanPath = String(path || "").split("?")[0].trim();
  if (!cleanPath) return "/";
  return cleanPath.replace(/\/+$/, "") || "/";
}

function routePathToRegex(routePath) {
  const escaped = String(routePath || "")
    .replace(/\/+$/, "")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\\:([A-Za-z0-9_]+)/g, "[^/]+");

  return new RegExp(`${escaped}$`, "i");
}

function isHighPriorityRoute(req = {}) {
  const method = String(req.method || "").toUpperCase();
  const urlPath = normalizePath(req.originalUrl || req.url || "");

  return HIGH_PRIORITY_ROUTES.some((route) => {
    if (route.method && route.method !== method) return false;
    return routePathToRegex(route.path).test(urlPath);
  });
}

function getPriorityFromRequest(req = {}, statusCode = 500, error = null) {
  const explicitPriority = String(
    error?.priority ||
      error?.errorPriority ||
      req.body?.priority ||
      req.query?.priority ||
      ""
  ).trim().toLowerCase();

  if (["high", "medium", "low"].includes(explicitPriority)) return explicitPriority;
  if (isHighPriorityRoute(req)) return "high";

  const code = Number(statusCode || error?.statusCode || error?.status || error?.response?.status || 500);
  if (code >= 500) return "high";
  if ([401, 403, 429].includes(code)) return "medium";
  if (code >= 400) return "low";
  return "medium";
}

function getBearerToken(req = {}) {
  const authHeader = req.headers?.authorization || req.headers?.Authorization || "";
  if (!authHeader || typeof authHeader !== "string") return null;
  if (!authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice(7).trim() || null;
}

function decodeTokenSafely(token) {
  try {
    if (!token) return null;
    const decoded = jwt.decode(token);
    if (!decoded || typeof decoded !== "object") return null;
    return decoded;
  } catch {
    return null;
  }
}

function sanitizeObject(value) {
  if (!value || typeof value !== "object") return value || {};

  const hiddenKeys = new Set([
    "password",
    "confirmpassword",
    "newpassword",
    "oldpassword",
    "token",
    "accesstoken",
    "refreshtoken",
    "authorization",
    "otp",
    "otpcode",
    "resettoken",
  ]);

  if (Array.isArray(value)) return value.map((item) => sanitizeObject(item));

  const output = {};
  for (const [key, val] of Object.entries(value)) {
    if (hiddenKeys.has(String(key).toLowerCase())) {
      output[key] = "***HIDDEN***";
      continue;
    }
    output[key] = val && typeof val === "object" ? sanitizeObject(val) : val;
  }
  return output;
}

function getRoleFromDecoded(decoded = {}) {
  return pickValue(decoded.role, decoded.userRole, decoded.type, decoded.accountType);
}

function getAdminIdFromDecoded(decoded = {}) {
  const role = String(getRoleFromDecoded(decoded) || "").toLowerCase();
  return pickValue(
    decoded.adminId,
    decoded.admin?._id,
    decoded.admin?.id,
    decoded.admin?.adminId,
    role === "admin" ? decoded._id : null,
    role === "admin" ? decoded.id : null,
    role === "super_admin" ? decoded._id : null,
    role === "super_admin" ? decoded.id : null,
    role === "revenue_head" ? decoded._id : null,
    role === "revenue_head" ? decoded.id : null,
    role === "rh" ? decoded._id : null,
    role === "rh" ? decoded.id : null,
    role === "bme" ? decoded._id : null,
    role === "bme" ? decoded.id : null,
    role === "ime" ? decoded._id : null,
    role === "ime" ? decoded.id : null
  );
}

function getBrandIdFromDecoded(decoded = {}) {
  const role = String(getRoleFromDecoded(decoded) || "").toLowerCase();
  return pickValue(
    decoded.brandId,
    decoded.brand?._id,
    decoded.brand?.id,
    decoded.brand?.brandId,
    role === "brand" ? decoded._id : null,
    role === "brand" ? decoded.id : null
  );
}

function getInfluencerIdFromDecoded(decoded = {}) {
  const role = String(getRoleFromDecoded(decoded) || "").toLowerCase();
  return pickValue(
    decoded.influencerId,
    decoded.influencer?._id,
    decoded.influencer?.id,
    decoded.influencer?.influencerId,
    role === "influencer" ? decoded._id : null,
    role === "influencer" ? decoded.id : null
  );
}

function getActorInfoFromRequest(req = {}) {
  const token = getBearerToken(req);
  const decoded = decodeTokenSafely(token);

  const role = pickValue(
    req.admin?.role,
    req.brand?.role,
    req.influencer?.role,
    req.user?.role,
    getRoleFromDecoded(decoded),
    req.body?.role,
    req.query?.role,
    req.params?.role
  );

  const adminId = pickValue(
    req.admin?.adminId,
    req.admin?._id,
    req.admin?.id,
    req.user?.adminId,
    req.user?.admin?._id,
    req.user?.admin?.id,
    getAdminIdFromDecoded(decoded),
    req.body?.adminId,
    req.query?.adminId,
    req.params?.adminId
  );

  const brandId = pickValue(
    req.brand?.brandId,
    req.brand?._id,
    req.brand?.id,
    req.user?.brandId,
    req.user?.brand?._id,
    req.user?.brand?.id,
    getBrandIdFromDecoded(decoded),
    req.body?.brandId,
    req.query?.brandId,
    req.params?.brandId
  );

  const influencerId = pickValue(
    req.influencer?.influencerId,
    req.influencer?._id,
    req.influencer?.id,
    req.user?.influencerId,
    req.user?.influencer?._id,
    req.user?.influencer?.id,
    getInfluencerIdFromDecoded(decoded),
    req.body?.influencerId,
    req.query?.influencerId,
    req.params?.influencerId
  );

  const userId = pickValue(
    req.user?._id,
    req.user?.id,
    decoded?._id,
    decoded?.id,
    decoded?.userId,
    req.body?.userId,
    req.query?.userId,
    req.params?.userId,
    adminId,
    brandId,
    influencerId
  );

  const actorEmail = pickValue(
    req.admin?.email,
    req.brand?.email,
    req.influencer?.email,
    req.user?.email,
    decoded?.email,
    req.body?.email,
    req.query?.email,
    req.params?.email
  );

  return { role, adminId, brandId, influencerId, actorEmail, tokenAvailable: Boolean(token), userId };
}

async function saveErrorLog(req, error, statusCode = 500, errorCode = "INTERNAL_SERVER_ERROR") {
  try {
    const actorInfo = getActorInfoFromRequest(req);

    const finalStatusCode =
      Number(statusCode) ||
      Number(error?.response?.status) ||
      Number(error?.statusCode) ||
      Number(error?.status) ||
      500;

    const priority = getPriorityFromRequest(req, finalStatusCode, error);

    const errorLog = await ErrorLog.create({
      message:
        error?.response?.data?.message ||
        error?.response?.data?.error ||
        error?.message ||
        "Unknown error",

      name: error?.name || "Error",
      statusCode: finalStatusCode,
      errorCode,
      stack: error?.stack || null,

      method: req?.method || null,
      url: req?.originalUrl || req?.url || null,
      ip: req?.headers?.["x-forwarded-for"] || req?.ip || req?.connection?.remoteAddress || null,
      userAgent: req?.headers?.["user-agent"] || null,

      role: actorInfo.role,
      adminId: actorInfo.adminId,
      brandId: actorInfo.brandId,
      influencerId: actorInfo.influencerId,
      actorEmail: actorInfo.actorEmail,
      tokenAvailable: actorInfo.tokenAvailable,
      userId: actorInfo.userId,

      requestBody: sanitizeObject(req?.body || {}),
      requestParams: sanitizeObject(req?.params || {}),
      requestQuery: sanitizeObject(req?.query || {}),
      environment: process.env.NODE_ENV || "development",

      isResolved: false,
      priority,
    });

    return errorLog;
  } catch (logError) {
    console.error("Failed to save error log:", logError);
    return null;
  }
}

module.exports = saveErrorLog;
module.exports.HIGH_PRIORITY_ROUTES = HIGH_PRIORITY_ROUTES;
module.exports.isHighPriorityRoute = isHighPriorityRoute;
module.exports.getPriorityFromRequest = getPriorityFromRequest;