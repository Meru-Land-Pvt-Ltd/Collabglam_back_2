"use strict";

const ContractContent = require("../models/contractContent");
const ContractSignature = require("../models/contractSignature");
const ContractDocument = require("../models/contractDocument");

function signatureToLegacy(signature) {
  if (!signature) {
    return {
      signed: false,
      savedSignatureId: "",
      byUserId: "",
      name: "",
      email: "",
      at: null,
      sigImageDataUrl: "",
      sigImageBytes: 0,
    };
  }

  return {
    signed: Boolean(signature.signed),
    savedSignatureId: signature.savedSignatureId || "",
    byUserId: signature.byUserId || "",
    name: signature.name || "",
    email: signature.email || "",
    at: signature.signedAt || null,
    sigImageDataUrl: signature.signatureDataUrl || "",
    sigImageBytes: signature.sizeBytes || 0,
  };
}

function toPlain(doc) {
  return doc?.toObject ? doc.toObject({ flattenMaps: true }) : doc;
}

async function hydrateContract(contractDoc) {
  if (!contractDoc) return null;

  const contract = toPlain(contractDoc);

  const [contentDoc, documentDoc, signatures] = await Promise.all([
    ContractContent.findOne({ contractId: contract.contractId }),
    ContractDocument.findOne({ contractId: contract.contractId }),
    ContractSignature.find({ contractId: contract.contractId }).lean(),
  ]);

  const signatureByRole = signatures.reduce((acc, row) => {
    acc[row.role] = row;
    return acc;
  }, {});

  contract.content = contentDoc ? contentDoc.toLegacyContent() : {};
  contract.other = contentDoc?.other || {};
  contract.admin = documentDoc ? documentDoc.toLegacyAdmin() : {};

  contract.signatures = {
    brand: signatureToLegacy(signatureByRole.brand),
    influencer: signatureToLegacy(signatureByRole.influencer),
    collabglam: signatureToLegacy(signatureByRole.collabglam),
  };

  contract.signatureBrand = contract.signatures.brand.sigImageDataUrl;
  contract.signatureInfluencer = contract.signatures.influencer.sigImageDataUrl;

  contract.lastViewedAt = {
    brand: contract.lastViewedByBrandAt || null,
    influencer: contract.lastViewedByInfluencerAt || null,
  };

  contract.templateVersion = documentDoc?.legalTemplateVersion || 1;
  contract.templateTokensSnapshot = documentDoc?.templateTokensSnapshot || null;
  contract.renderedTextSnapshot = documentDoc?.renderedTextSnapshot || "";
  contract.renderedHtmlSnapshot = documentDoc?.renderedHtmlSnapshot || "";

  return contract;
}

async function hydrateContracts(contractDocs = []) {
  return Promise.all((contractDocs || []).map((doc) => hydrateContract(doc)));
}

async function createOrUpdateContent({ contract, content, other = {} }) {
  return ContractContent.findOneAndUpdate(
    { contractId: contract.contractId },
    {
      $set: ContractContent.fromLegacyContent({
        contractId: contract.contractId,
        brandId: contract.brandId,
        influencerId: contract.influencerId,
        campaignId: contract.campaignId,
        content,
        other,
      }),
    },
    { upsert: true, new: true, runValidators: true }
  );
}

async function createOrUpdateDocument({ contract, admin = {}, templateText = "" }) {
  const legalTemplateText = admin.legalTemplateText || templateText || "";
  const legalTemplateVersion = admin.legalTemplateVersion || 1;

  return ContractDocument.findOneAndUpdate(
    { contractId: contract.contractId },
    {
      $set: {
        timezone: admin.timezone || "America/Los_Angeles",
        jurisdiction: admin.jurisdiction || "USA",
        arbitrationSeat: admin.arbitrationSeat || "San Francisco, CA",
        fxSource: admin.fxSource || "ECB",
        extraRevisionFee: Number(admin.extraRevisionFee || 0),
        escrowAMLFlags: admin.escrowAMLFlags || "",
        collabglamSignatoryName: admin.collabglamSignatoryName || "",
        collabglamSignatoryEmail: admin.collabglamSignatoryEmail || "",
        legalTemplateVersion,
        legalTemplateText,
      },
      $setOnInsert: {
        legalTemplateHistory:
          Array.isArray(admin.legalTemplateHistory) && admin.legalTemplateHistory.length
            ? admin.legalTemplateHistory
            : [
                {
                  version: legalTemplateVersion,
                  text: legalTemplateText,
                  updatedAt: new Date(),
                  updatedBy: admin.updatedBy || "system",
                },
              ],
      },
    },
    { upsert: true, new: true, runValidators: true }
  );
}

module.exports = {
  hydrateContract,
  hydrateContracts,
  createOrUpdateContent,
  createOrUpdateDocument,
  signatureToLegacy,
};
