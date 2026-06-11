const crypto = require("crypto");
const mongoose = require("mongoose");

const WorkspaceModelImport = require("../models/workspace");
const WorkspaceMemberModelImport = require("../models/workspaceMember");
const WorkspaceInvitationModelImport = require("../models/workspaceInvitation");
const WorkspaceActivityModelImport = require("../models/workspaceActivity");
const BrandModelImport = require("../models/brand");
const { getBrandRealEmail } = require("../utils/workspaceBrandClone");

let EmailServiceImport = null;

try {
  EmailServiceImport = require("../services/emailService");
} catch {
  EmailServiceImport = null;
}

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

const sendEmail =
  EmailServiceImport?.sendEmail ||
  EmailServiceImport?.default ||
  EmailServiceImport;

const INVITATION_EXPIRE_DAYS = Number(
  process.env.WORKSPACE_INVITE_EXPIRE_DAYS || 7
);

function safeTrim(value) {
  return String(value || "").trim();
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function getFrontendUrl() {
  return String(process.env.FRONTEND_URL || "http://localhost:3000").replace(
    /\/+$/,
    ""
  );
}

function getAuthedUserId(req) {
  return safeTrim(
    req.user?.userId ||
      req.user?.rootBrandId ||
      req.user?.loginBrandId ||
      req.user?._id ||
      req.user?.id ||
      req.brand?._id ||
      req.brand?.id ||
      req.auth?.userId ||
      req.auth?.brandId ||
      req.user?.brandId
  );
}

function getAuthedEmail(req) {
  return normalizeEmail(
    req.user?.email ||
      req.user?.brandRealEmail ||
      req.brand?.email ||
      req.brand?.brandRealEmail ||
      req.auth?.email ||
      req.body?.email
  );
}

function getWorkspaceIdFromReq(req) {
  return safeTrim(req.params?.workspaceId || req.body?.workspaceId);
}

function getWorkspacePublicId(workspace) {
  return safeTrim(workspace?._id || workspace?.workspaceId || workspace?.id);
}

function buildInviteLink(token) {
  return `${getFrontendUrl()}/brand/settings/workspace?inviteToken=${encodeURIComponent(
    token
  )}`;
}

function buildFullAccessPermissions() {
  return {
    campaigns: {
      view: true,
      create: true,
      update: true,
      delete: true,
    },
    influencers: {
      view: true,
      manage: true,
    },
    contracts: {
      view: true,
      create: true,
      update: true,
      approve: true,
    },
    deliverables: {
      view: true,
      review: true,
      approve: true,
    },
    payments: {
      view: true,
      manage: true,
      approve: true,
    },
    reports: {
      view: true,
    },
    team: {
      view: true,
      invite: true,
      remove: true,
      changeRole: true,
    },
    settings: {
      view: true,
      update: true,
    },
  };
}

function buildLimitedAccessPermissions(input = {}) {
  return {
    campaigns: {
      view: Boolean(input?.campaigns?.view),
      create: Boolean(input?.campaigns?.create),
      update: Boolean(input?.campaigns?.update),
      delete: Boolean(input?.campaigns?.delete),
    },
    influencers: {
      view: Boolean(input?.influencers?.view),
      manage: Boolean(input?.influencers?.manage),
    },
    contracts: {
      view: Boolean(input?.contracts?.view),
      create: Boolean(input?.contracts?.create),
      update: Boolean(input?.contracts?.update),
      approve: Boolean(input?.contracts?.approve),
    },
    deliverables: {
      view: Boolean(input?.deliverables?.view),
      review: Boolean(input?.deliverables?.review),
      approve: Boolean(input?.deliverables?.approve),
    },
    payments: {
      view: Boolean(input?.payments?.view),
      manage: Boolean(input?.payments?.manage),
      approve: Boolean(input?.payments?.approve),
    },
    reports: {
      view: Boolean(input?.reports?.view),
    },
    team: {
      view: Boolean(input?.team?.view),
      invite: Boolean(input?.team?.invite),
      remove: Boolean(input?.team?.remove),
      changeRole: Boolean(input?.team?.changeRole),
    },
    settings: {
      view: Boolean(input?.settings?.view),
      update: Boolean(input?.settings?.update),
    },
  };
}

function getPermissionsByAccessType(accessType, permissions) {
  if (accessType === "limited_access") {
    return buildLimitedAccessPermissions(permissions || {});
  }

  return buildFullAccessPermissions();
}

function normalizeRole(role, accessType) {
  const raw = safeTrim(role).toLowerCase();

  const allowed = [
    "admin",
    "marketing_manager",
    "campaign_manager",
    "finance_manager",
    "content_reviewer",
    "viewer",
    "agency_member",
  ];

  if (allowed.includes(raw)) return raw;

  return accessType === "full_access" ? "admin" : "viewer";
}

function normalizeAccessType(accessType) {
  const raw = safeTrim(accessType).toLowerCase();

  if (raw === "limited_access") return "limited_access";

  return "full_access";
}

async function sendInvitationEmail({ to, workspaceName, inviteLink }) {
  if (typeof sendEmail !== "function") return false;

  const subject = `You are invited to ${workspaceName}`;

  const text = `You have been invited to join ${workspaceName}. Open this link to review the invitation: ${inviteLink}`;

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5;">
      <h2>You are invited to ${workspaceName}</h2>
      <p>You have been invited to join this workspace on CollabGlam.</p>
      <p>
        <a href="${inviteLink}" style="display:inline-block;padding:10px 16px;background:#1a1a1a;color:#fff;text-decoration:none;border-radius:8px;">
          Review Invitation
        </a>
      </p>
      <p>If the button does not work, copy this link:</p>
      <p>${inviteLink}</p>
    </div>
  `;

  await sendEmail({
    to,
    subject,
    text,
    html,
  });

  return true;
}

async function getWorkspaceOrThrow(workspaceId) {
  if (!workspaceId || !mongoose.Types.ObjectId.isValid(workspaceId)) {
    const error = new Error("Valid workspaceId is required.");
    error.statusCode = 400;
    throw error;
  }

  const workspace = await WorkspaceModel.findById(workspaceId).lean();

  if (!workspace || workspace.status !== "active") {
    const error = new Error("Active workspace not found.");
    error.statusCode = 404;
    throw error;
  }

  return workspace;
}

async function assertCanInvite({ workspaceId, userId }) {
  const member = await WorkspaceMemberModel.findOne({
    workspaceId,
    userId,
    status: "accepted",
  }).lean();

  if (!member) {
    const error = new Error("You are not a member of this workspace.");
    error.statusCode = 403;
    throw error;
  }

  const isOwner = member.role === "owner";
  const canInvite = member.permissions?.team?.invite === true;

  if (!isOwner && !canInvite) {
    const error = new Error("You do not have permission to invite members.");
    error.statusCode = 403;
    throw error;
  }

  return member;
}

async function findExistingUserByEmail(email) {
  const user = await BrandModel.findOne({
    email: normalizeEmail(email),
    isWorkspaceBrand: { $ne: true },
  })
    .select("_id email brandRealEmail brandName name profilePic workspaceId")
    .lean();

  return user || null;
}

async function assertNotAlreadyMember({ workspaceId, email }) {
  const normalizedEmail = normalizeEmail(email);
  const existingUser = await findExistingUserByEmail(normalizedEmail);

  const memberOr = [{ email: normalizedEmail }];

  if (existingUser?._id) {
    memberOr.push({ userId: String(existingUser._id) });
  }

  const existingMember = await WorkspaceMemberModel.findOne({
    workspaceId,
    status: { $in: ["accepted", "pending"] },
    $or: memberOr,
  }).lean();

  if (existingMember) {
    const error = new Error("This user is already invited or already a member.");
    error.statusCode = 409;
    throw error;
  }

  return existingUser;
}

async function createWorkspaceInvitation({
  workspace,
  inviterId,
  inviterRole,
  email,
  role,
  accessType,
  permissions,
  sendMail = true,
}) {
  const workspaceId = getWorkspacePublicId(workspace);
  const brandId = safeTrim(workspace.brandId);
  const ownerBrandId = safeTrim(workspace.ownerBrandId || workspace.createdBy || workspace.brandId);
  const brandRealEmail = normalizeEmail(workspace.brandRealEmail || "");
  const workspaceName = safeTrim(workspace.name || "Workspace");

  await WorkspaceInvitationModel.updateMany(
    {
      workspaceId,
      email,
      status: "pending",
    },
    {
      $set: {
        status: "cancelled",
      },
    }
  ).exec();

  const token = crypto.randomBytes(32).toString("hex");
  const inviteLink = buildInviteLink(token);

  const invitation = await WorkspaceInvitationModel.create({
    workspaceId,
    brandId,
    ownerBrandId,
    workspaceBrandId: brandId,
    brandRealEmail,
    email,
    role,
    accessType,
    permissions,
    token,
    status: "pending",
    invitedBy: inviterId,
    expiresAt: new Date(
      Date.now() + INVITATION_EXPIRE_DAYS * 24 * 60 * 60 * 1000
    ),
  });

  let emailSent = false;

  if (sendMail) {
    try {
      emailSent = await sendInvitationEmail({
        to: email,
        workspaceName,
        inviteLink,
      });
    } catch {
      emailSent = false;
    }
  }

  await WorkspaceActivityModel.create({
    workspaceId,
    brandId,
    action: "MEMBER_INVITED",
    module: "team",
    performedBy: inviterId,
    performedRole: inviterRole || "member",
    message: `${email} invited to ${workspaceName}`,
    metadata: {
      invitationId: String(invitation._id),
      email,
      role,
      accessType,
      inviteLink,
      emailSent,
    },
  });

  return {
    invitation,
    inviteLink,
    emailSent,
  };
}

async function inviteWorkspaceMember(req, res) {
  try {
    const workspaceId = getWorkspaceIdFromReq(req);
    const inviterId = getAuthedUserId(req);

    const email = normalizeEmail(req.body?.email);
    const accessType = normalizeAccessType(req.body?.accessType);
    const role = normalizeRole(req.body?.role, accessType);
    const permissions = getPermissionsByAccessType(
      accessType,
      req.body?.permissions
    );

    if (!inviterId) {
      return res.status(401).json({
        success: false,
        message: "Authentication is required.",
      });
    }

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "Valid email is required.",
      });
    }

    const workspace = await getWorkspaceOrThrow(workspaceId);

    const inviterMember = await assertCanInvite({
      workspaceId,
      userId: inviterId,
    });

    await assertNotAlreadyMember({
      workspaceId,
      email,
    });

    const { invitation, inviteLink, emailSent } =
      await createWorkspaceInvitation({
        workspace,
        inviterId,
        inviterRole: inviterMember.role,
        email,
        role,
        accessType,
        permissions,
        sendMail: true,
      });

    return res.status(201).json({
      success: true,
      message: "Workspace invitation sent successfully.",
      data: {
        invitation: {
          _id: String(invitation._id),
          invitationId: String(invitation._id),
          workspaceId: invitation.workspaceId,
          brandId: invitation.brandId,
          ownerBrandId: invitation.ownerBrandId || "",
          workspaceBrandId: invitation.workspaceBrandId || invitation.brandId,
          brandRealEmail: invitation.brandRealEmail || "",
          email: invitation.email,
          role: invitation.role,
          accessType: invitation.accessType,
          status: invitation.status,
          expiresAt: invitation.expiresAt,
          inviteLink,
          emailSent,
        },
        inviteLink,
      },
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to invite workspace member.",
    });
  }
}

async function bulkInviteWorkspaceMembers(req, res) {
  try {
    const workspaceId = getWorkspaceIdFromReq(req);
    const inviterId = getAuthedUserId(req);
    const invites = Array.isArray(req.body?.invites) ? req.body.invites : [];

    if (!inviterId) {
      return res.status(401).json({
        success: false,
        message: "Authentication is required.",
      });
    }

    if (!invites.length) {
      return res.status(400).json({
        success: false,
        message: "At least one invite is required.",
      });
    }

    const workspace = await getWorkspaceOrThrow(workspaceId);

    const inviterMember = await assertCanInvite({
      workspaceId,
      userId: inviterId,
    });

    const created = [];
    const skipped = [];

    for (const item of invites) {
      const email = normalizeEmail(item?.email);
      const accessType = normalizeAccessType(item?.accessType);
      const role = normalizeRole(item?.role, accessType);
      const permissions = getPermissionsByAccessType(
        accessType,
        item?.permissions
      );

      try {
        if (!email || !isValidEmail(email)) {
          throw new Error("Valid email is required.");
        }

        await assertNotAlreadyMember({
          workspaceId,
          email,
        });

        const { invitation, inviteLink, emailSent } =
          await createWorkspaceInvitation({
            workspace,
            inviterId,
            inviterRole: inviterMember.role,
            email,
            role,
            accessType,
            permissions,
            sendMail: true,
          });

        created.push({
          invitationId: String(invitation._id),
          workspaceId: invitation.workspaceId,
          brandId: invitation.brandId,
          ownerBrandId: invitation.ownerBrandId || "",
          workspaceBrandId: invitation.workspaceBrandId || invitation.brandId,
          brandRealEmail: invitation.brandRealEmail || "",
          email: invitation.email,
          role: invitation.role,
          accessType: invitation.accessType,
          status: invitation.status,
          expiresAt: invitation.expiresAt,
          inviteLink,
          emailSent,
        });
      } catch (error) {
        skipped.push({
          email: email || safeTrim(item?.email),
          reason: error.message || "Failed to invite.",
        });
      }
    }

    return res.status(201).json({
      success: true,
      message: "Bulk workspace invitations processed.",
      data: {
        created,
        skipped,
        createdCount: created.length,
        skippedCount: skipped.length,
      },
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to send invitations.",
    });
  }
}

async function getWorkspaceInvitation(req, res) {
  try {
    const token = safeTrim(req.params?.token || req.query?.token);

    if (!token) {
      return res.status(400).json({
        success: false,
        message: "Invitation token is required.",
      });
    }

    const invitation = await WorkspaceInvitationModel.findOne({
      token,
    }).lean();

    if (!invitation) {
      return res.status(404).json({
        success: false,
        message: "Invitation not found.",
      });
    }

    const isExpired =
      invitation.expiresAt &&
      new Date(invitation.expiresAt).getTime() < Date.now();

    if (isExpired && invitation.status === "pending") {
      await WorkspaceInvitationModel.updateOne(
        { _id: invitation._id },
        { $set: { status: "expired" } }
      ).exec();

      invitation.status = "expired";
    }

    const workspace = await WorkspaceModel.findById(invitation.workspaceId)
      .lean()
      .catch(() => null);

    const existingUser = await findExistingUserByEmail(invitation.email);

    return res.status(200).json({
      success: true,
      message: "Workspace invitation fetched successfully.",
      data: {
        invitation: {
          _id: String(invitation._id),
          invitationId: String(invitation._id),
          workspaceId: invitation.workspaceId,
          brandId: invitation.brandId,
          ownerBrandId: invitation.ownerBrandId || "",
          workspaceBrandId: invitation.workspaceBrandId || invitation.brandId,
          brandRealEmail: invitation.brandRealEmail || "",
          email: invitation.email,
          role: invitation.role,
          accessType: invitation.accessType,
          status: invitation.status,
          expiresAt: invitation.expiresAt,
          workspaceName: workspace?.name || "Workspace",
          workspaceLogo: workspace?.logo || "",
          inviteLink: buildInviteLink(token),
        },
        accountExists: Boolean(existingUser),
      },
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to fetch invitation.",
    });
  }
}

async function acceptWorkspaceInvitationForUser({ token, userId, userEmail }) {
  const cleanToken = safeTrim(token);
  const cleanUserId = safeTrim(userId);
  const cleanEmail = normalizeEmail(userEmail);

  if (!cleanToken) {
    const error = new Error("Invitation token is required.");
    error.statusCode = 400;
    throw error;
  }

  if (!cleanUserId || !cleanEmail) {
    const error = new Error("User details are required to accept invitation.");
    error.statusCode = 401;
    throw error;
  }

  const invitation = await WorkspaceInvitationModel.findOne({
    token: cleanToken,
    status: "pending",
  });

  if (!invitation) {
    const error = new Error("Invitation not found or already used.");
    error.statusCode = 404;
    throw error;
  }

  if (new Date(invitation.expiresAt).getTime() < Date.now()) {
    invitation.status = "expired";
    await invitation.save();

    const error = new Error("Invitation expired.");
    error.statusCode = 400;
    throw error;
  }

  if (normalizeEmail(invitation.email) !== cleanEmail) {
    const error = new Error("This invitation belongs to another email.");
    error.statusCode = 403;
    throw error;
  }

  const workspace = await WorkspaceModel.findById(invitation.workspaceId).lean();

  if (!workspace || workspace.status !== "active") {
    const error = new Error("Workspace is not active.");
    error.statusCode = 404;
    throw error;
  }

  const existingMember = await WorkspaceMemberModel.findOne({
    workspaceId: invitation.workspaceId,
    userId: cleanUserId,
  });

  let member;

  if (existingMember) {
    existingMember.email = invitation.email;
    existingMember.brandId = invitation.brandId;
    existingMember.rootBrandId = cleanUserId;
    existingMember.workspaceBrandId = invitation.workspaceBrandId || invitation.brandId;
    existingMember.brandRealEmail = cleanEmail;
    existingMember.role = invitation.role;
    existingMember.accessType = invitation.accessType;
    existingMember.permissions = invitation.permissions;
    existingMember.status = "accepted";
    existingMember.invitedBy = invitation.invitedBy;
    existingMember.joinedAt = existingMember.joinedAt || new Date();

    member = await existingMember.save();
  } else {
    member = await WorkspaceMemberModel.create({
      workspaceId: invitation.workspaceId,
      brandId: invitation.brandId,
      rootBrandId: cleanUserId,
      workspaceBrandId: invitation.workspaceBrandId || invitation.brandId,
      brandRealEmail: cleanEmail,
      userId: cleanUserId,
      email: invitation.email,
      role: invitation.role,
      accessType: invitation.accessType,
      permissions: invitation.permissions,
      status: "accepted",
      invitedBy: invitation.invitedBy,
      joinedAt: new Date(),
    });
  }

  invitation.status = "accepted";
  invitation.acceptedBy = cleanUserId;
  invitation.acceptedAt = new Date();

  await invitation.save();

  await WorkspaceActivityModel.create({
    workspaceId: invitation.workspaceId,
    brandId: invitation.brandId,
    action: "INVITATION_ACCEPTED",
    module: "team",
    performedBy: cleanUserId,
    performedRole: invitation.role,
    message: `${invitation.email} accepted workspace invitation`,
    metadata: {
      invitationId: String(invitation._id),
      memberId: String(member._id),
      role: invitation.role,
      accessType: invitation.accessType,
    },
  });

  return {
    invitation,
    member,
    workspace,
  };
}

async function acceptWorkspaceInvitation(req, res) {
  try {
    const token = safeTrim(req.params?.token || req.body?.token);
    const userId = getAuthedUserId(req);
    const userEmail = getAuthedEmail(req);

    if (!userId || !userEmail) {
      return res.status(401).json({
        success: false,
        message: "Please login or signup before accepting invitation.",
      });
    }

    const { invitation, member, workspace } =
      await acceptWorkspaceInvitationForUser({
        token,
        userId,
        userEmail,
      });

    return res.status(200).json({
      success: true,
      message: "Workspace invitation accepted successfully.",
      data: {
        workspace: {
          _id: String(workspace._id),
          workspaceId: String(workspace._id),
          brandId: workspace.brandId,
          ownerBrandId: workspace.ownerBrandId || workspace.createdBy || "",
          workspaceBrandId: workspace.brandId,
          brandRealEmail: workspace.brandRealEmail || "",
          name: workspace.name,
          slug: workspace.slug,
          logo: workspace.logo || "",
          status: workspace.status,
          role: member.role,
          accessType: member.accessType,
          permissions: member.permissions,
        },
        member: {
          _id: String(member._id),
          memberId: String(member._id),
          workspaceId: member.workspaceId,
          brandId: member.brandId,
          rootBrandId: member.rootBrandId || member.userId,
          workspaceBrandId: member.workspaceBrandId || member.brandId,
          brandRealEmail: member.brandRealEmail || member.email,
          userId: member.userId,
          email: member.email,
          role: member.role,
          accessType: member.accessType,
          status: member.status,
          permissions: member.permissions,
        },
        invitation: {
          _id: String(invitation._id),
          invitationId: String(invitation._id),
          status: invitation.status,
          acceptedAt: invitation.acceptedAt,
        },
      },
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to accept invitation.",
    });
  }
}

async function rejectWorkspaceInvitation(req, res) {
  try {
    const token = safeTrim(req.params?.token || req.body?.token);

    if (!token) {
      return res.status(400).json({
        success: false,
        message: "Invitation token is required.",
      });
    }

    const invitation = await WorkspaceInvitationModel.findOne({
      token,
      status: "pending",
    });

    if (!invitation) {
      return res.status(404).json({
        success: false,
        message: "Invitation not found or already used.",
      });
    }

    invitation.status = "cancelled";
    invitation.acceptedAt = null;
    invitation.acceptedBy = "";

    await invitation.save();

    await WorkspaceActivityModel.create({
      workspaceId: invitation.workspaceId,
      brandId: invitation.brandId,
      action: "INVITATION_REJECTED",
      module: "team",
      performedBy: invitation.email,
      performedRole: invitation.role || "member",
      message: `${invitation.email} rejected workspace invitation`,
      metadata: {
        invitationId: String(invitation._id),
        email: invitation.email,
        role: invitation.role,
        accessType: invitation.accessType,
      },
    });

    return res.status(200).json({
      success: true,
      message: "Workspace invitation rejected successfully.",
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to reject invitation.",
    });
  }
}

module.exports = {
  inviteWorkspaceMember,
  bulkInviteWorkspaceMembers,
  getWorkspaceInvitation,
  acceptWorkspaceInvitation,
  acceptWorkspaceInvitationForUser,
  rejectWorkspaceInvitation,
  buildFullAccessPermissions,
};