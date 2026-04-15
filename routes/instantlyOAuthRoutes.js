const router = require("express").Router();
const {
  initInstantlyGoogleOAuth,
  getInstantlyOAuthStatus,
} = require("../controllers/instantlyOAuthController");

router.post("/google/init", initInstantlyGoogleOAuth);
router.get("/session-status/:sessionId", getInstantlyOAuthStatus);

module.exports = router;