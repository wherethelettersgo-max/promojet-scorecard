/**
 * /api/save-lead.js
 *
 * Required env vars:
 * - UPSTASH_REDIS_REST_URL
 * - UPSTASH_REDIS_REST_TOKEN
 */

const { Redis } = require("@upstash/redis");
const { Ratelimit } = require("@upstash/ratelimit");

const hasRedisEnv =
  !!process.env.UPSTASH_REDIS_REST_URL && !!process.env.UPSTASH_REDIS_REST_TOKEN;

const redis = hasRedisEnv ? Redis.fromEnv() : null;

const minuteLimiter = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(10, "1 m"),
      analytics: true,
    })
  : null;

const dayLimiter = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.fixedWindow(50, "1 d"),
      analytics: true,
    })
  : null;

function safeJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj, null, 2));
}

function cleanText(value, maxLen) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, maxLen);
}

function normalizeWebsiteUrl(input) {
  const raw = cleanText(input, 300);
  if (!raw) return "";

  try {
    const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(withProtocol).toString();
  } catch {
    return raw;
  }
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
    if (!redis) {
      return safeJson(res, 500, { error: "Redis is not configured in Vercel." });
    }

    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }
    body = body || {};

    const ip =
      (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
      req.socket?.remoteAddress ||
      "unknown";

    const minuteResult = await minuteLimiter.limit(`savelead:min:${ip}`);
    res.setHeader("X-RateLimit-Remaining", String(minuteResult.remaining));
    res.setHeader("X-RateLimit-Reset", String(minuteResult.reset));

    if (!minuteResult.success) {
      return safeJson(res, 429, {
        error: "Rate limit exceeded. Please try again shortly.",
      });
    }

    const dayResult = await dayLimiter.limit(`savelead:day:${ip}`);
    if (!dayResult.success) {
      return safeJson(res, 429, {
        error: "Daily limit reached. Please try again tomorrow.",
      });
    }

    const name = cleanText(body.name, 120);
    const email = cleanText(body.email, 254).toLowerCase();
    const website_url = normalizeWebsiteUrl(body.website_url);
    const scoreNumber = Number(body.score);
    const score = Number.isFinite(scoreNumber) ? scoreNumber : null;

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
      email,
      website_url,
      score,
      ip,
      created_at: new Date().toISOString(),
    };

    const leadJson = JSON.stringify(lead);
    const latestByEmailKey = `lead_by_email:${email}`;

    await redis.set(id, leadJson);
    await redis.set(latestByEmailKey, leadJson);
    await redis.lpush("leads:list", id);

    return safeJson(res, 200, {
      success: true,
      message: "Lead saved",
      lead_id: id,
      email_key: latestByEmailKey,
    });
  } catch (err) {
    return safeJson(res, 500, { error: err?.message || "Server error" });
  }
};
