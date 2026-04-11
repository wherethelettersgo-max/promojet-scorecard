/**
 * /api/full-report.js
 *
 * Required env vars:
 * - OPENAI_API_KEY
 *
 * Optional:
 * - SCORECARD_MAX_HTML_BYTES (default 600000)
 * - SCORECARD_MODEL (default "gpt-5.4-mini")
 * - UPSTASH_REDIS_REST_URL
 * - UPSTASH_REDIS_REST_TOKEN
 */

const OpenAI = require("openai");
const { Redis } = require("@upstash/redis");
const { Ratelimit } = require("@upstash/ratelimit");

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const hasRedisEnv =
  !!process.env.UPSTASH_REDIS_REST_URL && !!process.env.UPSTASH_REDIS_REST_TOKEN;

const redis = hasRedisEnv ? Redis.fromEnv() : null;

const minuteLimiter = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(5, "1 m"),
      analytics: true,
    })
  : null;

const dayLimiter = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.fixedWindow(20, "1 d"),
      analytics: true,
    })
  : null;

function safeJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj, null, 2));
}

function normalizeUrl(input) {
  let u = String(input || "").trim();
  if (!u) throw new Error("Empty url");
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;

  const url = new URL(u);
  const host = url.hostname.toLowerCase();
  const blockedHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (blockedHosts.has(host)) throw new Error("Blocked host.");

  return url.toString();
}

function stripTags(html) {
  const noScripts = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ");

  return noScripts
    .replace(/<\/(p|div|br|li|h\d|section|article|header|footer|nav)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanInline(text) {
  return String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueNonEmpty(arr, maxItems = 8, maxLen = 120) {
  const seen = new Set();
  const out = [];

  for (const raw of arr || []) {
    const v = cleanInline(raw);
    if (!v) continue;
    if (v.length < 2 || v.length > maxLen) continue;

    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);

    if (out.length >= maxItems) break;
  }

  return out;
}

function extractBasics(html) {
  const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || "").trim();

  const metaDesc = (
    html.match(
      /<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i
    )?.[1] || ""
  ).trim();

  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const text = stripTags(html);

  const callToActionRegex =
    /\b(book|call|get a quote|quote|enquire|enquiry|contact|start|buy|shop|subscribe|join|download|request|schedule)\b/i;
  const hasCallToActionWord = callToActionRegex.test(text);

  const hasEmail = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(html);
  const hasPhone = /(\+?\d[\d\s().-]{7,}\d)/.test(html);

  const trustRegex =
    /\b(testimonial|reviews?|trusted|clients?|case study|results?|guarantee|rated|award|since \d{4})\b/i;
  const hasTrustWords = trustRegex.test(text);

  const hasForm = /<form\b/i.test(html);

  return {
    title,
    metaDesc,
    h1,
    hasCallToActionWord,
    hasEmail,
    hasPhone,
    hasTrustWords,
    hasForm,
  };
}

function extractPromptSignals(html, text) {
  const headingMatches = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map(
    (m) => m[1]
  );

  const actionMatches = [...html.matchAll(/<(a|button)[^>]*>([\s\S]*?)<\/(a|button)>/gi)]
    .map((m) => m[2])
    .filter(Boolean);

  const bodySentences = text
    .split(/(?<=[.!?])\s+|[\n\r]+/)
    .map((s) => cleanInline(s))
    .filter((s) => s.length >= 35 && s.length <= 180);

  return {
    headings: uniqueNonEmpty(headingMatches, 8, 110),
    actions: uniqueNonEmpty(actionMatches, 8, 60),
    strongLines: uniqueNonEmpty(bodySentences, 8, 180),
    shortBodySample: cleanInline(text).slice(0, 420),
  };
}

function buildFallbackFullReport(basics) {
  const headline_rewrite_options = [
    basics.h1 && basics.h1.length >= 10
      ? basics.h1
      : "A Clearer Offer That Shows the Outcome You Deliver",
    "Turn More Visitors Into Enquiries With a Stronger Homepage Message",
    "Web Design and Marketing Support Built to Drive Business Growth",
  ];

  const cta_rewrite_options = [
    "Get My Website Review",
    "Book a Strategy Call",
    "Request a Quote",
  ];

  const recommended_homepage_sections = [
    "Hero with clear offer and main Call to Action",
    "Proof block with reviews or client credibility",
    "Core services overview",
    "Why choose us",
    "Simple process or how it works",
    "Contact section with one strong Call to Action",
  ];

  const notes_and_assumptions = [
    "Fallback mode was used because the AI full report failed or was incomplete.",
    "Recommendations are based on limited on-page HTML signals.",
  ];

  const boomer_commentary =
    "Boomer says: make the offer, the proof, and the next step obvious fast. If visitors have to work out what you do or what to click, the page is wasting attention.";

  return {
    headline_rewrite_options,
    cta_rewrite_options,
    recommended_homepage_sections,
    notes_and_assumptions,
    boomer_commentary,
  };
}

function fullReportSchema(name) {
  return {
    type: "json_schema",
    name,
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        headline_rewrite_options: {
          type: "array",
          minItems: 3,
          maxItems: 3,
          items: { type: "string", maxLength: 90 },
        },
        cta_rewrite_options: {
          type: "array",
          minItems: 3,
          maxItems: 3,
          items: { type: "string", maxLength: 50 },
        },
        recommended_homepage_sections: {
          type: "array",
          minItems: 6,
          maxItems: 6,
          items: { type: "string", maxLength: 64 },
        },
        notes_and_assumptions: {
          type: "array",
          minItems: 2,
          maxItems: 2,
          items: { type: "string", maxLength: 120 },
        },
        boomer_commentary: {
          type: "string",
          maxLength: 320,
        },
      },
      required: [
        "headline_rewrite_options",
        "cta_rewrite_options",
        "recommended_homepage_sections",
        "notes_and_assumptions",
        "boomer_commentary",
      ],
    },
  };
}

function getCacheKey(kind, url, businessType, goal) {
  const raw = JSON.stringify({ kind, url, businessType, goal });
  return `promojet:${kind}:v6:${Buffer.from(raw).toString("base64url")}`;
}

async function readCache(key) {
  if (!redis) return null;
  try {
    return await redis.get(key);
  } catch (err) {
    console.error("CACHE READ ERROR:", err);
    return null;
  }
}

async function writeCache(key, value, ttlSeconds) {
  if (!redis) return;
  try {
    await redis.set(key, value, { ex: ttlSeconds });
  } catch (err) {
    console.error("CACHE WRITE ERROR:", err);
  }
}

async function runFullReportAttempt({
  model,
  targetUrl,
  businessType,
  goal,
  basics,
  promptSignals,
  maxOutputTokens,
  schemaName,
  compactMode = false,
}) {
  const userContent = compactMode
    ? `Create the full unlocked CRO report for this website.

Business type: ${businessType}
Primary goal: ${goal}
URL: ${targetUrl}

Extracted signals:
Title: ${basics.title}
Meta description: ${basics.metaDesc}
H1: ${basics.h1}
Call to Action detected: ${basics.hasCallToActionWord}
Email detected: ${basics.hasEmail}
Phone detected: ${basics.hasPhone}
Trust indicators detected: ${basics.hasTrustWords}
Form detected: ${basics.hasForm}

Key headings:
${JSON.stringify(promptSignals.headings)}

Likely action labels:
${JSON.stringify(promptSignals.actions)}

Body sample:
${promptSignals.shortBodySample.slice(0, 280)}

Return only JSON with:
- headline_rewrite_options (3 items)
- cta_rewrite_options (3 items)
- recommended_homepage_sections (6 items)
- notes_and_assumptions (2 items)
- boomer_commentary

Rules:
- Keep everything compact and specific.
- Make suggestions relevant to this business and page only.
- Use 'Call to Action' not 'CTA'.`
    : `Create the full unlocked CRO report for this website.

Business type: ${businessType}
Primary goal: ${goal}
URL: ${targetUrl}

Extracted signals:
Title: ${basics.title}
Meta description: ${basics.metaDesc}
H1: ${basics.h1}
Call to Action detected: ${basics.hasCallToActionWord}
Email detected: ${basics.hasEmail}
Phone detected: ${basics.hasPhone}
Trust indicators detected: ${basics.hasTrustWords}
Form detected: ${basics.hasForm}

Key headings:
${JSON.stringify(promptSignals.headings)}

Likely action labels:
${JSON.stringify(promptSignals.actions)}

Important body lines:
${JSON.stringify(promptSignals.strongLines)}

Body sample:
${promptSignals.shortBodySample}

Return only JSON with:
- headline_rewrite_options (3 items)
- cta_rewrite_options (3 items)
- recommended_homepage_sections (6 items)
- notes_and_assumptions (2 items)
- boomer_commentary

Rules:
- Make suggestions specific to this business and page.
- Keep each headline under 90 characters.
- Keep each Call to Action under 50 characters.
- Keep each homepage section label under 64 characters.
- Keep each note under 120 characters.
- Keep Boomer commentary under 320 characters.
- Use 'Call to Action' not 'CTA'.`;

  const ai = await client.responses.create({
    model,
    max_output_tokens: maxOutputTokens,
    input: [
      {
        role: "system",
        content:
          "You are an expert conversion rate optimisation consultant writing the full unlocked section of a website audit. Return only strict JSON. Be specific, commercially useful, concise, practical, and grounded in the supplied page signals. Use 'Call to Action' not 'CTA'. Also write one short, punchy Boomer commentary paragraph in plain English that sounds direct, friendly, and sharp.",
      },
      {
        role: "user",
        content: userContent,
      },
    ],
    text: {
      format: fullReportSchema(schemaName),
    },
  });

  const aiText = (ai.output_text || "").trim();

  console.log("OpenAI full-report status:", ai.status);
  console.log("OpenAI full-report incomplete details:", ai.incomplete_details || null);
  console.log("OpenAI full-report output length:", aiText.length);

  if (ai.status === "incomplete") {
    throw new Error(
      `OpenAI full-report incomplete: ${ai.incomplete_details?.reason || "unknown_reason"}`
    );
  }

  if (!aiText) {
    throw new Error("OpenAI full-report returned empty output_text");
  }

  let parsed;
  try {
    parsed = JSON.parse(aiText);
  } catch (err) {
    console.error("Failed full-report JSON text:", aiText);
    throw new Error(`Could not parse full-report JSON: ${err.message}`);
  }

  return parsed;
}

module.exports = async function handler(req, res) {
  res.setHeader("X-PromoJet-Version", "full-report-v7-protected");

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

    const ip =
      (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
      req.socket?.remoteAddress ||
      "unknown";

    if (minuteLimiter) {
      const minuteResult = await minuteLimiter.limit(`fullreport:min:${ip}`);
      res.setHeader("X-RateLimit-Remaining", String(minuteResult.remaining));
      res.setHeader("X-RateLimit-Reset", String(minuteResult.reset));

      if (!minuteResult.success) {
        return safeJson(res, 429, {
          error: "Rate limit exceeded. Please try again shortly.",
        });
      }
    }

    if (dayLimiter) {
      const dayResult = await dayLimiter.limit(`fullreport:day:${ip}`);
      if (!dayResult.success) {
        return safeJson(res, 429, {
          error: "Daily limit reached. Please try again tomorrow.",
        });
      }
    }

    const {
      url,
      business_type = "service_business",
      goal = "generate_leads",
    } = body;

    if (!url) {
      return safeJson(res, 400, { error: "Missing url" });
    }

    const targetUrl = normalizeUrl(url);
    const maxBytes = parseInt(process.env.SCORECARD_MAX_HTML_BYTES || "600000", 10);
    const cacheKey = getCacheKey("full-report", targetUrl, business_type, goal);

    const cached = await readCache(cacheKey);
    if (cached?.url && cached?.report) {
      return safeJson(res, 200, {
        ...cached,
        cached: true,
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    let resp;
    try {
      resp = await fetch(targetUrl, {
        signal: controller.signal,
        headers: {
          "User-Agent": "PromoJetScorecardBot/1.0 (+https://promojet.com.au)",
        },
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!resp || !resp.ok) {
      return safeJson(res, 400, {
        error: `Fetch failed: ${resp?.status || "unknown"}`,
      });
    }

    const html = (await resp.text()).slice(0, maxBytes);
    const basics = extractBasics(html);
    const text = stripTags(html);
    const promptSignals = extractPromptSignals(html, text);
    const model = process.env.SCORECARD_MODEL || "gpt-5.4-mini";

    let report = null;
    let mode = "ai";

    try {
      report = await runFullReportAttempt({
        model,
        targetUrl,
        businessType: business_type,
        goal,
        basics,
        promptSignals,
        maxOutputTokens: 1700,
        schemaName: "promojet_full_unlock_report",
        compactMode: false,
      });
    } catch (firstErr) {
      console.error("OPENAI FULL-REPORT FIRST ATTEMPT ERROR:", firstErr);

      try {
        report = await runFullReportAttempt({
          model,
          targetUrl,
          businessType: business_type,
          goal,
          basics,
          promptSignals,
          maxOutputTokens: 1100,
          schemaName: "promojet_full_unlock_report_retry",
          compactMode: true,
        });
        mode = "ai_retry";
      } catch (retryErr) {
        console.error("OPENAI FULL-REPORT RETRY ERROR:", retryErr);
        report = buildFallbackFullReport(basics);
        report.notes_and_assumptions = [
          `Fallback mode was used because the AI full report failed: ${retryErr?.message || "Unknown error"}`,
          "Recommendations are based on limited on-page HTML signals.",
        ];
        mode = "fallback";
      }
    }

    const payload = {
      url: targetUrl,
      mode,
      cached: false,
      report,
    };

    if (mode !== "fallback") {
      await writeCache(cacheKey, payload, 60 * 60 * 24 * 7);
    }

    return safeJson(res, 200, payload);
  } catch (err) {
    return safeJson(res, 500, { error: err?.message || "Server error" });
  }
};
