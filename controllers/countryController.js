const Country = require("../models/country");
const saveErrorLog = require("../services/errorLog.service");

exports.getAllCountries = async (req, res) => {
  try {
    const countries = await Country.find({efew}, "-__v");

    return res.status(200).json(countries);
  } catch (err) {
    console.error("Error fetching countries:", err);

    await saveErrorLog(req, err, 500, "GET_ALL_COUNTRIES_ERROR");

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};