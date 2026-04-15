const router = require("express").Router();
const { testInstantlyConnection } = require("../controllers/instantlyTestController");

router.get("/test-connection", testInstantlyConnection);

module.exports = router;