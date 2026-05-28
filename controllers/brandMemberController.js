const mongoose = require("mongoose");

const Brand = require("../models/brand");
const BrandMember = require("../models/brandMember");

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

const RESOURCES = [
  "campaigns",
  "influencers",
  "deliverables_milestones",
  "payments_contracts",
  "team_invitations",
  "inbox_communication",
];

const LIMITED_ACCESS = {
  campaigns: "view",
  influencers: "view",
  deliverables_milestones: "view",
  payments_contracts: "none",
  team_invitations: "none",
  inbox_communication: "view",
};

const LEVEL_RANK = {
  none: 0,
  view: 1,
  edit: 2,
};

function sendError(res, status, message) {
  return res.status(status).json({
    success: false,
    message,
  });
}

function sameId(a, b) {
  return String(a || "") === String(b || "");
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function getCurrentBrandId(req) {
  return (
    req.brand?._id ||
    req.brand?.brandId ||
    req.brand?.id ||
    req.user?.brandId ||
    req.user?._id ||
    req.user?.id ||
    req.auth?.brandId ||
    req.brandId
  );
}

async function getCurrentBrandFromReq(req) {
  if (req.brand?._id && req.brand?.email) {
    return req.brand;
  }

  const brandId = getCurrentBrandId(req);

  if (!brandId || !mongoose.Types.ObjectId.isValid(String(brandId))) {
    return null;
  }

  return Brand.findById(brandId).select(
    "email name brandName profilePic workspaceUsers authProvider provider googleId googleSub createdAt"
  );
}

function isGoogleBrandAccount(brand) {
  const authProvider = String(brand?.authProvider || "").toLowerCase();
  const provider = String(brand?.provider || "").toLowerCase();

  return (
    authProvider === "google" ||
    provider === "google" ||
    Boolean(brand?.googleId) ||
    Boolean(brand?.googleSub)
  );
}

function normalizeLevel(value) {
  const level = String(value || "").trim().toLowerCase();

  return ["none", "view", "edit"].includes(level) ? level : "none";
}

function normalizeResourceKey(value) {
  const key = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (key === "deliverables__milestones") return "deliverables_milestones";

  return key;
}

function buildPermissions(accessType = "limited", inputPermissions = []) {
  const safeAccessType = String(accessType || "limited").toLowerCase();

  if (safeAccessType === "full") {
    return RESOURCES.map((key) => ({
      key,
      level: "edit",
    }));
  }

  if (safeAccessType === "limited") {
    return RESOURCES.map((key) => ({
      key,
      level: LIMITED_ACCESS[key] || "none",
    }));
  }

  const inputMap = new Map();

  for (const item of inputPermissions || []) {
    const key = normalizeResourceKey(item.key || item.resource || item.name);
    const level = normalizeLevel(item.level || item.access);

    if (RESOURCES.includes(key)) {
      inputMap.set(key, level);
    }
  }

  return RESOURCES.map((key) => ({
    key,
    level: inputMap.get(key) || "none",
  }));
}

function hasPermission(member, key, requiredLevel = "view") {
  const permission = member?.permissions?.find((item) => item.key === key);

  if (!permission) return false;

  return LEVEL_RANK[permission.level] >= LEVEL_RANK[requiredLevel];
}

function isWorkspaceUserActive(ownerBrand, email) {
  const cleanEmail = normalizeEmail(email);

  return Array.isArray(ownerBrand?.workspaceUsers)
    ? ownerBrand.workspaceUsers.some((item) => {
        return (
          normalizeEmail(item?.email) === cleanEmail &&
          String(item?.status || "").toLowerCase() === "active"
        );
      })
    : false;
}

function formatMember(member, currentBrandId = null) {
  const populatedUser =
    member.memberBrandId &&
    typeof member.memberBrandId === "object" &&
    member.memberBrandId.email
      ? member.memberBrandId
      : null;

  const memberBrandId = populatedUser?._id || member.memberBrandId || null;

  return {
    id: String(member._id),
    brandId: memberBrandId ? String(memberBrandId) : null,
    name:
      populatedUser?.name ||
      populatedUser?.brandName ||
      member.name ||
      "Shared Member",
    email: populatedUser?.email || member.email,
    profilePic: populatedUser?.profilePic || member.profilePic || "",
    role: "member",
    accessType: member.accessType,
    permissions: member.permissions || [],
    status: member.status,
    invitedAt: member.createdAt,
    inviteSentAt: member.inviteSentAt,
    joinedAt: member.joinedAt,
    removedAt: member.removedAt,
    isYou:
      currentBrandId && memberBrandId
        ? sameId(memberBrandId, currentBrandId)
        : false,
  };
}

function formatOwnerRow(ownerBrand, currentBrandId = null) {
  return {
    id: String(ownerBrand._id),
    brandId: String(ownerBrand._id),
    name: ownerBrand.name || ownerBrand.brandName || "Owner",
    email: ownerBrand.email,
    profilePic: ownerBrand.profilePic || "",
    role: "owner",
    accessType: "owner",
    permissions: buildPermissions("full"),
    status: "active",
    joinedAt: ownerBrand.createdAt,
    isYou: currentBrandId ? sameId(ownerBrand._id, currentBrandId) : false,
  };
}

async function getBrandWorkspace(brandId) {
  if (!brandId || !mongoose.Types.ObjectId.isValid(String(brandId))) {
    return null;
  }

  return Brand.findById(brandId).select(
    "email name brandName profilePic workspaceUsers authProvider provider googleId googleSub createdAt"
  );
}

async function canViewWorkspace(brandId, currentBrand) {
  if (!currentBrand?._id) {
    return {
      allowed: false,
      message: "Unauthorized.",
    };
  }

  const ownerBrand = await getBrandWorkspace(brandId);

  if (!ownerBrand) {
    return {
      allowed: false,
      message: "Brand workspace not found.",
    };
  }

  if (sameId(ownerBrand._id, currentBrand._id)) {
    return {
      allowed: true,
      brand: ownerBrand,
      isOwner: true,
      member: null,
    };
  }

  const currentEmail = normalizeEmail(currentBrand.email);

  if (!isWorkspaceUserActive(ownerBrand, currentEmail)) {
    return {
      allowed: false,
      message: "You do not have access to this workspace.",
    };
  }

  let member = await BrandMember.findOne({
    brandId,
    email: currentEmail,
    status: "active",
  });

  if (member && !member.memberBrandId) {
    member.memberBrandId = currentBrand._id;
    member.name = currentBrand.name || currentBrand.brandName || "";
    member.profilePic = currentBrand.profilePic || "";
    member.joinedAt = member.joinedAt || new Date();
    await member.save();
  }

  if (!member) {
    return {
      allowed: true,
      brand: ownerBrand,
      isOwner: false,
      member: {
        accessType: "limited",
        permissions: buildPermissions("limited"),
      },
    };
  }

  return {
    allowed: true,
    brand: ownerBrand,
    isOwner: false,
    member,
  };
}

async function canViewTeam(brandId, currentBrand) {
  const access = await canViewWorkspace(brandId, currentBrand);

  if (!access.allowed) return access;

  if (access.isOwner) return access;

  if (hasPermission(access.member, "team_invitations", "view")) {
    return access;
  }

  return {
    allowed: false,
    message: "You do not have permission to view team members.",
  };
}

async function canManageTeam(brandId, currentBrand) {
  const access = await canViewWorkspace(brandId, currentBrand);

  if (!access.allowed) return access;

  if (access.isOwner) return access;

  if (hasPermission(access.member, "team_invitations", "edit")) {
    return access;
  }

  return {
    allowed: false,
    message: "You do not have permission to manage team members.",
  };
}

async function sendInviteEmailSafe({ to, loginLink, ownerBrand }) {
  try {
    if (process.env.SEND_INVITE_EMAILS !== "true") {
      return false;
    }

    let sendEmail = null;

    try {
      const EmailServiceImport = require("../services/emailService");
      sendEmail =
        EmailServiceImport.sendEmail ||
        EmailServiceImport.default ||
        EmailServiceImport;
    } catch {
      const EmailUtilImport = require("../utils/sendEmail");
      sendEmail =
        EmailUtilImport.sendEmail || EmailUtilImport.default || EmailUtilImport;
    }

    if (typeof sendEmail !== "function") {
      return false;
    }

    const brandName = ownerBrand.brandName || ownerBrand.name || "A brand";

    await sendEmail({
      to,
      subject: `${brandName} invited you to CollabGlam`,
      text: `${brandName} invited you to access their workspace. Login with Google using ${to}: ${loginLink}`,
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.5;">
          <h2>You have been invited</h2>
          <p><strong>${brandName}</strong> invited you to access their CollabGlam workspace.</p>
          <p>Please login with Google using this same email:</p>
          <p><strong>${to}</strong></p>
          <p>
            <a href="${loginLink}" target="_blank" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;text-decoration:none;border-radius:6px;">
              Login with Google
            </a>
          </p>
        </div>
      `,
    });

    return true;
  } catch (error) {
    console.error("Invite email failed:", error.message);
    return false;
  }
}

exports.getMyWorkspaces = async (req, res) => {
  try {
    const currentBrand = await getCurrentBrandFromReq(req);

    if (!currentBrand) {
      return sendError(res, 401, "Unauthorized.");
    }

    const currentEmail = normalizeEmail(currentBrand.email);

    const sharedOwnerBrands = await Brand.find({
      _id: { $ne: currentBrand._id },
      workspaceUsers: {
        $elemMatch: {
          email: currentEmail,
          status: "active",
        },
      },
    })
      .select("email name brandName profilePic workspaceUsers createdAt")
      .lean();

    const ownerBrandIds = sharedOwnerBrands.map((item) => item._id);

    const memberAccessRows = await BrandMember.find({
      brandId: { $in: ownerBrandIds },
      email: currentEmail,
      status: "active",
    }).lean();

    await BrandMember.updateMany(
      {
        brandId: { $in: ownerBrandIds },
        email: currentEmail,
        status: "active",
        memberBrandId: null,
      },
      {
        $set: {
          memberBrandId: currentBrand._id,
          name: currentBrand.name || currentBrand.brandName || "",
          profilePic: currentBrand.profilePic || "",
          joinedAt: new Date(),
        },
      }
    );

    const shared = sharedOwnerBrands.map((ownerBrand) => {
      const access = memberAccessRows.find((row) =>
        sameId(row.brandId, ownerBrand._id)
      );

      return {
        id: access?._id ? String(access._id) : String(ownerBrand._id),
        brandId: String(ownerBrand._id),
        brandName: ownerBrand.brandName || ownerBrand.name || "",
        name: ownerBrand.name || ownerBrand.brandName || "",
        email: ownerBrand.email,
        profilePic: ownerBrand.profilePic || "",
        role: "member",
        accessType: access?.accessType || "limited",
        permissions: access?.permissions || buildPermissions("limited"),
        joinedAt: access?.joinedAt || null,
      };
    });

    return res.status(200).json({
      success: true,
      own: {
        brandId: String(currentBrand._id),
        brandName: currentBrand.brandName || currentBrand.name || "",
        name: currentBrand.name || currentBrand.brandName || "",
        email: currentBrand.email,
        profilePic: currentBrand.profilePic || "",
        role: "owner",
        accessType: "owner",
        permissions: buildPermissions("full"),
      },
      shared,
    });
  } catch (error) {
    return sendError(res, 500, error.message);
  }
};

exports.listMembers = async (req, res) => {
  try {
    const { brandId } = req.params;

    if (!brandId || !mongoose.Types.ObjectId.isValid(String(brandId))) {
      return sendError(res, 400, "Invalid brandId.");
    }

    const currentBrand = await getCurrentBrandFromReq(req);

    if (!currentBrand) {
      return sendError(res, 401, "Unauthorized.");
    }

    const access = await canViewTeam(brandId, currentBrand);

    if (!access.allowed) {
      return sendError(res, 403, access.message);
    }

    const ownerBrand = access.brand;
    const currentBrandId = String(currentBrand._id);

    const ownerRow = formatOwnerRow(ownerBrand, currentBrandId);

    const members = await BrandMember.find({
      brandId,
      status: { $in: ["active", "invited"] },
    })
      .populate("memberBrandId", "email name brandName profilePic")
      .sort({ createdAt: 1 });

    return res.status(200).json({
      success: true,
      brandId,
      members: [
        ownerRow,
        ...members.map((member) => formatMember(member, currentBrandId)),
      ],
    });
  } catch (error) {
    return sendError(res, 500, error.message);
  }
};

exports.getMemberInfo = async (req, res) => {
  try {
    const { brandId, memberId } = req.params;

    if (!brandId || !mongoose.Types.ObjectId.isValid(String(brandId))) {
      return sendError(res, 400, "Invalid brandId.");
    }

    if (!memberId || !mongoose.Types.ObjectId.isValid(String(memberId))) {
      return sendError(res, 400, "Invalid memberId.");
    }

    const currentBrand = await getCurrentBrandFromReq(req);

    if (!currentBrand) {
      return sendError(res, 401, "Unauthorized.");
    }

    const access = await canViewTeam(brandId, currentBrand);

    if (!access.allowed) {
      return sendError(res, 403, access.message);
    }

    const member = await BrandMember.findOne({
      _id: memberId,
      brandId,
      status: { $in: ["active", "invited"] },
    }).populate("memberBrandId", "email name brandName profilePic");

    if (!member) {
      return sendError(res, 404, "Member not found.");
    }

    return res.status(200).json({
      success: true,
      member: formatMember(member, currentBrand._id),
    });
  } catch (error) {
    return sendError(res, 500, error.message);
  }
};

exports.inviteMember = async (req, res) => {
  try {
    const { brandId } = req.params;
    const { email, accessType = "limited", permissions = [] } = req.body || {};

    if (!brandId || !mongoose.Types.ObjectId.isValid(String(brandId))) {
      return sendError(res, 400, "Invalid brandId.");
    }

    if (!email) {
      return sendError(res, 400, "Email is required.");
    }

    const currentBrand = await getCurrentBrandFromReq(req);

    if (!currentBrand) {
      return sendError(res, 401, "Unauthorized.");
    }

    if (!sameId(currentBrand._id, brandId)) {
      return sendError(res, 403, "Only brand owner can invite members.");
    }

    const cleanEmail = normalizeEmail(email);

    const ownerBrand = await Brand.findById(brandId).select(
      "email name brandName profilePic workspaceUsers createdAt"
    );

    if (!ownerBrand) {
      return sendError(res, 404, "Brand workspace not found.");
    }

    if (normalizeEmail(ownerBrand.email) === cleanEmail) {
      return sendError(res, 400, "Owner is already part of this workspace.");
    }

    const safeAccessType = ["full", "limited", "custom"].includes(
      String(accessType || "").toLowerCase()
    )
      ? String(accessType).toLowerCase()
      : "limited";

    const targetBrand = await Brand.findOne({ email: cleanEmail }).select(
      "email name brandName profilePic"
    );

    const workspaceUsers = Array.isArray(ownerBrand.workspaceUsers)
      ? ownerBrand.workspaceUsers
      : [];

    const existingWorkspaceUser = workspaceUsers.find((item) => {
      return normalizeEmail(item?.email) === cleanEmail;
    });

    if (existingWorkspaceUser) {
      existingWorkspaceUser.status = "active";
    } else {
      workspaceUsers.push({
        email: cleanEmail,
        status: "active",
      });
    }

    ownerBrand.workspaceUsers = workspaceUsers;
    await ownerBrand.save();

    const member = await BrandMember.findOneAndUpdate(
      {
        brandId,
        email: cleanEmail,
      },
      {
        brandId,
        memberBrandId: targetBrand?._id || null,
        email: cleanEmail,
        name: targetBrand?.name || targetBrand?.brandName || "",
        profilePic: targetBrand?.profilePic || "",
        accessType: safeAccessType,
        permissions: buildPermissions(safeAccessType, permissions),
        status: "active",
        invitedBy: currentBrand._id,
        inviteSentAt: new Date(),
        joinedAt: targetBrand ? new Date() : null,
        removedAt: null,
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }
    );

    const loginLink = `${FRONTEND_URL}/login?invited=1&brandId=${encodeURIComponent(
      String(brandId)
    )}&email=${encodeURIComponent(cleanEmail)}`;

    const emailSent = await sendInviteEmailSafe({
      to: cleanEmail,
      loginLink,
      ownerBrand,
    });

    return res.status(201).json({
      success: true,
      message: "Invite created successfully.",
      loginLink,
      emailSent,
      workspaceUser: {
        email: cleanEmail,
        status: "active",
      },
      member: formatMember(member, currentBrand._id),
    });
  } catch (error) {
    return sendError(res, 500, error.message);
  }
};

exports.updateMemberAccess = async (req, res) => {
  try {
    const { brandId, memberId } = req.params;
    const { accessType = "limited", permissions = [] } = req.body || {};

    if (!brandId || !mongoose.Types.ObjectId.isValid(String(brandId))) {
      return sendError(res, 400, "Invalid brandId.");
    }

    if (!memberId || !mongoose.Types.ObjectId.isValid(String(memberId))) {
      return sendError(res, 400, "Invalid memberId.");
    }

    const currentBrand = await getCurrentBrandFromReq(req);

    if (!currentBrand) {
      return sendError(res, 401, "Unauthorized.");
    }

    if (!sameId(currentBrand._id, brandId)) {
      return sendError(res, 403, "Only brand owner can update access.");
    }

    const member = await BrandMember.findOne({
      _id: memberId,
      brandId,
      status: { $in: ["active", "invited"] },
    });

    if (!member) {
      return sendError(res, 404, "Member not found.");
    }

    const safeAccessType = ["full", "limited", "custom"].includes(
      String(accessType || "").toLowerCase()
    )
      ? String(accessType).toLowerCase()
      : "limited";

    member.accessType = safeAccessType;
    member.permissions = buildPermissions(safeAccessType, permissions);
    member.status = "active";
    member.removedAt = null;

    await member.save();

    await Brand.updateOne(
      {
        _id: brandId,
        "workspaceUsers.email": normalizeEmail(member.email),
      },
      {
        $set: {
          "workspaceUsers.$.status": "active",
        },
      }
    );

    return res.status(200).json({
      success: true,
      message: "Member access updated successfully.",
      member: formatMember(member, currentBrand._id),
    });
  } catch (error) {
    return sendError(res, 500, error.message);
  }
};

exports.removeMemberAccess = async (req, res) => {
  try {
    const { brandId, memberId } = req.params;

    if (!brandId || !mongoose.Types.ObjectId.isValid(String(brandId))) {
      return sendError(res, 400, "Invalid brandId.");
    }

    if (!memberId || !mongoose.Types.ObjectId.isValid(String(memberId))) {
      return sendError(res, 400, "Invalid memberId.");
    }

    const currentBrand = await getCurrentBrandFromReq(req);

    if (!currentBrand) {
      return sendError(res, 401, "Unauthorized.");
    }

    if (!sameId(currentBrand._id, brandId)) {
      return sendError(res, 403, "Only brand owner can remove access.");
    }

    const member = await BrandMember.findOne({
      _id: memberId,
      brandId,
      status: { $in: ["active", "invited"] },
    });

    if (!member) {
      return sendError(res, 404, "Member not found.");
    }

    member.status = "removed";
    member.removedAt = new Date();

    await member.save();

    await Brand.updateOne(
      {
        _id: brandId,
        "workspaceUsers.email": normalizeEmail(member.email),
      },
      {
        $set: {
          "workspaceUsers.$.status": "inactive",
        },
      }
    );

    return res.status(200).json({
      success: true,
      message: "Member access removed successfully.",
    });
  } catch (error) {
    return sendError(res, 500, error.message);
  }
};

exports.getMyAccess = async (req, res) => {
  try {
    const { brandId } = req.params;

    if (!brandId || !mongoose.Types.ObjectId.isValid(String(brandId))) {
      return sendError(res, 400, "Invalid brandId.");
    }

    const currentBrand = await getCurrentBrandFromReq(req);

    if (!currentBrand) {
      return sendError(res, 401, "Unauthorized.");
    }

    const access = await canViewWorkspace(brandId, currentBrand);

    if (!access.allowed) {
      return sendError(res, 403, access.message);
    }

    if (access.isOwner) {
      return res.status(200).json({
        success: true,
        role: "owner",
        accessType: "owner",
        permissions: buildPermissions("full"),
      });
    }

    return res.status(200).json({
      success: true,
      role: "member",
      accessType: access.member.accessType || "limited",
      permissions: access.member.permissions || buildPermissions("limited"),
    });
  } catch (error) {
    return sendError(res, 500, error.message);
  }
};

exports.previewInvite = async (_req, res) => {
  return res.status(410).json({
    success: false,
    message: "Invite token preview is disabled. Please use simple login flow.",
  });
};

exports.acceptInvite = async (_req, res) => {
  return res.status(410).json({
    success: false,
    message: "Accept invite API is disabled. User access is activated from invite API and login.",
  });
};