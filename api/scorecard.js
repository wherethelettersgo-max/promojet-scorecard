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

  // Basic SSRF protection: block localhost
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

  // crude CTA detection
  const ctaRegex =
    /\b(book|call|quote|get a quote|enquire|enquiry|contact|start|buy|shop|subscribe|join|download|request|schedule)\b/i;
  const text = stripTags(html);
  const hasCTAWord = ctaRegex.test(text);

  // contact cues
  const hasEmail = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(html);
  const hasPhone = /(\+?\d[\d\s().-]{7,}\d)/.test(html);

  // trust cues (very rough)
  const trustRegex = /\b(testimonial|reviews?|trusted|clients?|case study|results?|guarantee|rated)\b/i;
  const hasTrustWords = trustRegex.test(text);

  // form detection
  const hasForm = /<form\b/i.test(html);

  return { title, metaDesc, h1, hasCTAWord, hasEmail, hasPhone, hasTrustWords, hasForm };
}

function heuristicScore(basics, text) {
  let clarity = 0; // /20
  let cta = 0; // /20
  let trust = 0; // /15
  let structure = 0; // /15
  let offer = 0; // /15
  let friction = 0; // /15

  // Clarity: H1 exists and is meaningful length
  if (basics.h1.length >= 12 && basics.h1.length <= 90) clarity += 12;
  if (basics.metaDesc.length >= 50 && basics.metaDesc.length <= 170) clarity += 4;
  if (basics.title.length >= 10 && basics.title.length <= 70) clarity += 4;

  // CTA
  if (basics.hasCTAWord) cta += 10;
  if (basics.hasForm) cta += 6;
  if (basics.hasEmail || basics.hasPhone) cta += 4;

  // Trust
  if (basics.hasTrustWords) trust += 10;
  if (basics.hasEmail) trust += 2;
  if (basics.hasPhone) trust += 3;

  // Structure: look for nav-ish cues
  const hasNav = /<nav\b/i.test(text) || /\b(home|about|services|portfolio|contact)\b/i.test(text);
  if (hasNav) structure += 8;

  const headingMentions = (text.match(/\b(how|why|what|services|pricing|process|results)\b/gi) || [])
    .length;
  if (headingMentions >= 5) structure += 7;

  // Offer: detect service-ish terms (tune for PromoJet-like sites)
  const offerHits = (
    text.match(/\b(website|web design|graphic design|branding|maintenance|hosting|support|conversion|seo|landing page)\b/gi) ||
    []
  ).length;
  offer += Math.min(15, offerHits >= 6 ? 15 : offerHits * 2);

  // Friction: penalize if missing contact methods and form
  friction = 15;
  if (!basics.hasForm) friction -= 6;
  if (!basics.hasEmail && !basics.hasPhone) friction -= 6;
  if (!basics.hasCTAWord) friction -= 3;
  friction = Math.max(0, friction);

  const total = clarity + cta + trust + structure + offer + friction; // /100
  return {
    total,
    subscores: { clarity, cta, trust, structure, offer, friction },
  };
}

const SCORECARD_SCHEMA = {
  name: "website_conversion_scorecard",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      overall_score: { type: "integer", minimum: 0, maximum: 100 },
      subscores: {
        type: "object",
        additionalProperties: false,
        properties: {
          clarity: { type: "integer", minimum: 0, maximum: 20 },
          cta: { type: "integer", minimum: 0, maximum: 20 },
          trust: { type: "integer", minimum: 0, maximum: 15 },
          structure: { type: "integer", minimum: 0, maximum: 15 },
          offer: { type: "integer", minimum: 0, maximum: 15 },
          friction: { type: "integer", minimum: 0, maximum: 15 },
        },
        required: ["clarity", "cta", "trust", "structure", "offer", "friction"],
      },
      summary: { type: "string" },
      top_issues: {
        type: "array",
        minItems: 3,
        maxItems: 7,
        items: { type: "string" },
      },
      quick_wins: {
        type: "array",
        minItems: 3,
        maxItems: 7,
        items: { type: "string" },
      },
      headline_rewrite_options: {
        type: "array",
        minItems: 3,
        maxItems: 6,
        items: { type: "string" },
      },
      cta_rewrite_options: {
        type: "array",
        minItems: 3,
        maxItems: 6,
        items: { type: "string" },
      },
      recommended_homepage_sections: {
        type: "array",
        minItems: 6,
        maxItems: 12,
        items: { type: "string" },
      },
      notes_and_assumptions: {
        type: "array",
        minItems: 1,
        maxItems: 6,
        items: { type: "string" },
      },
    },
    required: [
      "overall_score",
      "subscores",
      "summary",
      "top_issues",
      "quick_wins",
      "headline_rewrite_options",
      "cta_rewrite_options",
      "recommended_homepage_sections",
      "notes_and_assumptions",
    ],
  },
};

module.exports = async function handler(req, res) {
  // ===== CORS (required for browser calls from promojet.com.au) =====
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

  // Handle browser preflight request
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  // ================================================================
  // Guard: allow only POST
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return safeJson(res, 405, { error: "Use POST" });
  }

  try {
    // Safer body handling: Vercel may provide object or string
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }
    body = body || {};

    const { url, business_type = "service_business", goal = "generate_leads" } = body;
    if (!url) return safeJson(res, 400, { error: "Missing url" });

    const targetUrl = normalizeUrl(url);

    const maxBytes = parseInt(process.env.SCORECARD_MAX_HTML_BYTES || "600000", 10);

    // Fetch target HTML
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

    if (!resp || !resp.ok) return safeJson(res, 400, { error: `Fetch failed: ${resp?.status || "unknown"}` });

    const html = (await resp.text()).slice(0, maxBytes);
    const basics = extractBasics(html);
    const text = stripTags(html);

    const heur = heuristicScore(basics, text);

    const model = process.env.SCORECARD_MODEL || "gpt-5";

    const system = `
You are a conversion-rate optimisation (CRO) auditor.
You must produce a strict JSON object that matches the provided JSON schema.
Be direct, practical, and avoid fluff.
If something is unknown, say so in notes_and_assumptions.
`;

    const user = `
Audit this website for conversion performance.

Business type: ${business_type}
Primary goal: ${goal}
URL: ${targetUrl}

Extracted signals:
- title: ${basics.title || "(missing)"}
- meta description: ${basics.metaDesc || "(missing)"}
- h1: ${basics.h1 || "(missing)"}
- hasCTAWord: ${basics.hasCTAWord}
- hasForm: ${basics.hasForm}
- hasEmail: ${basics.hasEmail}
- hasPhone: ${basics.hasPhone}
- hasTrustWords: ${basics.hasTrustWords}

Heuristic subscores (baseline):
${JSON.stringify(heur.subscores)}

Page text sample (first 3500 chars):
${text.slice(0, 3500)}

Instructions:
- Start from the heuristic baseline, but you may adjust subscores if the text clearly supports it.
- Emphasize above-the-fold clarity, value proposition, CTA strength, trust signals, and friction.
- Provide:
  - top_issues: biggest blockers
  - quick_wins: highest impact / lowest effort
  - headline_rewrite_options: write in a clear "who + outcome" style
  - cta_rewrite_options: specific, action-oriented
  - recommended_homepage_sections: ordered list of sections for a high-converting homepage
`;

    // Call OpenAI Responses API with structured JSON output
    const ai = await client.responses.create({
      model,
      input: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      text: {
        format: {
          type: "json_schema",
          name: SCORECARD_SCHEMA.name,
          strict: SCORECARD_SCHEMA.strict,
          schema: SCORECARD_SCHEMA.schema,
        },
        verbosity: "medium",
      },
    });

    // output_text should contain the JSON text per schema
    const jsonText = ai.output_text || "";
    const report = JSON.parse(jsonText);

    return safeJson(res, 200, {
      url: targetUrl,
      baseline: { overall: heur.total, subscores: heur.subscores, basics },
      report,
    });
  } catch (err) {
    return safeJson(res, 500, { error: err?.message || "Server error" });
  }
};
