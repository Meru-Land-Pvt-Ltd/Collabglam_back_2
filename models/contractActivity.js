"use strict";

const mongoose = require("mongoose");
const { Schema } = mongoose;

const ContractActivitySchema = new Schema(
  {
    contractId: { type: String, required: true, index: true, trim: true },
    version: { type: Number, default: 0, index: true },
    type: { type: String, required: true, index: true, trim: true },
    role: { type: String, default: "system", index: true, trim: true },
    byUserId: { type: String, default: "", trim: true },
    editedFields: { type: [String], default: [] },
    details: { type: Schema.Types.Mixed, default: {} },
    snapshot: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

ContractActivitySchema.index({ contractId: 1, createdAt: -1 });
ContractActivitySchema.index({ contractId: 1, version: -1 });

module.exports = mongoose.models.ContractActivity || mongoose.model("ContractActivity", ContractActivitySchema);
