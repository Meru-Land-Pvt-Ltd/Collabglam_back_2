"use strict";

const createSignatureAssetModel = require("./signatureAssetFactory");

module.exports = createSignatureAssetModel({
  modelName: "InfluencerSignature",
  ownerField: "influencerId",
  collection: "influencersignatures",
});
