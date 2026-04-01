/**
 * /api/scorecard.js  (Teaser report only)
 *
 * Required env vars:
 * - OPENAI_API_KEY
 * - TURNSTILE_SECRET_KEY
 * - UPSTASH_REDIS_REST_URL
 * - UPSTASH_REDIS_REST_TOKEN
 *
 * Optional:
 * - SCORECARD_MAX_HTML_BYTES (default 600000)
 * - SCORECARD_MODEL (default "gpt-5.4-mini")
 */

const OpenAI = require("openai");
const { Ratelimit } = require("@upstash/ratelimit");
const { Redis } = require("@upstash/redis");

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const redis = Redis.fromEnv();

const minuteLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, "1 m"),
  analytics: true,
});

const dayLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.fixedWindow(20, "1 d"),
  analytics: true,
});

function safeJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj, null, 2));
}

async function verifyTurnstile(token, remoteip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) throw new Error("TURNSTILE_SECRET_KEY not set");

  const form = new URLSearchParams();
  form.append("secret", secret);
  form.append("response", token);
  if (remoteip) form.append("remoteip", remoteip);

  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  return r.json();
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

function heuristicScore(basics, text, html) {
  let clarity = 0;
  let call_to_action = 0;
  let trust = 0;
  let structure = 0;
  let offer = 0;
  let friction = 0;

  if (basics.h1.length >= 12 && basics.h1.length <= 90) clarity += 12;
  if (basics.metaDesc.length >= 50 && basics.metaDesc.length <= 170) clarity += 4;
  if (basics.title.length >= 10 && basics.title.length <= 70) clarity += 4;

  if (basics.hasCallToActionWord) call_to_action += 10;
  if (basics.hasForm) call_to_action += 6;
  if (basics.hasEmail || basics.hasPhone) call_to_action += 4;

  if (basics.hasTrustWords) trust += 10;
  if (basics.hasEmail) trust += 2;
  if (basics.hasPhone) trust += 3;

  const hasNav =
    /<nav\b/i.test(html) ||
    /\b(home|about|services|portfolio|contact|pricing|book now|get started)\b/i.test(text);
  if (hasNav) structure += 8;

  const headingMentions =
    (text.match(/\b(how|why|what|services|pricing|process|results|reviews|contact)\b/gi) || [])
      .length;
  if (headingMentions >= 5) structure += 7;

  const offerHits =
    text.match(
      /\b(website|web design|graphic design|branding|maintenance|hosting|support|conversion|seo|landing page|marketing|strategy|consulting|service|solutions)\b/gi
    ) || [];
  offer += Math.min(15, offerHits.length >= 6 ? 15 : offerHits.length * 2);

  friction = 15;
  if (!basics.hasForm) friction -= 6;
  if (!basics.hasEmail && !basics.hasPhone) friction -= 6;
  if (!basics.hasCallToActionWord) friction -= 3;
  friction = Math.max(0, friction);

  const total = clarity + call_to_action + trust + structure + offer + friction;

  return {
    total,
    subscores: { clarity, call_to_action, trust, structure, offer, friction },
  };
}

function buildFallbackTeaser(heur, basics) {
  const summaryParts = [];

  if (heur.subscores.clarity >= 14) {
    summaryParts.push(
      "The page appears to communicate its offer reasonably well, but the core promise could still be made sharper and more outcome-focused."
    );
  } else if (heur.subscores.clarity >= 8) {
    summaryParts.push(
      "The page shows some message clarity, but the value proposition may still be too broad or too vague for a fast first impression."
    );
  } else {
    summaryParts.push(
      "The page likely needs a clearer above-the-fold message so visitors can immediately understand what is offered and why it matters."
    );
  }

  if (heur.subscores.call_to_action >= 14) {
    summaryParts.push(
      "A Call to Action appears to be present, although it may still need stronger wording, prominence, or better placement."
    );
  } else if (heur.subscores.call_to_action >= 8) {
    summaryParts.push(
      "A next step may exist on the page, but it may not be persuasive or visually strong enough to convert more visitors."
    );
  } else {
    summaryParts.push(
      "The page may not be guiding visitors cleanly toward one obvious next action, which can reduce enquiries."
    );
  }

  if (heur.subscores.trust >= 10) {
    summaryParts.push(
      "Some trust signals appear to be present, but they would likely work harder if surfaced closer to decision points and contact prompts."
    );
  } else {
    summaryParts.push(
      "Trust indicators appear limited and could be strengthened with reviews, proof, results, guarantees, or client credibility markers."
    );
  }

  return {
    overall_score: heur.total,
    subscores: heur.subscores,
    summary: summaryParts.join(" "),
    top_issues: [
      basics.h1
        ? "Check whether the main headline clearly states who you help and the outcome you deliver."
        : "Missing or unclear main headline (H1).",
      basics.hasCallToActionWord
        ? "A Call to Action was detected, but it should be checked for strength, specificity, and placement."
        : "No clear Call to Action language was detected.",
    ],
    quick_wins: [
      "Strengthen the headline and supporting copy so the offer is clearer within a few seconds.",
      "Add one strong primary Call to Action near the top of the page.",
    ],
    notes_and_assumptions: [
      "Fallback mode was used because the AI teaser request failed or was incomplete.",
      "This teaser is based on HTML signals and a limited page sample.",
    ],
  };
}

function teaserSchema(name) {
  return {
    type: "json_schema",
    name,
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: { type: "string", maxLength: 1100 },
        top_issues: {
          type: "array",
          minItems: 2,
          maxItems: 2,
          items: { type: "string", maxLength: 160 },
        },
        quick_wins: {
          type: "array",
          minItems: 2,
          maxItems: 2,
          items: { type: "string", maxLength: 160 },
        },
        notes_and_assumptions: {
          type: "array",
          minItems: 2,
          maxItems: 2,
          items: { type: "string", maxLength: 120 },
        },
      },
      required: ["summary", "top_issues", "quick_wins", "notes_and_assumptions"],
    },
  };
}

function getCacheKey(kind, url, businessType, goal) {
  const raw = JSON.stringify({ kind, url, businessType, goal });
  return `promojet:${kind}:v6:${Buffer.from(raw).toString("base64url")}`;
}

async function readCache(key) {
  try {
    return await redis.get(key);
  } catch (err) {
    console.error("CACHE READ ERROR:", err);
    return null;
  }
}

async function writeCache(key, value, ttlSeconds) {
  try {
    await redis.set(key, value, { ex: ttlSeconds });
  } catch (err) {
    console.error("CACHE WRITE ERROR:", err);
  }
}

async function runTeaserAttempt({
  model,
  targetUrl,
  businessType,
  goal,
  basics,
  heur,
  promptSignals,
  maxOutputTokens,
  schemaName,
  compactMode = false,
}) {
  const userContent = compactMode
    ? `Audit this website for conversion performance.

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

Baseline conversion subscores:
${JSON.stringify(heur.subscores)}

Key headings:
${JSON.stringify(promptSignals.headings)}

Likely action labels:
${JSON.stringify(promptSignals.actions)}

Body sample:
${promptSignals.shortBodySample.slice(0, 260)}

Return only JSON with:
- summary
- top_issues (2 items)
- quick_wins (2 items)
- notes_and_assumptions (2 items)

Requirements:
- Summary target: 100 to 150 words.
- Keep it commercially useful and specific.
- Mention what is working, what is hurting conversions, and the best near-term opportunity.
- Keep top issues and quick wins concrete and practical.`
    : `Audit this website for conversion performance.

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

Baseline conversion subscores:
${JSON.stringify(heur.subscores)}

Key headings:
${JSON.stringify(promptSignals.headings)}

Likely action labels:
${JSON.stringify(promptSignals.actions)}

Important body lines:
${JSON.stringify(promptSignals.strongLines)}

Body sample:
${promptSignals.shortBodySample}

Return only JSON with:
- summary
- top_issues (2 items)
- quick_wins (2 items)
- notes_and_assumptions (2 items)

Requirements:
- Summary target: 100 to 150 words.
- Be specific, commercially useful, and concise.
- Explain what is working, what is hurting conversions, and what the opportunity is.
- Top issues must be concrete and specific.
- Quick wins must be immediately actionable.
- Use 'Call to Action' instead of 'CTA'.`;

  const ai = await client.responses.create({
    model,
    max_output_tokens: maxOutputTokens,
    input: [
      {
        role: "system",
        content:
          "You are an expert conversion rate optimisation consultant writing a website conversion teaser report. Return only strict JSON. Be specific, commercially useful, concise, and grounded in the supplied page signals. Write for business owners, not marketers. Use the phrase 'Call to Action' instead of 'CTA'.",
      },
      {
        role: "user",
        content: userContent,
      },
    ],
    text: {
      format: teaserSchema(schemaName),
    },
  });

  const aiText = (ai.output_text || "").trim();

  console.log("OpenAI teaser status:", ai.status);
  console.log("OpenAI teaser incomplete details:", ai.incomplete_details || null);
  console.log("OpenAI teaser output length:", aiText.length);

  if (ai.status === "incomplete") {
    throw new Error(`OpenAI teaser incomplete: ${ai.incomplete_details?.reason || "unknown_reason"}`);
  }

  if (!aiText) {
    throw new Error("OpenAI teaser returned empty output_text");
  }

  let parsed;
  try {
    parsed = JSON.parse(aiText);
  } catch (parseErr) {
    console.error("Failed teaser JSON text:", aiText);
    throw new Error(`Could not parse teaser JSON: ${parseErr.message}`);
  }

  return {
    overall_score: heur.total,
    subscores: heur.subscores,
    summary: parsed.summary,
    top_issues: parsed.top_issues,
    quick_wins: parsed.quick_wins,
    notes_and_assumptions: parsed.notes_and_assumptions,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("X-PromoJet-Version", "scorecard-split-v6");

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

    const { turnstileToken } = body;
    if (!turnstileToken) {
      return safeJson(res, 400, { error: "Missing bot check token" });
    }

    const ip =
      (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
      req.socket?.remoteAddress ||
      "unknown";

    const minuteResult = await minuteLimiter.limit(`scorecard:min:${ip}`);
    res.setHeader("X-RateLimit-Remaining", String(minuteResult.remaining));
    res.setHeader("X-RateLimit-Reset", String(minuteResult.reset));
    if (!minuteResult.success) {
      return safeJson(res, 429, { error: "Rate limit exceeded. Please try again shortly." });
    }

    const dayResult = await dayLimiter.limit(`scorecard:day:${ip}`);
    if (!dayResult.success) {
      return safeJson(res, 429, { error: "Daily limit reached. Please try again tomorrow." });
    }

    const verification = await verifyTurnstile(turnstileToken, ip);
    if (!verification.success) {
      return safeJson(res, 403, { error: "Bot check failed" });
    }

    const { url, business_type = "service_business", goal = "generate_leads" } = body;
    if (!url) return safeJson(res, 400, { error: "Missing url" });

    const targetUrl = normalizeUrl(url);
    const maxBytes = parseInt(process.env.SCORECARD_MAX_HTML_BYTES || "600000", 10);
    const cacheKey = getCacheKey("scorecard", targetUrl, business_type, goal);

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
        headers: { "User-Agent": "PromoJetScorecardBot/1.0 (+https://promojet.com.au)" },
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!resp || !resp.ok) {
      return safeJson(res, 400, { error: `Fetch failed: ${resp?.status || "unknown"}` });
    }

    const html = (await resp.text()).slice(0, maxBytes);
    const basics = extractBasics(html);
    const text = stripTags(html);
    const heur = heuristicScore(basics, text, html);
    const promptSignals = extractPromptSignals(html, text);
    const model = process.env.SCORECARD_MODEL || "gpt-5.4-mini";

    let report = null;
    let mode = "ai";

    try {
      report = await runTeaserAttempt({
        model,
        targetUrl,
        businessType: business_type,
        goal,
        basics,
        heur,
        promptSignals,
        maxOutputTokens: 1500,
        schemaName: "promojet_teaser_report",
        compactMode: false,
      });
    } catch (firstErr) {
      console.error("OPENAI TEASER FIRST ATTEMPT ERROR:", firstErr);

      try {
        report = await runTeaserAttempt({
          model,
          targetUrl,
          businessType: business_type,
          goal,
          basics,
          heur,
          promptSignals,
          maxOutputTokens: 1000,
          schemaName: "promojet_teaser_report_retry",
          compactMode: true,
        });
        mode = "ai_retry";
      } catch (retryErr) {
        console.error("OPENAI TEASER RETRY ERROR:", retryErr);
        report = buildFallbackTeaser(heur, basics);
        report.notes_and_assumptions = [
          `Fallback mode was used because the AI teaser request failed: ${retryErr?.message || "Unknown error"}`,
          "This teaser is based on HTML signals and a limited page sample.",
        ];
        mode = "fallback";
      }
    }

    const payload = {
      url: targetUrl,
      mode,
      cached: false,
      baseline: { overall: heur.total, subscores: heur.subscores, basics },
      report,
    };

    if (mode !== "fallback") {
      await writeCache(cacheKey, payload, 60 * 60 * 24);
    }

    return safeJson(res, 200, payload);
  } catch (err) {
    return safeJson(res, 500, { error: err?.message || "Server error" });
  }
};
