const mongoose = require("mongoose");

function clean(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return clean(value).toLowerCase();
}

function getBrandRealEmail(brand = {}) {
  return normalizeEmail(
    brand.brandRealEmail ||
      brand.realEmail ||
      brand.proxyEmail ||
      brand.email ||
      ""
  );
}

function buildWorkspaceInternalEmail(workspaceId) {
  return `workspace-${workspaceId}@workspace.local`.toLowerCase();
}

function buildWorkspaceProxyEmail(workspaceId) {
  return `workspace-proxy-${workspaceId}@workspace.local`.toLowerCase();
}

function copyIfExists(target, source, keys = []) {
  keys.forEach((key) => {
    if (source[key] !== undefined && source[key] !== null) {
      target[key] = source[key];
    }
  });

  return target;
}

async function getOrCreateWorkspaceBrand({
  BrandModel,
  mainBrand,
  workspace,
  workspaceName,
  logo,
}) {
  if (!BrandModel) {
    throw new Error("BrandModel is required");
  }

  if (!mainBrand?._id) {
    throw new Error("Main brand is required");
  }

  const workspaceId = String(
    workspace?._id || workspace?.workspaceId || workspace?.id || ""
  );

  if (!workspaceId || !mongoose.Types.ObjectId.isValid(workspaceId)) {
    throw new Error("Valid workspace id is required to create workspace brand");
  }

  const mainBrandId = String(mainBrand._id);
  const brandRealEmail = getBrandRealEmail(mainBrand);

  const existingWorkspaceBrand = await BrandModel.findOne({
    isWorkspaceBrand: true,
    primaryBrandId: mainBrandId,
    workspaceBrandFor: workspaceId,
  });

  const expectedEmail = buildWorkspaceInternalEmail(workspaceId);
  const expectedProxyEmail = buildWorkspaceProxyEmail(workspaceId);

  if (existingWorkspaceBrand) {
    let changed = false;

    if (!existingWorkspaceBrand.brandRealEmail && brandRealEmail) {
      existingWorkspaceBrand.brandRealEmail = brandRealEmail;
      changed = true;
    }

    if (existingWorkspaceBrand.email !== expectedEmail) {
      existingWorkspaceBrand.email = expectedEmail;
      changed = true;
    }

    if (existingWorkspaceBrand.proxyEmail !== expectedProxyEmail) {
      existingWorkspaceBrand.proxyEmail = expectedProxyEmail;
      changed = true;
    }

    if (workspaceName && existingWorkspaceBrand.brandName !== workspaceName) {
      existingWorkspaceBrand.brandName = workspaceName;
      existingWorkspaceBrand.name = workspaceName;
      changed = true;
    }

    if (logo !== undefined && existingWorkspaceBrand.profilePic !== logo) {
      existingWorkspaceBrand.profilePic = logo || "";
      changed = true;
    }

    if (changed) {
      await existingWorkspaceBrand.save();
    }

    return existingWorkspaceBrand;
  }

  const brandName =
    clean(workspaceName) ||
    clean(workspace?.name) ||
    clean(mainBrand.brandName) ||
    clean(mainBrand.name) ||
    "Workspace Brand";

  const payload = {
    email: expectedEmail,
    proxyEmail: expectedProxyEmail,
    brandRealEmail,

    brandName,
    name: brandName,
    profilePic: logo || workspace?.logo || mainBrand.profilePic || "",

    isWorkspaceBrand: true,
    primaryBrandId: mainBrandId,
    workspaceBrandFor: workspaceId,
    workspaceId,

    status: mainBrand.status || "active",
    isActive: mainBrand.isActive !== undefined ? mainBrand.isActive : true,
  };

  copyIfExists(payload, mainBrand, [
    "companySize",
    "website",
    "industry",
    "companyName",
    "companyDetails",
    "pocContact",
    "timeZone",
    "currencyFormat",
    "region",
    "preferredLanguage",
    "page1",
    "page2",
    "page3",
    "skipPage1",
    "skipPage2",
    "skipPage3",
    "subscription",
    "onboardingStatus",
    "role",
    "permissions",
  ]);

  return BrandModel.create(payload);
}

module.exports = {
  getBrandRealEmail,
  getOrCreateWorkspaceBrand,
  buildWorkspaceInternalEmail,
  buildWorkspaceProxyEmail,
};