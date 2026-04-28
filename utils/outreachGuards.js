const mongoose = require("mongoose");
const { AdminModel, ROLES } = require("../models/master");

async function validateOutreachTeam({ sdrId, RHId, bmeId }) {
  if (!mongoose.isValidObjectId(String(sdrId || ""))) {
    throw new Error("Valid sdrId is required");
  }

  if (!mongoose.isValidObjectId(String(RHId || ""))) {
    throw new Error("Valid RHId is required");
  }

  if (!mongoose.isValidObjectId(String(bmeId || ""))) {
    throw new Error("Valid assignedBmeId is required");
  }

  const [rh, sdr, bme] = await Promise.all([
    AdminModel.findOne({ _id: RHId, role: ROLES.REVENUE_HEAD, status: "active" }).select("_id"),
    AdminModel.findOne({ _id: sdrId, role: ROLES.SDR, status: "active" }).select("_id parentAdmin"),
    AdminModel.findOne({ _id: bmeId, role: ROLES.BME, status: "active" }).select("_id parentAdmin"),
  ]);

  if (!rh) throw new Error("Assigned RH not found or inactive");
  if (!sdr) throw new Error("Assigned SDR not found or inactive");
  if (!bme) throw new Error("Assigned BME not found or inactive");

  if (String(sdr.parentAdmin || "") !== String(RHId)) {
    throw new Error("Selected SDR does not belong to the assigned RH");
  }

  if (String(bme.parentAdmin || "") !== String(RHId)) {
    throw new Error("Selected BME does not belong to the assigned RH");
  }

  return true;
}

function ensureRole(actor, roles = []) {
  const role = String(actor?.role || "").trim().toLowerCase();
  if (!roles.includes(role)) {
    const err = new Error("Forbidden");
    err.statusCode = 403;
    throw err;
  }
}

module.exports = {
  validateOutreachTeam,
  ensureRole,
};