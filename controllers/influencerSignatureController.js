"use strict";

const InfluencerSignature = require("../models/influencerSignature");

const MAX_ACTIVE_INFLUENCER_SIGNATURES = 3;

function toBool(value) {
  return value === true || value === "true" || value === "1" || value === 1;
}

function fileToDataUrl(file) {
  if (!file?.buffer || !file?.mimetype) return "";
  return `data:${file.mimetype};base64,${file.buffer.toString("base64")}`;
}

function serializeSignature(doc) {
  const row = doc?.toObject ? doc.toObject({ flattenMaps: true }) : doc;

  return {
    _id: String(row._id),
    influencerId: row.influencerId,
    name: row.name || "Influencer Signature",
    remarks: row.remarks || "",
    signature: row.signature || "",
    mimeType: row.mimeType || "",
    originalName: row.originalName || "",
    sizeBytes: row.sizeBytes || 0,
    isPrimary: Boolean(row.isPrimary),
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function listInfluencerSignatures(req, res, next) {
  try {
    const influencerId = String(req.params.influencerId || req.query.influencerId || "").trim();

    if (!influencerId) {
      return res.status(400).json({ message: "influencerId is required." });
    }

    const signatures = await InfluencerSignature.find({
      influencerId,
      status: "active",
    })
      .sort({ isPrimary: -1, updatedAt: -1 })
      .limit(MAX_ACTIVE_INFLUENCER_SIGNATURES);

    return res.json({
      max: MAX_ACTIVE_INFLUENCER_SIGNATURES,
      count: signatures.length,
      signatures: signatures.map(serializeSignature),
    });
  } catch (error) {
    next(error);
  }
}

async function getPrimaryInfluencerSignature(req, res, next) {
  try {
    const influencerId = String(req.params.influencerId || req.query.influencerId || "").trim();

    if (!influencerId) {
      return res.status(400).json({ message: "influencerId is required." });
    }

    const signature = await InfluencerSignature.findActive(influencerId);

    if (!signature) {
      return res.status(404).json({ message: "Active influencer signature not found." });
    }

    return res.json(serializeSignature(signature));
  } catch (error) {
    next(error);
  }
}

async function createInfluencerSignature(req, res, next) {
  try {
    const influencerId = String(req.params.influencerId || req.body?.influencerId || "").trim();
    const name = String(req.body?.name || "").trim();
    const remarks = String(req.body?.remarks || "").trim();
    const isPrimary = toBool(req.body?.isPrimary);
    const byUserId = String(req.user?._id || req.body?.byUserId || "").trim();

    if (!influencerId) {
      return res.status(400).json({ message: "influencerId is required." });
    }

    if (!name) {
      return res.status(400).json({ message: "Signature name is required." });
    }

    const activeCount = await InfluencerSignature.countDocuments({
      influencerId,
      status: "active",
    });

    if (activeCount >= MAX_ACTIVE_INFLUENCER_SIGNATURES) {
      return res.status(400).json({ message: "Max 3 influencer signatures can be added." });
    }

    const signatureDataUrl = req.body?.signature || fileToDataUrl(req.file);

    if (!signatureDataUrl) {
      return res.status(400).json({ message: "Signature file is required." });
    }

    const signature = await InfluencerSignature.create({
      influencerId,
      name,
      remarks,
      signature: signatureDataUrl,
      originalName: req.file?.originalname || req.body?.originalName || "",
      isPrimary: false,
      createdBy: byUserId,
      updatedBy: byUserId,
    });

    const shouldMakePrimary = isPrimary || activeCount === 0;
    const finalSignature = shouldMakePrimary
      ? await InfluencerSignature.setPrimary(influencerId, signature._id, byUserId)
      : signature;

    return res.status(201).json({
      message: "Influencer signature saved successfully.",
      signature: serializeSignature(finalSignature),
    });
  } catch (error) {
    next(error);
  }
}

async function setPrimaryInfluencerSignature(req, res, next) {
  try {
    const influencerId = String(req.params.influencerId || "").trim();
    const signatureId = String(req.params.signatureId || "").trim();
    const byUserId = String(req.user?._id || req.body?.byUserId || "").trim();

    if (!influencerId || !signatureId) {
      return res.status(400).json({ message: "influencerId and signatureId are required." });
    }

    const signature = await InfluencerSignature.setPrimary(influencerId, signatureId, byUserId);

    return res.json({
      message: "Primary influencer signature updated.",
      signature: serializeSignature(signature),
    });
  } catch (error) {
    next(error);
  }
}

async function deleteInfluencerSignature(req, res, next) {
  try {
    const influencerId = String(req.params.influencerId || "").trim();
    const signatureId = String(req.params.signatureId || "").trim();
    const byUserId = String(req.user?._id || req.body?.byUserId || "").trim();

    if (!influencerId || !signatureId) {
      return res.status(400).json({ message: "influencerId and signatureId are required." });
    }

    const signature = await InfluencerSignature.findOne({
      _id: signatureId,
      influencerId,
      status: "active",
    });

    if (!signature) {
      return res.status(404).json({ message: "Influencer signature not found." });
    }

    const wasPrimary = Boolean(signature.isPrimary);

    await InfluencerSignature.updateOne(
      { _id: signatureId, influencerId, status: "active" },
      {
        $set: {
          status: "inactive",
          isPrimary: false,
          updatedBy: byUserId,
        },
      },
      { runValidators: false }
    );

    if (wasPrimary) {
      const nextPrimary = await InfluencerSignature.findOne({
        influencerId,
        status: "active",
      }).sort({ updatedAt: -1 });

      if (nextPrimary) {
        await InfluencerSignature.setPrimary(influencerId, nextPrimary._id, byUserId);
      }
    }

    return res.json({ message: "Influencer signature deleted successfully." });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  listInfluencerSignatures,
  getPrimaryInfluencerSignature,
  createInfluencerSignature,
  setPrimaryInfluencerSignature,
  deleteInfluencerSignature,
};
