require("dotenv").config();
const mongoose = require("mongoose");

const SubscriptionPlan = require("../models/subscription");
const BrandModelImport = require("../models/brand");

const Brand =
    BrandModelImport.BrandModel || BrandModelImport.default || BrandModelImport;

const CANONICAL_KEY = "influencer_profile_views_per_month";

const OLD_KEYS = [
    "influencerProfileViews",
    "profileViews",
    "profile_views",
    "influencer_profile_views",
    "influencerAnalyticsReports",
    "influencer_analytics_reports",
    "analyticsReports",
    "analytics_reports",
    "reports",
];

const ALL_PROFILE_VIEW_KEYS = [CANONICAL_KEY, ...OLD_KEYS];

const PLAN_REPORT_LIMITS = {
    free: {
        value: 1,
        note: "1 Report / Month",
    },
    growth: {
        value: 10,
        note: "10 Reports / Month",
    },
    pro: {
        value: 25,
        note: "25 Reports / Month",
    },
    fully_managed: {
        value: { unlimited: true, fairUsage: true },
        note: "Unlimited (Fair Usage)",
    },
};

function clean(value) {
    return String(value || "").trim();
}

function normalizeKey(value) {
    return clean(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizePlanName(value = "") {
    const text = clean(value).toLowerCase();

    if (text.includes("fully")) return "fully_managed";
    if (text.includes("growth")) return "growth";
    if (text.includes("pro")) return "pro";

    return "free";
}

function isProfileViewsKey(key) {
    const normalized = normalizeKey(key);

    return ALL_PROFILE_VIEW_KEYS.some(
        (profileViewKey) => normalizeKey(profileViewKey) === normalized
    );
}

function featureValueToLimit(value) {
    if (typeof value === "number") return value;

    if (value && typeof value === "object") {
        if (value.unlimited === true) return -1;
        if (typeof value.limit === "number") return value.limit;
    }

    return 0;
}

function getUsedFromFeatures(features = []) {
    const matchedFeatures = features.filter((feature) =>
        isProfileViewsKey(feature?.key)
    );

    if (!matchedFeatures.length) return 0;

    return Math.max(
        ...matchedFeatures.map((feature) => {
            const used = Number(feature?.used || 0);
            return Number.isFinite(used) ? used : 0;
        })
    );
}

function buildForcedPlanFeature(planName) {
    const normalizedPlanName = normalizePlanName(planName);
    const config = PLAN_REPORT_LIMITS[normalizedPlanName] || PLAN_REPORT_LIMITS.free;

    return {
        key: CANONICAL_KEY,
        value: config.value,
        note: config.note,
    };
}

function buildForcedSubscriptionFeature(planFeature, oldFeatures = []) {
    return {
        key: CANONICAL_KEY,
        value: planFeature.value,
        limit: featureValueToLimit(planFeature.value),
        used: getUsedFromFeatures(oldFeatures),
        note: planFeature.note || null,
        resetsEvery: null,
        resetsAt: null,
    };
}

async function migrateSubscriptionPlans() {
    const plans = await SubscriptionPlan.find({
        role: "Brand",
    });

    let updated = 0;

    for (const plan of plans) {
        const existingFeatures = Array.isArray(plan.features) ? plan.features : [];
        const forcedFeature = buildForcedPlanFeature(plan.name);

        const nextFeatures = [
            ...existingFeatures.filter((feature) => !isProfileViewsKey(feature?.key)),
            forcedFeature,
        ];

        await SubscriptionPlan.updateOne(
            { _id: plan._id },
            {
                $set: {
                    features: nextFeatures,
                },
            },
            {
                runValidators: false,
            }
        );

        updated += 1;
        console.log(
            `Updated plan: ${plan.name} -> ${JSON.stringify(forcedFeature.value)}`
        );
    }

    return { updated };
}

async function getPlanFeatureMaps() {
    const plans = await SubscriptionPlan.find({
        role: "Brand",
    })
        .select("_id planId name features")
        .lean();

    const planFeatureByPlanId = new Map();
    const planFeatureByName = new Map();

    plans.forEach((plan) => {
        const forcedFeature = buildForcedPlanFeature(plan.name);

        if (plan.planId) {
            planFeatureByPlanId.set(String(plan.planId), forcedFeature);
        }

        if (plan.name) {
            planFeatureByName.set(normalizePlanName(plan.name), forcedFeature);
            planFeatureByName.set(clean(plan.name).toLowerCase(), forcedFeature);
        }
    });

    return {
        planFeatureByPlanId,
        planFeatureByName,
    };
}

async function migrateBrandSubscriptionSnapshots() {
    const { planFeatureByPlanId, planFeatureByName } = await getPlanFeatureMaps();

    const brands = await Brand.find({
        subscription: { $exists: true },
    })
        .select("_id subscription")
        .lean();

    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (const brand of brands) {
        try {
            const subscription = brand.subscription || {};
            const oldFeatures = Array.isArray(subscription.features)
                ? subscription.features
                : [];

            const planFeature =
                planFeatureByPlanId.get(String(subscription.planId || "")) ||
                planFeatureByName.get(normalizePlanName(subscription.planName || "free")) ||
                planFeatureByName.get(clean(subscription.planName).toLowerCase()) ||
                null;

            if (!planFeature) {
                skipped += 1;
                console.log(`Skipped brand ${brand._id}: plan feature not found`);
                continue;
            }

            const nextFeature = buildForcedSubscriptionFeature(planFeature, oldFeatures);

            const nextFeatures = [
                ...oldFeatures.filter((feature) => !isProfileViewsKey(feature?.key)),
                nextFeature,
            ];

            await Brand.updateOne(
                { _id: brand._id },
                {
                    $set: {
                        "subscription.features": nextFeatures,
                    },
                },
                {
                    runValidators: false,
                }
            );

            updated += 1;
        } catch (err) {
            failed += 1;
            console.log(`Failed brand ${brand._id}: ${err.message}`);
        }
    }

    return { updated, skipped, failed };
}

async function verifyMigration() {
    const badPlanCount = await SubscriptionPlan.countDocuments({
        role: "Brand",
        "features.key": { $in: OLD_KEYS },
    });

    const badBrandCount = await Brand.countDocuments({
        "subscription.features.key": { $in: OLD_KEYS },
    });

    const plans = await SubscriptionPlan.find({
        role: "Brand",
    })
        .select("name features")
        .lean();

    const planValues = plans.map((plan) => {
        const feature = (plan.features || []).find(
            (item) => item.key === CANONICAL_KEY
        );

        return {
            plan: plan.name,
            value: feature?.value,
            note: feature?.note,
        };
    });

    return {
        badPlanCount,
        badBrandCount,
        planValues,
    };
}

async function main() {
    const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;

    if (!mongoUri) {
        throw new Error("MONGODB_URI or MONGO_URI is required");
    }

    await mongoose.connect(mongoUri);

    console.log("Migration started...");

    const planResult = await migrateSubscriptionPlans();
    const brandResult = await migrateBrandSubscriptionSnapshots();
    const verification = await verifyMigration();

    await mongoose.disconnect();

    console.log("Migration completed.");
    console.log({
        plans: planResult,
        brands: brandResult,
        verification,
    });
}

main().catch(async (err) => {
    console.error(err);

    try {
        await mongoose.disconnect();
    } catch { }

    process.exit(1);
});