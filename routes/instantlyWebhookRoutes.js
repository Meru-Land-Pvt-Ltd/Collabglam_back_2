const router = require("express").Router();
const { handleInstantlyWebhook } = require("../controllers/instantlyWebhookController");

router.post("/", handleInstantlyWebhook);

module.exports = router;