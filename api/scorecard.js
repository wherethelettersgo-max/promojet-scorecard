/**
 * /api/scorecard.js  (CommonJS for Vercel)
 *
 * Required env vars:
 * - OPENAI_API_KEY
 *
 * Optional:
 * - SCORECARD_MAX_HTML_BYTES (default 600000)
 * - SCORECARD_MODEL (default "gpt-5")
 */

const OpenAI = require("openai");

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

  const text = noScripts
    .replace(/<\/(p|div|br|li|h\d|section|article|header|footer|nav)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

  return text;
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
    (text.match(/\b(how|why|what|services|pricing|process|results)\b/gi) || [])
      .length;

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

module.exports = async function handler(req, res) {

  // CORS
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
      try { body = JSON.parse(body); } catch { body = {}; }
    }

    body = body || {};

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
Provide practical advice based on the signals given.
`;

    const user = `
Audit this website.

Title: ${basics.title}
Meta description: ${basics.metaDesc}
H1: ${basics.h1}

CTA detected: ${basics.hasCTAWord}
Email detected: ${basics.hasEmail}
Phone detected: ${basics.hasPhone}
Trust signals: ${basics.hasTrustWords}

Baseline scores:
${JSON.stringify(heur.subscores)}

Goal: ${goal}
Business type: ${business_type}
`;

    let report = null;

    try {

      const ai = await client.responses.create({
        model: process.env.SCORECARD_MODEL || "gpt-5-mini",
        input: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      });

      report = {
        overall_score: heur.total,
        subscores: heur.subscores,
        summary: ai.output_text,
      };

    } catch (e) {

      report = {
        overall_score: heur.total,
        subscores: heur.subscores,
        summary:
          "AI analysis unavailable. Showing baseline automated analysis.",
      };

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
