"use strict";

const BrandSignature = require("../models/brandSignature");

const MAX_ACTIVE_BRAND_SIGNATURES = 3;

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
        brandId: row.brandId,
        name: row.name || "Brand Signature",
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

async function listBrandSignatures(req, res, next) {
    try {
        const brandId = String(req.params.brandId || req.query.brandId || "").trim();

        if (!brandId) {
            return res.status(400).json({ message: "brandId is required." });
        }

        const signatures = await BrandSignature.find({
            brandId,
            status: "active",
        })
            .sort({ isPrimary: -1, updatedAt: -1 })
            .limit(MAX_ACTIVE_BRAND_SIGNATURES);

        return res.json({
            max: MAX_ACTIVE_BRAND_SIGNATURES,
            count: signatures.length,
            signatures: signatures.map(serializeSignature),
        });
    } catch (error) {
        next(error);
    }
}

async function getPrimaryBrandSignature(req, res, next) {
    try {
        const brandId = String(req.params.brandId || req.query.brandId || "").trim();

        if (!brandId) {
            return res.status(400).json({ message: "brandId is required." });
        }

        const signature = await BrandSignature.findActive(brandId);

        if (!signature) {
            return res.status(404).json({ message: "Active brand signature not found." });
        }

        return res.json(serializeSignature(signature));
    } catch (error) {
        next(error);
    }
}

async function createBrandSignature(req, res, next) {
    try {
        const brandId = String(req.params.brandId || req.body.brandId || "").trim();
        const name = String(req.body.name || "").trim();
        const remarks = String(req.body.remarks || "").trim();
        const isPrimary = toBool(req.body.isPrimary);
        const byUserId = String(req.user?._id || req.body.byUserId || "").trim();

        if (!brandId) {
            return res.status(400).json({ message: "brandId is required." });
        }

        if (!name) {
            return res.status(400).json({ message: "Signature name is required." });
        }

        const activeCount = await BrandSignature.countDocuments({
            brandId,
            status: "active",
        });

        if (activeCount >= MAX_ACTIVE_BRAND_SIGNATURES) {
            return res.status(400).json({
                message: "Max 3 brand signatures can be added.",
            });
        }

        const signatureDataUrl = req.body.signature || fileToDataUrl(req.file);

        if (!signatureDataUrl) {
            return res.status(400).json({ message: "Signature file is required." });
        }

        const signature = await BrandSignature.create({
            brandId,
            name,
            remarks,
            signature: signatureDataUrl,
            originalName: req.file?.originalname || req.body.originalName || "",
            isPrimary: false,
            createdBy: byUserId,
            updatedBy: byUserId,
        });

        const shouldMakePrimary = isPrimary || activeCount === 0;

        const finalSignature = shouldMakePrimary
            ? await BrandSignature.setPrimary(brandId, signature._id, byUserId)
            : signature;

        return res.status(201).json({
            message: "Brand signature saved successfully.",
            signature: serializeSignature(finalSignature),
        });
    } catch (error) {
        next(error);
    }
}

async function setPrimaryBrandSignature(req, res, next) {
    try {
        const brandId = String(req.params.brandId || "").trim();
        const signatureId = String(req.params.signatureId || "").trim();
        const byUserId = String(req.user?._id || req.body?.byUserId || "").trim();

        if (!brandId || !signatureId) {
            return res.status(400).json({
                message: "brandId and signatureId are required.",
            });
        }

        const signature = await BrandSignature.setPrimary(
            brandId,
            signatureId,
            byUserId
        );

        return res.json({
            message: "Primary brand signature updated.",
            signature: serializeSignature(signature),
        });
    } catch (error) {
        next(error);
    }
}

async function deleteBrandSignature(req, res, next) {
    try {
        const brandId = String(req.params.brandId || "").trim();
        const signatureId = String(req.params.signatureId || "").trim();
        const byUserId = String(req.user?._id || req.body?.byUserId || "").trim();

        if (!brandId || !signatureId) {
            return res.status(400).json({
                message: "brandId and signatureId are required.",
            });
        }

        const signature = await BrandSignature.findOne({
            _id: signatureId,
            brandId,
            status: "active",
        });

        if (!signature) {
            return res.status(404).json({
                message: "Brand signature not found.",
            });
        }

        const wasPrimary = Boolean(signature.isPrimary);

        signature.status = "inactive";
        signature.isPrimary = false;
        signature.updatedBy = byUserId;
        await signature.save();

        if (wasPrimary) {
            const nextPrimary = await BrandSignature.findOne({
                brandId,
                status: "active",
            }).sort({ updatedAt: -1 });

            if (nextPrimary) {
                await BrandSignature.setPrimary(brandId, nextPrimary._id, byUserId);
            }
        }

        return res.json({
            message: "Brand signature deleted successfully.",
        });
    } catch (error) {
        next(error);
    }
}

module.exports = {
    listBrandSignatures,
    getPrimaryBrandSignature,
    createBrandSignature,
    setPrimaryBrandSignature,
    deleteBrandSignature,
};