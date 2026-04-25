const router = require("express").Router();
const { handleInstantlyWebhook } = require("../controllers/instantlyWebhookController");

router.post("/instantly", handleInstantlyWebhook);

module.exports = router;