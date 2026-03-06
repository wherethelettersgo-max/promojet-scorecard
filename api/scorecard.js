/**
 * /api/scorecard.js  (CommonJS for Vercel)
 *
 * Required env vars:
 * - OPENAI_API_KEY
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
      /\b(website|web design|graphic design|branding|maintenance|hosting|support|conversion|seo|landing page)\b/gi
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
  let summaryParts = [];

  if (heur.subscores.clarity >= 14) {
    summaryParts.push("The page appears to have a reasonably clear headline and message structure.");
  } else if (heur.subscores.clarity >= 8) {
    summaryParts.push("The page shows some message clarity, but the value proposition may still be too vague.");
  } else {
    summaryParts.push("The page likely lacks clear above-the-fold messaging and may not explain the offer strongly enough.");
  }

  if (heur.subscores.cta >= 14) {
    summaryParts.push("A call to action is present and reasonably visible.");
  } else if (heur.subscores.cta >= 8) {
    summaryParts.push("A call to action appears to exist, but it may need to be more prominent or more specific.");
  } else {
    summaryParts.push("The page may not be guiding visitors clearly toward a next step.");
  }

  if (heur.subscores.trust >= 10) {
    summaryParts.push("Some trust indicators are present, though stronger proof may still improve conversions.");
  } else {
    summaryParts.push("Trust signals appear limited and could be reinforced with testimonials, results, or client proof.");
  }

  const summary = summaryParts.join(" ");

  return {
    overall_score: heur.total,
    subscores: heur.subscores,
    summary,
    top_issues: [
      basics.h1
        ? "Check whether the main headline clearly states who you help and the outcome you deliver."
        : "Missing or unclear main headline (H1).",
      basics.hasCTAWord
        ? "A call to action was detected, but it should be checked for clarity and above-the-fold visibility."
        : "No clear call-to-action language was detected.",
      basics.hasTrustWords
        ? "Trust language exists, but it may need stronger proof such as testimonials, results, or logos."
        : "Few or no trust indicators were detected.",
    ],
    quick_wins: [
      "Add or strengthen a clear above-the-fold headline and subheadline.",
      "Add one strong primary call to action near the top of the page.",
      "Add trust signals such as testimonials, client logos, or guarantees near the first CTA.",
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
    ],
    recommended_homepage_sections: [
      "Hero: headline, subheadline, and primary CTA",
      "Proof: testimonials, logos, or results",
      "Services overview",
      "Why choose us / differentiation",
      "How it works",
      "Second CTA and contact form",
      "FAQ",
      "Footer with trust and contact details",
    ],
    notes_and_assumptions: [
      "Fallback mode was used because the AI service was unavailable or over quota.",
      "This automated analysis is based on HTML signals and may miss visual and UX issues.",
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
    const heur = heuristicScore(basics, text);

    const system = `
You are a conversion-rate optimisation auditor.
Return practical, concise website conversion advice in JSON-compatible plain text sections.
`;

    const user = `
Audit this website for conversion performance.

Business type: ${business_type}
Primary goal: ${goal}
URL: ${targetUrl}

Extracted signals:
Title: ${basics.title}
Meta description: ${basics.metaDesc}
H1: ${basics.h1}
CTA detected: ${basics.hasCTAWord}
Contact email: ${basics.hasEmail}
Phone: ${basics.hasPhone}
Trust indicators detected: ${basics.hasTrustWords}

Baseline conversion subscores:
${JSON.stringify(heur.subscores)}

Provide:
1. Short summary
2. Top 3 issues
3. Top 3 quick wins
4. 3 headline rewrite options
5. 3 CTA rewrite options
6. Recommended homepage section order
7. Notes and assumptions
`;

    let report = null;

    try {
      const ai = await client.responses.create({
        model: process.env.SCORECARD_MODEL || "gpt-5-mini",
        max_output_tokens: 1000,
        temperature: 0.4
        input: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      });

      const aiText = (ai.output_text || "").trim();

      report = {
        overall_score: heur.total,
        subscores: heur.subscores,
        summary: aiText || "AI analysis completed.",
        top_issues: [
          "Review headline clarity and value proposition.",
          "Strengthen the primary call to action.",
          "Add clearer trust signals near the top of the page.",
        ],
        quick_wins: [
          "Tighten the headline to make the offer clearer.",
          "Place one primary CTA above the fold.",
          "Add testimonials, logos, or proof points.",
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
        ],
        recommended_homepage_sections: [
          "Hero: headline, subheadline, and primary CTA",
          "Proof: testimonials, logos, or results",
          "Services overview",
          "Why choose us / differentiation",
          "How it works",
          "Second CTA and contact form",
          "FAQ",
          "Footer with trust and contact details",
        ],
        notes_and_assumptions: [
          "This version uses structured site signals and a concise AI summary.",
          "Visual design and UX were not directly analysed.",
        ],
      };
    } catch (e) {
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
