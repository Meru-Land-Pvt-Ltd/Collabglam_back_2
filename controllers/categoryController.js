// controllers/category.controller.js
const { Category } = require('../models/categories');
const saveErrorLog = require('../services/errorLog.service');


exports.getAllCategoriesWithSubcategories = async (req, res) => {
  try {
    const categories = await Category.find(
      {},
      'id name subcategories.name subcategories.subcategoryId'
    )
      .sort({ id: 1 })
      .lean();

    return res.status(200).json({
      count: categories.length,
      categories
    });
  } catch (err) {
    console.error('getAllCategoriesWithSubcategories error:', err);
    await saveErrorLog(req, err, 500, 'GET_ALL_CATEGORIES_WITH_SUBCATEGORIES_ERROR');
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// POST /categories/subcategories
exports.postSubcategoriesByCategoryId = async (req, res) => {
  try {
    const catId = Number(req.body?.id ?? req.body?.categoryId);

    if (Number.isNaN(catId)) {
      return res.status(400).json({ message: 'Category id must be a number' });
    }

    const doc = await Category.findOne(
      { id: catId },
      'id name subcategories.name subcategories.subcategoryId'
    ).lean();

    if (!doc) {
      return res.status(404).json({ message: 'Category not found' });
    }

    return res.status(200).json({
      categoryId: doc.id,
      categoryName: doc.name,
      subcategories: doc.subcategories || []
    });
  } catch (err) {
    console.error('postSubcategoriesByCategoryId error:', err);
    await saveErrorLog(req, err, 500, 'POST_SUBCATEGORIES_BY_CATEGORY_ID_ERROR');
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// POST /categories/get
exports.postCategoryById = async (req, res) => {
  try {
    const catId = Number(req.body?.id ?? req.body?.categoryId);

    if (Number.isNaN(catId)) {
      return res.status(400).json({ message: 'Category id must be a number' });
    }

    const doc = await Category.findOne(
      { id: catId },
      'id name subcategories.name subcategories.subcategoryId'
    ).lean();

    if (!doc) {
      return res.status(404).json({ message: 'Category not found' });
    }

    return res.status(200).json(doc);
  } catch (err) {
    console.error('postCategoryById error:', err);
    await saveErrorLog(req, err, 500, 'POST_CATEGORY_BY_ID_ERROR');
    return res.status(500).json({ message: 'Internal server error' });
  }
};