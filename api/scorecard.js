/**
 * /api/scorecard.js  (CommonJS for Vercel)
 *
 * Required env vars:
 * - OPENAI_API_KEY
 * - TURNSTILE_SECRET_KEY
 * - UPSTASH_REDIS_REST_URL
 * - UPSTASH_REDIS_REST_TOKEN
 *
 * Optional:
 * - SCORECARD_MAX_HTML_BYTES (default 600000)
 * - SCORECARD_MODEL (default "gpt-5-mini")
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

  const ctaRegex =
    /\b(book|call|quote|get a quote|enquire|enquiry|contact|start|buy|shop|subscribe|join|download|request|schedule)\b/i;
  const hasCTAWord = ctaRegex.test(text);

  const hasEmail = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(html);
  const hasPhone = /(\+?\d[\d\s().-]{7,}\d)/.test(html);

  const trustRegex =
    /\b(testimonial|reviews?|trusted|clients?|case study|results?|guarantee|rated)\b/i;
  const hasTrustWords = trustRegex.test(text);

  const hasForm = /<form\b/i.test(html);

  return { title, metaDesc, h1, hasCTAWord, hasEmail, hasPhone, hasTrustWords, hasForm };
}

function heuristicScore(basics, text) {
  let clarity = 0;
  let cta = 0;
  let trust = 0;
  let structure = 0;
  let offer = 0;
  let friction = 0;

  if (basics.h1.length >= 12 && basics.h1.length <= 90) clarity += 12;
  if (basics.metaDesc.length >= 50 && basics.metaDesc.length <= 170) clarity += 4;
  if (basics.title.length >= 10 && basics.title.length <= 70) clarity += 4;

  if (basics.hasCTAWord) cta += 10;
  if (basics.hasForm) cta += 6;
  if (basics.hasEmail || basics.hasPhone) cta += 4;

  if (basics.hasTrustWords) trust += 10;
  if (basics.hasEmail) trust += 2;
  if (basics.hasPhone) trust += 3;

  const hasNav =
    /<nav\b/i.test(text) ||
    /\b(home|about|services|portfolio|contact)\b/i.test(text);
  if (hasNav) structure += 8;

  const headingMentions =
    (text.match(/\b(how|why|what|services|pricing|process|results)\b/gi) || []).length;
  if (headingMentions >= 5) structure += 7;

  const offerHits =
    text.match(
      /\b(website|web design|graphic design|branding|maintenance|hosting|support|conversion|seo|landing page|garden|maintenance|horticulture|commercial)\b/gi
    ) || [];
  offer += Math.min(15, offerHits.length >= 6 ? 15 : offerHits.length * 2);

  friction = 15;
  if (!basics.hasForm) friction -= 6;
  if (!basics.hasEmail && !basics.hasPhone) friction -= 6;
  if (!basics.hasCTAWord) friction -= 3;
  friction = Math.max(0, friction);

  const total = clarity + cta + trust + structure + offer + friction;

  return {
    total,
    subscores: { clarity, cta, trust, structure, offer, friction },
  };
}

function buildFallbackReport(heur, basics) {
  const summaryParts = [];

  if (heur.subscores.clarity >= 14) {
    summaryParts.push(
      "The page appears to have reasonably clear messaging, although the commercial value proposition may still need sharpening."
    );
  } else if (heur.subscores.clarity >= 8) {
    summaryParts.push(
      "The page shows some message clarity, but the value proposition may still be too vague or too weak above the fold."
    );
  } else {
    summaryParts.push(
      "The page likely lacks clear above-the-fold messaging and may not explain the offer strongly enough for cold visitors."
    );
  }

  if (heur.subscores.cta >= 14) {
    summaryParts.push(
      "A Call to Action appears to be present and reasonably visible, though stronger wording may improve enquiries."
    );
  } else if (heur.subscores.cta >= 8) {
    summaryParts.push(
      "A Call to Action appears to exist, but it may not be prominent or persuasive enough."
    );
  } else {
    summaryParts.push("The page may not be guiding visitors clearly toward a next step.");
  }

  if (heur.subscores.trust >= 10) {
    summaryParts.push(
      "Some trust indicators are present, but stronger proof near conversion points would likely help."
    );
  } else {
    summaryParts.push(
      "Trust signals appear limited and could be reinforced with testimonials, results, guarantees, or client proof."
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
      basics.hasCTAWord
        ? "A Call to Action was detected, but it should be checked for clarity, strength, and above-the-fold visibility."
        : "No clear Call to Action language was detected.",
      basics.hasTrustWords
        ? "Trust language exists, but it may need stronger proof such as testimonials, results, logos, or guarantees."
        : "Few or no trust indicators were detected.",
      "The page may not be making the business value proposition strong enough for first-time visitors.",
    ],
    quick_wins: [
      "Strengthen the above-the-fold headline and subheadline so the offer is clearer within a few seconds.",
      "Add one strong primary Call to Action near the top of the page and repeat it later in the page.",
      "Add stronger proof such as testimonials, client logos, guarantees, or results near the first Call to Action.",
      "Reduce friction by making contact options, enquiry pathways, and next steps more obvious.",
    ],
    headline_rewrite_options: [
      "We help [target customer] achieve [desired outcome] with [service].",
      "[Service] for [target customer] who want [outcome] without [pain point].",
      "Get [outcome] with [service] built for [target customer].",
    ],
    cta_rewrite_options: [
      "Get a Quote",
      "Book a Quick Call",
      "Request a Website Review",
      "Talk to Us About Your Project",
    ],
    recommended_homepage_sections: [
      "Hero: headline, subheadline, and primary Call to Action",
      "Proof: testimonials, logos, or results",
      "Services overview",
      "Why choose us / differentiation",
      "How it works",
      "Second Call to Action and contact form",
      "FAQ",
      "Footer with trust and contact details",
    ],
    notes_and_assumptions: [
      "Fallback mode was used because the AI service was unavailable or over quota.",
      "This automated analysis is based on HTML signals and a limited text sample, so it may miss visual and UX issues.",
    ],
  };
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
    const pageSample = text.slice(0, 2500);
    const heur = heuristicScore(basics, text);

    let report = null;

        try {
      const ai = await client.responses.create({
        model: process.env.SCORECARD_MODEL || "gpt-5-mini",
        max_output_tokens: 1400,
        input: [
          {
            role: "system",
            content:
              "You are an expert conversion rate optimisation consultant writing a real website conversion audit. Return only strict JSON matching the requested schema. Be specific, commercially useful, practical, and concrete. Do not write generic filler. Write for business owners, not marketers. Use the phrase 'Call to Action' instead of 'CTA'.",
          },
          {
            role: "user",
            content: `Audit this website for conversion performance.

Business type: ${business_type}
Primary goal: ${goal}
URL: ${targetUrl}

Extracted signals:
Title: ${basics.title}
Meta description: ${basics.metaDesc}
H1: ${basics.h1}
Call to Action detected: ${basics.hasCTAWord}
Email detected: ${basics.hasEmail}
Phone detected: ${basics.hasPhone}
Trust indicators detected: ${basics.hasTrustWords}
Form detected: ${basics.hasForm}

Baseline conversion subscores:
${JSON.stringify(heur.subscores)}

Page content sample:
${pageSample}

Return a highly practical CRO report.

Requirements:
- The summary must be detailed and specific to this website.
- Explain what appears to be working, what is likely hurting conversions, and what the commercial opportunity is.
- Top issues must be concrete and specific, not generic.
- Quick wins must be immediately actionable.
- Headline rewrite options must sound like real website headlines for this business.
- Call to Action rewrite options must be specific and realistic.
- Recommended homepage sections must be ordered and practical.
- Notes and assumptions should explain limits of the analysis.

Return only JSON matching the requested schema.`,
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "promojet_full_scorecard_report",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                summary: { type: "string" },
                top_issues: {
                  type: "array",
                  minItems: 4,
                  maxItems: 6,
                  items: { type: "string" },
                },
                quick_wins: {
                  type: "array",
                  minItems: 4,
                  maxItems: 6,
                  items: { type: "string" },
                },
                headline_rewrite_options: {
                  type: "array",
                  minItems: 3,
                  maxItems: 4,
                  items: { type: "string" },
                },
                cta_rewrite_options: {
                  type: "array",
                  minItems: 3,
                  maxItems: 4,
                  items: { type: "string" },
                },
                recommended_homepage_sections: {
                  type: "array",
                  minItems: 7,
                  maxItems: 10,
                  items: { type: "string" },
                },
                notes_and_assumptions: {
                  type: "array",
                  minItems: 2,
                  maxItems: 4,
                  items: { type: "string" },
                },
              },
              required: [
                "summary",
                "top_issues",
                "quick_wins",
                "headline_rewrite_options",
                "cta_rewrite_options",
                "recommended_homepage_sections",
                "notes_and_assumptions",
              ],
            },
          },
        },
      });

      // Safer extraction
      const aiText = (ai.output_text || "").trim();

      // Useful diagnostics
      console.log("OpenAI response status:", ai.status);
      console.log("OpenAI output_text length:", aiText.length);

      if (!aiText) {
        // Check for refusal or missing content
        const firstOutput = ai.output && ai.output[0];
        const firstContent =
          firstOutput &&
          firstOutput.content &&
          firstOutput.content[0];

        if (firstContent && firstContent.type === "refusal") {
          throw new Error(`Model refusal: ${firstContent.refusal || "No refusal text returned"}`);
        }

        throw new Error("Structured response returned empty output_text");
      }

      let parsed;
      try {
        parsed = JSON.parse(aiText);
      } catch (parseErr) {
        console.error("Failed JSON text:", aiText);
        throw new Error(`Could not parse structured JSON: ${parseErr.message}`);
      }

      report = {
        overall_score: heur.total,
        subscores: heur.subscores,
        summary: parsed.summary,
        top_issues: parsed.top_issues,
        quick_wins: parsed.quick_wins,
        headline_rewrite_options: parsed.headline_rewrite_options,
        cta_rewrite_options: parsed.cta_rewrite_options,
        recommended_homepage_sections: parsed.recommended_homepage_sections,
        notes_and_assumptions: parsed.notes_and_assumptions,
      };
    } catch (e) {
      console.error("OPENAI ERROR:", e);

      report = buildFallbackReport(heur, basics);
      report.notes_and_assumptions = [
        `Fallback mode was used because the AI request failed: ${e?.message || "Unknown error"}`,
        "This automated analysis is based on HTML signals and a limited text sample, so it may miss visual and UX issues.",
      ];
    }
      

      const aiText = (ai.output_text || "").trim();
      const parsed = JSON.parse(aiText);

      report = {
        overall_score: heur.total,
        subscores: heur.subscores,
        summary: parsed.summary,
        top_issues: parsed.top_issues,
        quick_wins: parsed.quick_wins,
        headline_rewrite_options: parsed.headline_rewrite_options,
        cta_rewrite_options: parsed.cta_rewrite_options,
        recommended_homepage_sections: parsed.recommended_homepage_sections,
        notes_and_assumptions: parsed.notes_and_assumptions,
      };
    } catch (e) {
      console.error("OPENAI ERROR:", e);
      report = buildFallbackReport(heur, basics);
    }

    return safeJson(res, 200, {
      url: targetUrl,
      baseline: { overall: heur.total, subscores: heur.subscores, basics },
      report,
    });
  } catch (err) {
    return safeJson(res, 500, { error: err?.message || "Server error" });
  }
};
