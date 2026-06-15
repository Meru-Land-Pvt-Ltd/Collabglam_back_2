const express = require("express");

const router = express.Router();

const brandAuth = require("../auth/brandAuth");
const brandMemberController = require("../controllers/brandMemberController");

const protectBrand =
  typeof brandAuth === "function"
    ? brandAuth
    : brandAuth.protectBrand || brandAuth.brandAuth || brandAuth.authBrand;

const {
  getMyWorkspaces,
  listMembers,
  getMemberInfo,
  inviteMember,
  previewInvite,
  acceptInvite,
  updateMemberAccess,
  removeMemberAccess,
  transferOwnership,
  getMyAccess,
} = brandMemberController;

if (typeof protectBrand !== "function") {
  throw new Error(
    "protectBrand middleware is not a function. Check ../auth/brandAuth export."
  );
}

if (typeof getMyWorkspaces !== "function") {
  throw new Error(
    "getMyWorkspaces controller is not a function. Check brandMemberController export."
  );
}

if (typeof transferOwnership !== "function") {
  throw new Error(
    "transferOwnership controller is not a function. Check brandMemberController export."
  );
}

router.get("/my-workspaces", protectBrand, getMyWorkspaces);

router.get("/invite/:token", previewInvite);

router.post("/invite/accept", protectBrand, acceptInvite);

router.get("/:brandId/members", protectBrand, listMembers);

router.get("/:brandId/members/my-access", protectBrand, getMyAccess);

router.get("/:brandId/members/:memberId", protectBrand, getMemberInfo);

router.post("/:brandId/members/invite", protectBrand, inviteMember);

router.post(
  "/:brandId/members/transfer-ownership",
  protectBrand,
  transferOwnership
);

router.patch(
  "/:brandId/members/:memberId/access",
  protectBrand,
  updateMemberAccess
);

router.delete(
  "/:brandId/members/:memberId",
  protectBrand,
  removeMemberAccess
);

module.exports = router;