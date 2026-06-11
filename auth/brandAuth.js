const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const BrandModelImport = require("../models/brand");
const WorkspaceModelImport = require("../models/workspace");
const WorkspaceMemberModelImport = require("../models/workspaceMember");

const BrandModel = BrandModelImport.BrandModel || BrandModelImport.default || BrandModelImport;
const WorkspaceModel = WorkspaceModelImport.WorkspaceModel || WorkspaceModelImport.default || WorkspaceModelImport;
const WorkspaceMemberModel = WorkspaceMemberModelImport.WorkspaceMemberModel || WorkspaceMemberModelImport.default || WorkspaceMemberModelImport;

function safeTrim(value) {
  return String(value || "").trim();
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function getBearerToken(req) {
  const auth = req.headers?.authorization || "";

  if (!auth.startsWith("Bearer ")) return "";

  return auth.slice(7).trim();
}

function getActiveWorkspaceId(req, decoded) {
  return safeTrim(
    req.headers?.["x-workspace-id"] ||
      req.headers?.["x-active-workspace-id"] ||
      req.body?.workspaceId ||
      req.query?.workspaceId ||
      decoded?.workspaceId
  );
}

function getBrandRealEmail(brand = {}) {
  return normalizeEmail(brand.brandRealEmail || brand.proxyEmail || brand.email || "");
}

async function brandAuth(req, res, next) {
  try {
    const token = getBearerToken(req);

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Missing or invalid Authorization header",
      });
    }

    const secret = process.env.JWT_SECRET;

    if (!secret) {
      return res.status(500).json({
        success: false,
        message: "JWT_SECRET is missing in env",
      });
    }

    const decoded = jwt.verify(token, secret);
    const rootBrandId = safeTrim(
      decoded.userId || decoded.rootBrandId || decoded.loginBrandId || decoded.brandId
    );

    if (!rootBrandId || !mongoose.Types.ObjectId.isValid(rootBrandId)) {
      return res.status(401).json({
        success: false,
        message: "Invalid token payload",
      });
    }

    const loginBrand = await BrandModel.findById(rootBrandId).lean();

    if (!loginBrand || loginBrand.isWorkspaceBrand === true) {
      return res.status(401).json({
        success: false,
        message: "Login brand account not found",
      });
    }

    const requestedWorkspaceId = getActiveWorkspaceId(req, decoded);

    let activeWorkspace = null;
    let activeMembership = null;
    let activeBrandId = rootBrandId;

    if (
      requestedWorkspaceId &&
      mongoose.Types.ObjectId.isValid(String(requestedWorkspaceId))
    ) {
      activeMembership = await WorkspaceMemberModel.findOne({
        workspaceId: String(requestedWorkspaceId),
        userId: rootBrandId,
        status: "accepted",
      }).lean();

      activeWorkspace = await WorkspaceModel.findOne({
        _id: String(requestedWorkspaceId),
        status: { $ne: "deleted" },
      }).lean();

      if (activeWorkspace && activeMembership) {
        activeBrandId = String(
          activeWorkspace.brandId || activeMembership.brandId || rootBrandId
        );
      }
    }

    req.brand = loginBrand;
    req.user = {
      ...decoded,

      // Real login account id. Use this for membership checks.
      userId: rootBrandId,
      rootBrandId,
      loginBrandId: rootBrandId,

      // Active brand id. Old APIs can keep using req.user.brandId.
      brandId: activeBrandId,
      activeBrandId,

      // Active workspace context.
      workspaceId: activeWorkspace ? String(activeWorkspace._id) : requestedWorkspaceId || decoded.workspaceId || "",
      activeWorkspace,
      activeMembership,

      email: normalizeEmail(loginBrand.email || decoded.email),
      brandRealEmail: getBrandRealEmail(loginBrand),
      role: decoded.role || "brand",
      workspaceRole: activeMembership?.role || "owner",
      workspaceAccessType: activeMembership?.accessType || "full_access",
      workspacePermissions: activeMembership?.permissions || {},
    };

    return next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: error?.message || "Unauthorized",
    });
  }
}

module.exports = { brandAuth };