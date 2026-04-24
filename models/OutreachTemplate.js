const { Schema, model } = require("mongoose");

const OutreachTemplateSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    category: { type: String, default: "custom_templates", trim: true },
    subject: { type: String, default: "" },
    body: { type: String, default: "" },
    createdBy: { type: Schema.Types.ObjectId, ref: "Master", default: null },
    workspaceId: { type: String, default: "default" },
    isSystem: { type: Boolean, default: false },
  },
  { timestamps: true }
);

OutreachTemplateSchema.index({ workspaceId: 1, category: 1, createdAt: -1 });
OutreachTemplateSchema.index({ workspaceId: 1, name: 1 });

module.exports = model("OutreachTemplate", OutreachTemplateSchema);