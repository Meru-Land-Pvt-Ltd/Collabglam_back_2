const { ConversationThread, ConversationMessage } = require("../models/conversationThread");
const ProspectBrand = require("../models/prospectBrand");
const instantlyService = require("../services/instantlyService");
const { ensureRole } = require("../utils/outreachGuards");

exports.listBmeThreads = async (req, res) => {
  try {
    ensureRole(req.admin, ["bme", "super_admin", "revenue_head"]);

    let filter = {};
    if (req.admin.role === "bme") {
      filter.ownerId = req.admin.adminId;
      filter.ownerRole = "bme";
    }

    const rows = await ConversationThread.find(filter)
      .populate("prospectId", "companyName primaryContact stage")
      .sort({ updatedAt: -1 });

    return res.status(200).json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Internal error",
    });
  }
};

exports.getThreadMessages = async (req, res) => {
  try {
    ensureRole(req.admin, ["bme", "super_admin", "revenue_head"]);

    const thread = await ConversationThread.findById(req.params.threadId)
      .populate("prospectId", "companyName primaryContact stage");
    if (!thread) {
      return res.status(404).json({ success: false, message: "Thread not found" });
    }

    if (
      req.admin.role === "bme" &&
      String(thread.ownerId) !== String(req.admin.adminId)
    ) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const messages = await ConversationMessage.find({ threadId: thread._id }).sort({ createdAt: 1 });

    return res.status(200).json({ success: true, thread, messages });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Internal error",
    });
  }
};

exports.replyAsBme = async (req, res) => {
  try {
    ensureRole(req.admin, ["bme", "super_admin", "revenue_head"]);

    const { threadId } = req.params;
    const { bodyText, subject } = req.body;

    const thread = await ConversationThread.findById(threadId).populate("prospectId");
    if (!thread) {
      return res.status(404).json({ success: false, message: "Thread not found" });
    }

    if (
      req.admin.role === "bme" &&
      String(thread.ownerId) !== String(req.admin.adminId)
    ) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const replyPayload = {
      // Adjust to exact Instantly reply body schema from final docs.
      thread_id: thread.instantlyThreadId,
      subject: subject || thread.subject || "",
      body: bodyText,
    };

    const replyResponse = await instantlyService.replyToEmail(replyPayload);

    await ConversationMessage.create({
      threadId: thread._id,
      prospectId: thread.prospectId._id,
      direction: "outbound",
      provider: "instantly",
      providerMessageId: String(replyResponse?.id || ""),
      providerThreadId: thread.instantlyThreadId,
      from: "",
      to: [thread.brandEmail],
      subject: subject || thread.subject || "",
      bodyText,
      repliedByAdminId: req.admin.adminId,
      sentAt: new Date(),
    });

    thread.lastMessageAt = new Date();
    thread.lastOutboundAt = new Date();
    thread.unreadForBme = false;
    await thread.save();

    await ProspectBrand.findByIdAndUpdate(thread.prospectId._id, {
      $set: {
        currentOwnerRole: "bme",
        currentOwnerId: req.admin.adminId,
      },
    });

    return res.status(200).json({
      success: true,
      message: "Reply sent successfully",
      data: replyResponse,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Internal error",
    });
  }
};