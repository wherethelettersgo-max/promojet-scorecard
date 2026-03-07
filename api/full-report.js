/**
 * /api/full-report.js  (Unlocked full report)
 *
 * Required env vars:
 * - OPENAI_API_KEY
 *
 * Optional:
 * - SCORECARD_MAX_HTML_BYTES (default 600000)
 * - SCORECARD_MODEL (default "gpt-5-mini")
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

  return noScripts
    .replace(/<\/(p|div|br|li|h\\d|section|article|header|footer|nav)>/gi, "\n")
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

  const callToActionRegex =
    /\b(book|call|get a quote|quote|enquire|enquiry|contact|start|buy|shop|subscribe|join|download|request|schedule)\b/i;
  const hasCallToActionWord = callToActionRegex.test(text);

  const hasEmail = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(html);
  const hasPhone = /(\+?\d[\d\s().-]{7,}\d)/.test(html);

  const trustRegex =
    /\b(testimonial|reviews?|trusted|clients?|case study|results?|guarantee|rated)\b/i;
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
    const pageSample = text.slice(0, 2200);

    const ai = await client.responses.create({
      model: process.env.SCORECARD_MODEL || "gpt-5-mini",
      max_output_tokens: 1500,
      input: [
        {
          role: "system",
          content:
            "You are an expert conversion rate optimisation consultant writing the full unlocked section of a website audit. Return only strict JSON. Be specific, commercially useful, and practical. Use 'Call to Action' not 'CTA'."
        },
        {
          role: "user",
          content: `Create the full unlocked CRO report for this website.

Business type: ${business_type}
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

Page content sample:
${pageSample}

Return only JSON with:
- headline_rewrite_options (3 items)
- cta_rewrite_options (3 items)
- recommended_homepage_sections (7 items)
- notes_and_assumptions (2 items)

Make the suggestions specific to this business and page.`
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "promojet_full_unlock_report",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              headline_rewrite_options: {
                type: "array",
                minItems: 3,
                maxItems: 3,
                items: { type: "string" }
              },
              cta_rewrite_options: {
                type: "array",
                minItems: 3,
                maxItems: 3,
                items: { type: "string" }
              },
              recommended_homepage_sections: {
                type: "array",
                minItems: 7,
                maxItems: 7,
                items: { type: "string" }
              },
              notes_and_assumptions: {
                type: "array",
                minItems: 2,
                maxItems: 2,
                items: { type: "string" }
              }
            },
            required: [
              "headline_rewrite_options",
              "cta_rewrite_options",
              "recommended_homepage_sections",
              "notes_and_assumptions"
            ]
          }
        }
      }
    });

    const aiText = (ai.output_text || "").trim();

    if (ai.status === "incomplete") {
      throw new Error(
        `OpenAI full-report incomplete: ${ai.incomplete_details?.reason || "unknown_reason"}`
      );
    }

    if (!aiText) {
      throw new Error("OpenAI full-report returned empty output_text");
    }

    const parsed = JSON.parse(aiText);

    return safeJson(res, 200, {
      url: targetUrl,
      report: parsed,
    });
  } catch (err) {
    return safeJson(res, 500, { error: err?.message || "Server error" });
  }
};
