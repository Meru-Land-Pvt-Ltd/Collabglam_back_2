const mongoose = require("mongoose");

const WorkspaceModelImport = require("../models/workspace");
const WorkspaceMemberModelImport = require("../models/workspaceMember");
const WorkspaceInvitationModelImport = require("../models/workspaceInvitation");
const WorkspaceActivityModelImport = require("../models/workspaceActivity");
const BrandModelImport = require("../models/brand");
const {
  getBrandRealEmail,
  getOrCreateWorkspaceBrand,
} = require("../utils/workspaceBrandClone");

const WorkspaceModel =
  WorkspaceModelImport.WorkspaceModel ||
  WorkspaceModelImport.default ||
  WorkspaceModelImport;

const WorkspaceMemberModel =
  WorkspaceMemberModelImport.WorkspaceMemberModel ||
  WorkspaceMemberModelImport.default ||
  WorkspaceMemberModelImport;

const WorkspaceInvitationModel =
  WorkspaceInvitationModelImport.WorkspaceInvitationModel ||
  WorkspaceInvitationModelImport.default ||
  WorkspaceInvitationModelImport;

const WorkspaceActivityModel =
  WorkspaceActivityModelImport.WorkspaceActivityModel ||
  WorkspaceActivityModelImport.default ||
  WorkspaceActivityModelImport;

const BrandModel =
  BrandModelImport.BrandModel || BrandModelImport.default || BrandModelImport;

const clean = (value) => String(value || "").trim();
const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

function escapeRegex(value) {
  return clean(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getAuthedUserId(req = {}) {
  return clean(
    req.user?.rootBrandId ||
      req.user?.userId ||
      req.user?.loginBrandId ||
      req.user?.brandUserId ||
      req.user?._id ||
      req.brand?._id ||
      req.brand?.id ||
      req.auth?.rootBrandId ||
      req.auth?.brandId ||
      req.body?.ownerBrandId ||
      req.query?.ownerBrandId ||
      req.body?.brandId ||
      req.query?.brandId
  );
}

function slugifyWorkspaceName(value) {
  const base = clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

  return base || `workspace-${Date.now()}`;
}

async function buildUniqueWorkspaceSlug(name) {
  const base = slugifyWorkspaceName(name || "workspace");
  let slug = base;
  let counter = 2;

  while (await WorkspaceModel.findOne({ slug }).select("_id").lean()) {
    slug = `${base}-${counter}`;
    counter += 1;
  }

  return slug;
}

function buildFullAccessPermissions() {
  return {
    campaigns: { view: true, create: true, update: true, delete: true },
    influencers: { view: true, manage: true },
    contracts: { view: true, create: true, update: true, approve: true },
    deliverables: { view: true, review: true, approve: true },
    payments: { view: true, manage: true, approve: true },
    reports: { view: true },
    team: { view: true, invite: true, remove: true, changeRole: true },
    settings: { view: true, update: true },
  };
}

function buildLimitedAccessPermissions(input = {}) {
  const full = buildFullAccessPermissions();
  const permissions = JSON.parse(JSON.stringify(full));

  Object.keys(permissions).forEach((moduleName) => {
    Object.keys(permissions[moduleName]).forEach((action) => {
      permissions[moduleName][action] = Boolean(input?.[moduleName]?.[action]);
    });
  });

  if (!Object.keys(input || {}).length) {
    permissions.campaigns.view = true;
    permissions.influencers.view = true;
    permissions.reports.view = true;
  }

  return permissions;
}

function permissionsForAccessType(accessType, customPermissions = {}) {
  return accessType === "full_access"
    ? buildFullAccessPermissions()
    : buildLimitedAccessPermissions(customPermissions);
}

function getPlanWorkspaceLimit(brand = {}) {
  const subscription = brand.subscription || {};
  const features = Array.isArray(subscription.features)
    ? subscription.features
    : [];

  const match = features.find((feature) => {
    const key = clean(feature?.key)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");

    return ["workspace", "workspaces", "workspacecount", "workspacelimit"].includes(
      key
    );
  });

  const limit = Number(match?.limit ?? match?.value ?? brand.workspaceLimit ?? 1);

  if (limit === -1) return -1;

  return Number.isFinite(limit) && limit > 0 ? limit : 1;
}

function serializeWorkspace(workspace = {}, membership = null, currentUserId = "") {
  const plain = workspace.toObject ? workspace.toObject() : { ...workspace };
  const workspaceId = String(plain._id || plain.workspaceId || "");

  const isOwner =
    String(plain.ownerBrandId || plain.createdBy || plain.brandId || "") ===
    String(currentUserId || "");

  return {
    ...plain,
    workspaceId,
    id: workspaceId,
    role: membership?.role || undefined,
    accessType: membership?.accessType || undefined,
    permissions: membership?.permissions || undefined,
    memberStatus: membership?.status || undefined,
    relation: isOwner || membership?.role === "owner" ? "you" : "others",
    relationLabel: isOwner || membership?.role === "owner" ? "You" : "Other's",
    canDelete: isOwner || membership?.role === "owner",
    canLeave: !(isOwner || membership?.role === "owner"),
  };
}

async function getMembershipOr403({ workspaceId, userId }) {
  const membership = await WorkspaceMemberModel.findOne({
    workspaceId,
    userId,
    status: "accepted",
  }).lean();

  if (!membership) {
    const error = new Error("You do not have access to this workspace");
    error.statusCode = 403;
    throw error;
  }

  return membership;
}

function canManageWorkspace(member) {
  return member?.role === "owner" || member?.permissions?.settings?.update === true;
}

function canViewTeam(member) {
  return member?.role === "owner" || member?.permissions?.team?.view === true;
}

async function getMyWorkspaces(req, res) {
  try {
    const userId = getAuthedUserId(req);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Authentication is required",
      });
    }

    const brand = mongoose.Types.ObjectId.isValid(userId)
      ? await BrandModel.findById(userId).lean()
      : null;

    if (!brand) {
      return res.status(404).json({
        success: false,
        message: "Brand account not found",
      });
    }

    const userEmails = [brand.email, brand.brandRealEmail, brand.proxyEmail]
      .map((email) => normalizeEmail(email))
      .filter(Boolean);
    const uniqueUserEmails = [...new Set(userEmails)];

    const memberships = await WorkspaceMemberModel.find({
      userId,
      status: "accepted",
    })
      .sort({ updatedAt: -1 })
      .lean();

    const acceptedWorkspaceIds = memberships
      .map((member) => member.workspaceId)
      .filter((id) => mongoose.Types.ObjectId.isValid(String(id)));

    const acceptedWorkspaces = acceptedWorkspaceIds.length
      ? await WorkspaceModel.find({
          _id: { $in: acceptedWorkspaceIds },
          status: { $ne: "deleted" },
        })
          .sort({ updatedAt: -1 })
          .lean()
      : [];

    const memberByWorkspaceId = new Map(
      memberships.map((member) => [String(member.workspaceId), member])
    );

    const acceptedItems = acceptedWorkspaces.map((workspace) =>
      serializeWorkspace(
        workspace,
        memberByWorkspaceId.get(String(workspace._id)),
        userId
      )
    );

    const pendingInvitations = uniqueUserEmails.length
      ? await WorkspaceInvitationModel.find({
          email: { $in: uniqueUserEmails },
          status: "pending",
        })
          .sort({ createdAt: -1 })
          .lean()
      : [];

    const pendingWorkspaceIds = pendingInvitations
      .map((invite) => invite.workspaceId)
      .filter((id) => mongoose.Types.ObjectId.isValid(String(id)));

    const pendingWorkspaces = pendingWorkspaceIds.length
      ? await WorkspaceModel.find({
          _id: { $in: pendingWorkspaceIds },
          status: { $ne: "deleted" },
        })
          .sort({ updatedAt: -1 })
          .lean()
      : [];

    const pendingWorkspaceById = new Map(
      pendingWorkspaces.map((workspace) => [String(workspace._id), workspace])
    );

    const acceptedWorkspaceIdSet = new Set(
      acceptedItems.map((item) => String(item.workspaceId || item._id || ""))
    );

    const pendingItems = pendingInvitations
      .map((invite) => {
        const workspace = pendingWorkspaceById.get(String(invite.workspaceId));

        if (!workspace) return null;

        const workspaceId = String(workspace._id);

        if (acceptedWorkspaceIdSet.has(workspaceId)) return null;

        return {
          ...serializeWorkspace(
            workspace,
            {
              role: invite.role,
              accessType: invite.accessType,
              permissions: invite.permissions || {},
              status: "pending",
            },
            userId
          ),

          inviteStatus: "pending",
          memberStatus: "pending",
          isPendingInvitation: true,

          invitationId: String(invite._id),
          invitationToken: invite.token,

          role: invite.role,
          accessType: invite.accessType,
          invitedEmail: invite.email,
          invitedBy: invite.invitedBy || "",
          relation: "invited",
          relationLabel: "Invited",

          canDelete: false,
          canLeave: false,
          canAccept: true,
          canReject: true,
        };
      })
      .filter(Boolean);

    const items = [...acceptedItems, ...pendingItems];

    const ownedCount = acceptedItems.filter((item) => {
      return (
        String(item.ownerBrandId || item.createdBy || "") === String(userId) ||
        item.role === "owner"
      );
    }).length;

    const workspaceLimit = getPlanWorkspaceLimit(brand || {});
    const limitReached = workspaceLimit !== -1 && ownedCount >= workspaceLimit;

    return res.status(200).json({
      success: true,
      message: "Workspaces fetched successfully",
      data: {
        totalCount: items.length,
        acceptedCount: acceptedItems.length,
        pendingInvitationCount: pendingItems.length,
        used: ownedCount,
        total: workspaceLimit,
        limitReached,
        canAddWorkspace: !limitReached,
        workspaces: items,
      },
    });
  } catch (error) {
    console.error("[getMyWorkspaces]", error);

    return res.status(error.statusCode || 500).json({
      success: false,
      message: error?.message || "Failed to fetch workspaces",
    });
  }
}

async function createWorkspace(req, res) {
  try {
    const userId = getAuthedUserId(req);
    const name = clean(req.body?.name || req.body?.workspaceName);
    const logo = clean(
      req.body?.logo || req.body?.workspaceLogo || req.body?.profilePic
    );

    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(401).json({
        success: false,
        message: "Authentication is required",
      });
    }

    if (!name) {
      return res.status(400).json({
        success: false,
        message: "Workspace name is required",
      });
    }

    const brand = await BrandModel.findById(userId).lean();

    if (!brand) {
      return res.status(404).json({
        success: false,
        message: "Account not found",
      });
    }

    const duplicateWorkspace = await WorkspaceModel.findOne({
      ownerBrandId: userId,
      name: { $regex: `^${escapeRegex(name)}$`, $options: "i" },
      status: { $ne: "deleted" },
    })
      .select("_id name")
      .lean();

    if (duplicateWorkspace) {
      return res.status(409).json({
        success: false,
        message: "Workspace with this name already exists",
      });
    }

    const ownedCount = await WorkspaceModel.countDocuments({
      $or: [{ createdBy: userId }, { ownerBrandId: userId }],
      status: { $ne: "deleted" },
    });

    const brandRealEmail = getBrandRealEmail(brand);
    const workspaceObjectId = new mongoose.Types.ObjectId();
    const workspaceId = String(workspaceObjectId);
    const slug = await buildUniqueWorkspaceSlug(name);

    let workspaceBrandId = userId;

    if (ownedCount > 0) {
      const workspaceStub = {
        _id: workspaceObjectId,
        id: workspaceId,
        workspaceId,
        name,
        slug,
        logo,
        brandId: userId,
        ownerBrandId: userId,
        createdBy: userId,
        brandRealEmail,
        isDefault: false,
      };

      const workspaceBrand = await getOrCreateWorkspaceBrand({
        BrandModel,
        mainBrand: brand,
        workspace: workspaceStub,
        workspaceName: name,
        logo,
      });

      workspaceBrandId = String(workspaceBrand._id);
    }

    const workspace = await WorkspaceModel.create({
      _id: workspaceObjectId,

      brandId: workspaceBrandId,
      ownerBrandId: userId,
      brandRealEmail,

      name,
      slug,
      logo,

      status: "active",
      createdBy: userId,
      isDefault: ownedCount === 0,
    });

    const permissions = buildFullAccessPermissions();

    await WorkspaceMemberModel.findOneAndUpdate(
      {
        workspaceId,
        userId,
      },
      {
        workspaceId,

        brandId: workspaceBrandId,
        rootBrandId: userId,
        workspaceBrandId,
        brandRealEmail,

        userId,
        email: normalizeEmail(brand.email || brandRealEmail),

        role: "owner",
        accessType: "full_access",
        permissions,
        status: "accepted",
        invitedBy: "",
        joinedAt: new Date(),
      },
      {
        upsert: true,
        new: true,
      }
    );

    if (ownedCount === 0 || !brand.workspaceId) {
      await BrandModel.updateOne(
        { _id: userId },
        {
          $set: {
            workspaceId,
            brandRealEmail: brandRealEmail || brand.email || "",
          },
        }
      ).exec();
    }

    await WorkspaceActivityModel.create({
      workspaceId,
      brandId: workspaceBrandId,
      action: "WORKSPACE_CREATED",
      module: "workspace",
      performedBy: userId,
      performedRole: "owner",
      message: "Workspace created from settings",
      metadata: {
        source: "workspace_settings",
        ownerBrandId: userId,
        workspaceBrandId,
        brandRealEmail,
        isDefault: ownedCount === 0,
      },
    });

    return res.status(201).json({
      success: true,
      message: "Workspace created successfully",
      data: {
        workspace: serializeWorkspace(
          workspace,
          {
            role: "owner",
            accessType: "full_access",
            permissions,
            status: "accepted",
          },
          userId
        ),
      },
    });
  } catch (error) {
    console.error("[createWorkspace]", error);

    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "Duplicate workspace database key found",
        data: {
          keyPattern: error.keyPattern || {},
          keyValue: error.keyValue || {},
        },
      });
    }

    return res.status(error.statusCode || 500).json({
      success: false,
      message: error?.message || "Failed to create workspace",
    });
  }
}

async function getWorkspaceById(req, res) {
  try {
    const userId = getAuthedUserId(req);
    const workspaceId = clean(req.params?.workspaceId || req.query?.workspaceId);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Authentication is required",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(workspaceId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid workspaceId",
      });
    }

    const membership = await getMembershipOr403({ workspaceId, userId });

    const workspace = await WorkspaceModel.findOne({
      _id: workspaceId,
      status: { $ne: "deleted" },
    }).lean();

    if (!workspace) {
      return res.status(404).json({
        success: false,
        message: "Workspace not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Workspace fetched successfully",
      data: serializeWorkspace(workspace, membership, userId),
    });
  } catch (error) {
    console.error("[getWorkspaceById]", error);

    return res.status(error.statusCode || 500).json({
      success: false,
      message: error?.message || "Failed to fetch workspace",
    });
  }
}

async function getWorkspaceMembers(req, res) {
  try {
    const userId = getAuthedUserId(req);
    const workspaceId = clean(req.params?.workspaceId || req.query?.workspaceId);
    const includePending =
      clean(req.query?.includePending || "true").toLowerCase() !== "false";

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Authentication is required",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(workspaceId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid workspaceId",
      });
    }

    const requesterMembership = await getMembershipOr403({
      workspaceId,
      userId,
    });

    if (!canViewTeam(requesterMembership)) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to view workspace members",
      });
    }

    const members = await WorkspaceMemberModel.find({
      workspaceId,
      status: { $ne: "removed" },
    })
      .sort({ role: 1, createdAt: -1 })
      .lean();

    const userIds = members
      .map((member) => member.userId)
      .filter((id) => mongoose.Types.ObjectId.isValid(String(id)));

    const brands = userIds.length
      ? await BrandModel.find({ _id: { $in: userIds } })
          .select("brandName name email brandRealEmail proxyEmail profilePic workspaceId")
          .lean()
      : [];

    const brandById = new Map(brands.map((brand) => [String(brand._id), brand]));

    const acceptedItems = members.map((member) => {
      const profile = brandById.get(String(member.userId));
      const name = profile?.name || profile?.brandName || member.email || "Member";
      const email = profile?.email || member.email || "";
      const brandRealEmail =
        profile?.brandRealEmail ||
        profile?.proxyEmail ||
        profile?.email ||
        member.brandRealEmail ||
        member.email ||
        "";

      return {
        ...member,
        memberId: String(member._id),
        workspaceId: String(member.workspaceId),
        name,
        email,
        brandRealEmail,
        rootBrandId: member.rootBrandId || member.userId,
        workspaceBrandId: member.workspaceBrandId || member.brandId,
        avatar: profile?.profilePic || "",
        accessLabel:
          member.role === "owner"
            ? "Owner"
            : member.accessType === "full_access"
              ? "Full Access"
              : "Limited Access",
        user: profile
          ? {
              userId: String(profile._id),
              name: profile.name || profile.brandName || "",
              brandName: profile.brandName || "",
              email: profile.email || "",
              brandRealEmail,
              profilePic: profile.profilePic || "",
            }
          : null,
      };
    });

    let pendingItems = [];

    if (includePending) {
      const pendingInvitations = await WorkspaceInvitationModel.find({
        workspaceId,
        inviteType: "email",
        status: "pending",
      })
        .sort({ createdAt: -1 })
        .lean();

      pendingItems = pendingInvitations.map((invite) => ({
        invitationId: String(invite._id),
        workspaceId: String(invite.workspaceId),
        name: normalizeEmail(invite.email),
        email: normalizeEmail(invite.email),
        avatar: "",
        role: invite.role,
        accessType: invite.accessType,
        accessLabel:
          invite.accessType === "full_access" ? "Full Access" : "Limited Access",
        status: "pending",
        expiresAt: invite.expiresAt,
        inviteType: invite.inviteType,
      }));
    }

    const items = [...acceptedItems, ...pendingItems];

    return res.status(200).json({
      success: true,
      message: "Workspace members fetched successfully",
      data: {
        totalCount: items.length,
        acceptedCount: acceptedItems.length,
        pendingCount: pendingItems.length,
        members: items,
      },
    });
  } catch (error) {
    console.error("[getWorkspaceMembers]", error);

    return res.status(error.statusCode || 500).json({
      success: false,
      message: error?.message || "Failed to fetch workspace members",
    });
  }
}

async function updateWorkspaceMemberAccess(req, res) {
  try {
    const userId = getAuthedUserId(req);
    const workspaceId = clean(req.params?.workspaceId);
    const memberId = clean(req.params?.memberId);
    const accessType = clean(req.body?.accessType || "full_access");
    const role = clean(req.body?.role || "admin");
    const customPermissions = req.body?.permissions || {};

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Authentication is required",
      });
    }

    if (
      !mongoose.Types.ObjectId.isValid(workspaceId) ||
      !mongoose.Types.ObjectId.isValid(memberId)
    ) {
      return res.status(400).json({
        success: false,
        message: "Valid workspaceId and memberId are required",
      });
    }

    if (!["full_access", "limited_access"].includes(accessType)) {
      return res.status(400).json({
        success: false,
        message: "Invalid accessType",
      });
    }

    const requester = await getMembershipOr403({ workspaceId, userId });

    if (
      !(
        requester.role === "owner" ||
        requester.permissions?.team?.changeRole === true
      )
    ) {
      return res.status(403).json({
        success: false,
        message: "You cannot change member access",
      });
    }

    const member = await WorkspaceMemberModel.findOne({
      _id: memberId,
      workspaceId,
      status: { $ne: "removed" },
    });

    if (!member) {
      return res.status(404).json({
        success: false,
        message: "Member not found",
      });
    }

    if (member.role === "owner") {
      return res.status(400).json({
        success: false,
        message: "Owner access cannot be changed here",
      });
    }

    member.accessType = accessType;
    member.role = role === "owner" ? member.role : role;
    member.permissions = permissionsForAccessType(accessType, customPermissions);

    await member.save();

    await WorkspaceActivityModel.create({
      workspaceId,
      brandId: member.brandId,
      action: "MEMBER_ACCESS_UPDATED",
      module: "team",
      performedBy: userId,
      performedRole: requester.role,
      message: `${member.email || member.userId} access updated to ${accessType}`,
      metadata: {
        memberId,
        accessType,
        role: member.role,
      },
    });

    return res.status(200).json({
      success: true,
      message: "Member access updated successfully",
      data: {
        memberId: String(member._id),
        workspaceId: String(member.workspaceId),
        role: member.role,
        accessType: member.accessType,
        permissions: member.permissions,
      },
    });
  } catch (error) {
    console.error("[updateWorkspaceMemberAccess]", error);

    return res.status(error.statusCode || 500).json({
      success: false,
      message: error?.message || "Failed to update member access",
    });
  }
}

async function removeWorkspaceMember(req, res) {
  try {
    const userId = getAuthedUserId(req);
    const workspaceId = clean(req.params?.workspaceId);
    const memberId = clean(req.params?.memberId);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Authentication is required",
      });
    }

    if (
      !mongoose.Types.ObjectId.isValid(workspaceId) ||
      !mongoose.Types.ObjectId.isValid(memberId)
    ) {
      return res.status(400).json({
        success: false,
        message: "Valid workspaceId and memberId are required",
      });
    }

    const requester = await getMembershipOr403({ workspaceId, userId });

    if (
      !(
        requester.role === "owner" ||
        requester.permissions?.team?.remove === true
      )
    ) {
      return res.status(403).json({
        success: false,
        message: "You cannot remove members",
      });
    }

    const member = await WorkspaceMemberModel.findOne({
      _id: memberId,
      workspaceId,
    });

    if (!member) {
      return res.status(404).json({
        success: false,
        message: "Member not found",
      });
    }

    if (member.role === "owner") {
      return res.status(400).json({
        success: false,
        message: "Owner cannot be removed",
      });
    }

    member.status = "removed";

    await member.save();

    await WorkspaceActivityModel.create({
      workspaceId,
      brandId: member.brandId,
      action: "MEMBER_REMOVED",
      module: "team",
      performedBy: userId,
      performedRole: requester.role,
      message: `${member.email || member.userId} removed from workspace`,
      metadata: {
        memberId,
      },
    });

    return res.status(200).json({
      success: true,
      message: "Member removed successfully",
    });
  } catch (error) {
    console.error("[removeWorkspaceMember]", error);

    return res.status(error.statusCode || 500).json({
      success: false,
      message: error?.message || "Failed to remove member",
    });
  }
}

async function leaveWorkspace(req, res) {
  try {
    const userId = getAuthedUserId(req);
    const workspaceId = clean(req.params?.workspaceId);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Authentication is required",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(workspaceId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid workspaceId",
      });
    }

    const member = await WorkspaceMemberModel.findOne({
      workspaceId,
      userId,
      status: "accepted",
    });

    if (!member) {
      return res.status(404).json({
        success: false,
        message: "Workspace membership not found",
      });
    }

    if (member.role === "owner") {
      return res.status(400).json({
        success: false,
        message:
          "Owner cannot leave their own workspace. Delete workspace or transfer ownership first.",
      });
    }

    member.status = "removed";

    await member.save();

    await WorkspaceActivityModel.create({
      workspaceId,
      brandId: member.brandId,
      action: "MEMBER_LEFT",
      module: "team",
      performedBy: userId,
      performedRole: member.role,
      message: `${member.email || userId} left workspace`,
      metadata: {},
    });

    return res.status(200).json({
      success: true,
      message: "Workspace left successfully",
    });
  } catch (error) {
    console.error("[leaveWorkspace]", error);

    return res.status(error.statusCode || 500).json({
      success: false,
      message: error?.message || "Failed to leave workspace",
    });
  }
}

async function deleteWorkspace(req, res) {
  try {
    const userId = getAuthedUserId(req);
    const workspaceId = clean(req.params?.workspaceId);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Authentication is required",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(workspaceId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid workspaceId",
      });
    }

    const membership = await getMembershipOr403({ workspaceId, userId });

    if (!canManageWorkspace(membership) || membership.role !== "owner") {
      return res.status(403).json({
        success: false,
        message: "Only workspace owner can delete workspace",
      });
    }

    const workspace = await WorkspaceModel.findOneAndUpdate(
      {
        _id: workspaceId,
        status: { $ne: "deleted" },
      },
      {
        $set: {
          status: "deleted",
          deletedAt: new Date(),
        },
      },
      {
        new: true,
      }
    ).lean();

    if (!workspace) {
      return res.status(404).json({
        success: false,
        message: "Workspace not found",
      });
    }

    await WorkspaceMemberModel.updateMany(
      { workspaceId },
      { $set: { status: "removed" } }
    ).exec();

    await WorkspaceInvitationModel.updateMany(
      { workspaceId, status: "pending" },
      { $set: { status: "cancelled" } }
    ).exec();

    await WorkspaceActivityModel.create({
      workspaceId,
      brandId: String(workspace.brandId || userId),
      action: "WORKSPACE_DELETED",
      module: "workspace",
      performedBy: userId,
      performedRole: membership.role,
      message: "Workspace deleted",
      metadata: {},
    });

    return res.status(200).json({
      success: true,
      message: "Workspace deleted successfully",
    });
  } catch (error) {
    console.error("[deleteWorkspace]", error);

    return res.status(error.statusCode || 500).json({
      success: false,
      message: error?.message || "Failed to delete workspace",
    });
  }
}

module.exports = {
  getMyWorkspaces,
  createWorkspace,
  getWorkspaceById,
  getWorkspaceMembers,
  updateWorkspaceMemberAccess,
  removeWorkspaceMember,
  leaveWorkspace,
  deleteWorkspace,
};