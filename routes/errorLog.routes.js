const express = require("express");
const router = express.Router();

const {
  getAllErrorLogs,
  updateErrorLogResolved,
  updateErrorLogPriority,
} = require("../controllers/errorLogController");

router.get("/", getAllErrorLogs);
router.patch("/:id/resolved", updateErrorLogResolved);
router.patch("/:id/priority", updateErrorLogPriority);

module.exports = router;