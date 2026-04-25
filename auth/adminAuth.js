const jwt = require("jsonwebtoken");
const { ApiResponse } = require("../core/http/ApiResponse");
const { HttpStatus } = require("../core/http/HttpStatus");
const { AdminModel } = require("../models/admin");

function getRequestId(req) {
  return (
    req.requestId ||
    req.id ||
    req.headers["x-request-id"] ||
    "NA"
  );
}

const normalizeKey = (v) =>
  String(v ?? "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_");

/**
 * AUTH + ACCESS LOADER
 * - verifies JWT
 * - fetches Admin from DB
 * - uses Admin.role + Admin.access
 * - attaches req.admin = { adminId, role, access, email }
 */

async function adminAuth(req, res, next) {
  const requestId = getRequestId(req);

  try {
    const header = req.headers.authorization;

    if (!header || !header.startsWith("Bearer ")) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.UNAUTHORIZED,
        "UNAUTHORIZED",
        "Authorization token missing",
        requestId
      );
    }

    const token = header.split(" ")[1];
    const secret = process.env.JWT_SECRET;

    if (!secret) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.INTERNAL_SERVER_ERROR,
        "INTERNAL_ERROR",
        "JWT_SECRET is missing in env",
        requestId
      );
    }

    const decoded = jwt.verify(token, secret);

    if (!decoded?.adminId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.UNAUTHORIZED,
        "UNAUTHORIZED",
        "Invalid token",
        requestId
      );
    }

    const admin = await AdminModel.findById(decoded.adminId).select(
      "email role status access"
    );

    if (!admin) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.UNAUTHORIZED,
        "UNAUTHORIZED",
        "Admin not found",
        requestId
      );
    }

    const adminStatus = normalizeKey(admin.status || "");

    if (adminStatus && adminStatus !== "active") {
      return ApiResponse.sendFail(
        res,
        HttpStatus.FORBIDDEN,
        "FORBIDDEN",
        "Admin account is not active",
        requestId
      );
    }

    const roleKey = String(admin.role || "").trim();

    if (!roleKey) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.FORBIDDEN,
        "FORBIDDEN",
        "Role not assigned",
        requestId
      );
    }

    const accessRaw = admin.access;

    const access = Array.isArray(accessRaw)
      ? accessRaw.map((a) => ({
          key: normalizeKey(a?.key),
          name: a?.name ? String(a.name) : undefined,
          isEdit: Boolean(a?.isEdit),
          isDelete: Boolean(a?.isDelete),
        }))
      : [];

    req.admin = {
      adminId: String(admin._id),
      email: admin.email || decoded.email,
      role: roleKey,
      access,
      iat: decoded.iat,
      exp: decoded.exp,
    };

    return next();
  } catch (err) {
    return ApiResponse.sendFail(
      res,
      HttpStatus.UNAUTHORIZED,
      "UNAUTHORIZED",
      "Invalid token",
      requestId
    );
  }
}

/**
 * Guard: checks module access exists in admin.access[]
 * usage:
 * router.get("/policies", adminAuth, requireAccess("policy"), listPolicies)
 */
function requireAccess(required) {
  const requiredList = Array.isArray(required) ? required : [required];
  const requiredKeys = requiredList.map(normalizeKey);

  return (req, res, next) => {
    const requestId = getRequestId(req);

    const admin = req?.admin;

    if (!admin?.adminId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.UNAUTHORIZED,
        "UNAUTHORIZED",
        "Unauthorized",
        requestId
      );
    }

    const accessKeys = new Set(
      (admin.access || []).map((a) => normalizeKey(a.key))
    );

    const ok = requiredKeys.every((k) => accessKeys.has(k));

    if (!ok) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.FORBIDDEN,
        "FORBIDDEN",
        "You don't have access to this API",
        requestId
      );
    }

    return next();
  };
}

/**
 * Guard: checks isEdit=true for module(s)
 * usage:
 * router.put("/policy/:id", adminAuth, requireEditPermission("policy"), editPolicy)
 */
function requireEditPermission(required) {
  const requiredList = Array.isArray(required) ? required : [required];
  const requiredKeys = requiredList.map(normalizeKey);

  return (req, res, next) => {
    const requestId = getRequestId(req);

    const admin = req?.admin;

    if (!admin?.adminId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.UNAUTHORIZED,
        "UNAUTHORIZED",
        "Unauthorized",
        requestId
      );
    }

    const map = new Map();

    (admin.access || []).forEach((a) => {
      map.set(normalizeKey(a.key), a);
    });

    const ok = requiredKeys.every((k) => Boolean(map.get(k)?.isEdit));

    if (!ok) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.FORBIDDEN,
        "FORBIDDEN",
        "You don't have permission to edit",
        requestId
      );
    }

    return next();
  };
}

/**
 * Guard: checks isDelete=true for module(s)
 * usage:
 * router.delete("/policy/:id", adminAuth, requireDeletePermission("policy"), deletePolicy)
 */
function requireDeletePermission(required) {
  const requiredList = Array.isArray(required) ? required : [required];
  const requiredKeys = requiredList.map(normalizeKey);

  return (req, res, next) => {
    const requestId = getRequestId(req);

    const admin = req?.admin;

    if (!admin?.adminId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.UNAUTHORIZED,
        "UNAUTHORIZED",
        "Unauthorized",
        requestId
      );
    }

    const map = new Map();

    (admin.access || []).forEach((a) => {
      map.set(normalizeKey(a.key), a);
    });

    const ok = requiredKeys.every((k) => Boolean(map.get(k)?.isDelete));

    if (!ok) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.FORBIDDEN,
        "FORBIDDEN",
        "You don't have permission to delete",
        requestId
      );
    }

    return next();
  };
}

/**
 * Strict role checks if needed
 * role comes from DB via adminAuth
 * usage:
 * router.post("/admin/invite", adminAuth, requireAdminRoles(["superadmin"]), inviteAdmin)
 */
function requireAdminRoles(roles) {
  const allowed = roles.map((r) => String(r).trim());

  return (req, res, next) => {
    const requestId = getRequestId(req);

    const role = String(req?.admin?.role || "").trim();

    if (!role || !allowed.includes(role)) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.FORBIDDEN,
        "FORBIDDEN",
        "You don't have access to this API",
        requestId
      );
    }

    return next();
  };
}

module.exports = {
  adminAuth,
  requireAccess,
  requireEditPermission,
  requireDeletePermission,
  requireAdminRoles,
};