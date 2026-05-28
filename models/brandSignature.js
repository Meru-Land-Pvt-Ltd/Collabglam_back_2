"use strict";

const createSignatureAssetModel = require("./signatureAssetFactory");

module.exports = createSignatureAssetModel({
  modelName: "BrandSignature",
  ownerField: "brandId",
  collection: "brandsignatures",
});
