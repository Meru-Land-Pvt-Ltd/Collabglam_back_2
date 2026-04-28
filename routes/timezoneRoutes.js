const { Router } = require("express");
const { getTimezonesByCountries, getAllTimezones} = require("../controllers/timezoneController");

const router = Router();

router.post("/by-countries", getTimezonesByCountries);
router.get("/all", getAllTimezones);

module.exports = router;