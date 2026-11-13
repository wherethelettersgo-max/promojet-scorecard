/**
 * /api/save-lead.js
 *
 * Emails each lead to you via Resend (https://resend.com). No database.
 *
 * Required env vars:
 * - RESEND_API_KEY
 * - LEAD_NOTIFY_EMAIL   (where leads are sent, e.g. you@promojet.com.au)
 *
 * Optional:
 * - LEAD_FROM_EMAIL     (default "PromoJet Scorecard <onboarding@resend.dev>";
 *                        use an address on a domain verified in Resend once set up)
 */

function safeJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj, null, 2));
}

function cleanText(value, maxLen) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, maxLen);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

async function sendLeadEmail(lead) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.LEAD_NOTIFY_EMAIL;
  const from = process.env.LEAD_FROM_EMAIL || "PromoJet Scorecard <onboarding@resend.dev>";

  if (!apiKey || !to) {
    throw new Error("Lead email is not configured (RESEND_API_KEY / LEAD_NOTIFY_EMAIL).");
  }

  const rows = [
    ["Name", lead.name || "(not given)"],
    ["Email", lead.email],
    ["Website", lead.website_url || "(not given)"],
    ["Score", lead.score ?? "(none)"],
    ["Submitted", lead.created_at],
    ["IP", lead.ip],
  ];

  const html = `<h2>New scorecard lead</h2>
<table cellpadding="6" style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
${rows
  .map(
    ([k, v]) =>
      `<tr><td style="color:#666"><strong>${escapeHtml(k)}</strong></td><td>${escapeHtml(v)}</td></tr>`
  )
  .join("\n")}
</table>`;

  const text = rows.map(([k, v]) => `${k}: ${v}`).join("\n");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  let r;
  try {
    r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: to.split(",").map((s) => s.trim()).filter(Boolean),
        reply_to: lead.email,
        subject: `New scorecard lead: ${lead.website_url || lead.email}${
          lead.score != null ? ` (score ${lead.score})` : ""
        }`,
        html,
        text,
      }),
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    console.error("RESEND ERROR:", r.status, detail);
    throw new Error(`Email send failed (${r.status})`);
  }

  return r.json();
}

module.exports = async function handler(req, res) {
  res.setHeader("X-PromoJet-Version", "save-lead-email-v1");

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

    const lead = {
      name,
      email,
      website_url,
      score,
      ip,
      created_at: new Date().toISOString(),
    };

    const sent = await sendLeadEmail(lead);

    return safeJson(res, 200, {
      success: true,
      message: "Lead saved",
      lead_id: sent?.id || null,
    });
  } catch (err) {
    console.error("SAVE-LEAD ERROR:", err);
    return safeJson(res, 500, { error: err?.message || "Server error" });
  }
};
