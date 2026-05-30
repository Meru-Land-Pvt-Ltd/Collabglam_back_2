"use strict";

const ContractActivity = require("../models/contractActivity");

async function addActivity(contract, role, type, details = {}, snapshot = null) {
  const activity = await ContractActivity.create({
    contractId: contract.contractId,
    version: Number(contract.version || 0),
    type,
    role: role || "system",
    byUserId: details?.byUserId || "",
    editedFields: Array.isArray(details?.editedFields) ? details.editedFields : [],
    details,
    snapshot,
  });

  contract.lastActionAt = new Date();
  contract.lastActionByRole = role || "system";
  return activity;
}

module.exports = { addActivity };
