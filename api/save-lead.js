const { Redis } = require("@upstash/redis");

const redis = Redis.fromEnv();

function safeJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj, null, 2));
}

module.exports = async function handler(req, res) {
  const allowedOrigins = new Set([
    "https://promojet.com.au",
    "https://www.promojet.com.au",
  ]);

  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return safeJson(res, 405, { error: "Use POST" });
  }

  try {
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }
    body = body || {};

    const {
      name = "",
      email = "",
      website_url = "",
      score = null
    } = body;

    if (!email) {
      return safeJson(res, 400, { error: "Missing email" });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return safeJson(res, 400, { error: "Invalid email" });
    }

    const id = `lead:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

    const lead = {
      id,
      name,
      email: email.toLowerCase(),
      website_url,
      score,
      created_at: new Date().toISOString()
    };

    await redis.set(id, lead);

    // optional index list for easier browsing later
    await redis.lpush("leads:list", id);

    return safeJson(res, 200, {
      success: true,
      message: "Lead saved",
      lead_id: id
    });
  } catch (err) {
    return safeJson(res, 500, { error: err?.message || "Server error" });
  }
};
