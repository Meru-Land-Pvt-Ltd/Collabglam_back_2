const express = require("express");

const {
  getMyWorkspaces,
  createWorkspace,
  getWorkspaceById,
  getWorkspaceMembers,
  updateWorkspaceMemberAccess,
  removeWorkspaceMember,
  leaveWorkspace,
  deleteWorkspace,
} = require("../controllers/workspaceController");

const {
  inviteWorkspaceMember,
  bulkInviteWorkspaceMembers,
  getWorkspaceInvitation,
  acceptWorkspaceInvitation,
  rejectWorkspaceInvitation,
} = require("../controllers/workspaceInvitationController");

const { brandAuth } = require("../auth/brandAuth");

const router = express.Router();

/*
  Mount once in app.js:

  const workspaceRoutes = require("./routes/workspace.routes");
  app.use("/workspace", workspaceRoutes);
*/

router.get("/workspaces/my", brandAuth, getMyWorkspaces);
router.post("/workspaces", brandAuth, createWorkspace);
router.get("/workspaces/:workspaceId", brandAuth, getWorkspaceById);
router.delete("/workspaces/:workspaceId", brandAuth, deleteWorkspace);
router.post("/workspaces/:workspaceId/leave", brandAuth, leaveWorkspace);

router.get("/workspaces/:workspaceId/members", brandAuth, getWorkspaceMembers);

router.patch(
  "/workspaces/:workspaceId/members/:memberId/access",
  brandAuth,
  updateWorkspaceMemberAccess
);

router.delete(
  "/workspaces/:workspaceId/members/:memberId",
  brandAuth,
  removeWorkspaceMember
);

router.post(
  "/workspaces/:workspaceId/invitations",
  brandAuth,
  inviteWorkspaceMember
);

router.post(
  "/workspaces/:workspaceId/invitations/bulk",
  brandAuth,
  bulkInviteWorkspaceMembers
);

// Public preview is needed for email-link preview before login.
router.get("/workspace-invitations/:token", getWorkspaceInvitation);

// Accept needs login.
router.post(
  "/workspace-invitations/accept/:token",
  brandAuth,
  acceptWorkspaceInvitation
);

// Reject can be token-based and public.
router.post(
  "/workspace-invitations/reject/:token",
  rejectWorkspaceInvitation
);

module.exports = router;