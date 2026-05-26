const express = require("express");
const router = express.Router();

const {
  getAllErrorLogs,
  getSingleErrorLog,
  deleteErrorLog,
  clearAllErrorLogs,
} = require("../controllers/errorLogController");

// Optional: add admin token middleware here
// const { verifyAdminToken } = require("../controllers/adminController");

// Get all error logs
router.get("/", getAllErrorLogs);

// Get single error log by MongoDB _id
router.get("/:id", getSingleErrorLog);

// Delete single error log
router.delete("/:id", deleteErrorLog);

// Clear all error logs
router.delete("/", clearAllErrorLogs);

module.exports = router;