const { rateLimit } = require("express-rate-limit");

const ApiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  limit: 10, // max 10 hits per IP in 5 minutes
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many requests from this IP. Please try again after 5 minutes.",
  },
});

const modashApiLimiter = rateLimit({
  windowMs: 5* 60 * 1000, // 5 minutes
  limit: 2, // max 12 hits per IP in 2 minutes
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many requests from this IP. Please try again after 5 minutes.",
  },
});

module.exports = {
  ApiLimiter,
  modashApiLimiter
};