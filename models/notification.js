// models/notification.js
const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const NotificationSchema = new mongoose.Schema(
  {
    notificationId: { type: String, required: true, default: uuidv4, index: true },

    // Exactly one recipient target must be present.
    brandId: { type: String, default: null, index: true },
    influencerId: { type: String, default: null, index: true },
    adminId: { type: String, default: null, index: true },

    type: { type: String, required: true },
    title: { type: String, required: true },
    message: { type: String, default: "" },

    entityType: { type: String, default: null },
    entityId: { type: String, default: null, index: true },

    actionPath: { type: String, default: null },

    // Optional: who performed the activity. This does not affect the XOR recipient rule.
    actorAdminId: { type: String, default: null, index: true },
    actorName: { type: String, default: "" },
    actorEmail: { type: String, default: "" },
    actorRole: { type: String, default: "" },

    isRead: { type: Boolean, default: false, index: true },
  },
  { timestamps: { createdAt: true, updatedAt: true } }
);

NotificationSchema.pre("validate", function (next) {
  const recipients = [this.brandId, this.influencerId, this.adminId].filter(
    (value) => value !== null && value !== undefined && String(value).trim() !== ""
  );

  if (recipients.length !== 1) {
    return next(
      new Error(
        "Notification must target exactly one recipient: brandId, influencerId, or adminId."
      )
    );
  }

  next();
});

NotificationSchema.index(
  { brandId: 1, influencerId: 1, adminId: 1, entityType: 1, entityId: 1, type: 1 },
  { unique: false }
);
NotificationSchema.index({ notificationId: 1, createdAt: -1 });
NotificationSchema.index({ actorAdminId: 1, createdAt: -1 });
NotificationSchema.index({ createdAt: -1 });

module.exports =
  mongoose.models.Notification || mongoose.model("Notification", NotificationSchema);
