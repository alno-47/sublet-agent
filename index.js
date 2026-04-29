const express = require("express");
const app = express();
app.use(express.json());

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const TWILIO_SID = process.env.TWILIO_SID;
const TWILIO_TOKEN = process.env.TWILIO_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM;
const ALERT_PHONE = process.env.ALERT_PHONE;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const SUMMARY_EMAIL = "anovikov@mba2027.hbs.edu";
const DATABASE_URL = process.env.DATABASE_URL;
const DRY_RUN = process.env.DRY_RUN !== "false";
const PORT = process.env.PORT || 3000;

let isFetching = false;
let db = null;
let lastFetchTime = null;

const APARTMENT_PHOTOS = [
  "https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=600&q=80",
  "https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=600&q=80",
  "https://images.unsplash.com/photo-1484154218962-a197022b5858?w=600&q=80",
  "https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=600&q=80",
  "https://images.unsplash.com/photo-1493809842364-78817add7ffb?w=600&q=80",
  "https://images.unsplash.com/photo-1512917774080-9991f1c4c750?w=600&q=80",
  "https://images.unsplash.com/photo-1574362848149-11496d93a7c7?w=600&q=80",
  "https://images.unsplash.com/photo-1556912173-3bb406ef7e77?w=600&q=80",
  "https://images.unsplash.com/photo-1565183928294-7063f23ce0f8?w=600&q=80",
  "https://images.unsplash.com/photo-1554995207-c18c203602cb?w=600&q=80",
];

function timeAgo(date) {
  if (!date) return null;
  const s = Math.floor((Date.now() - new Date(date)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchListingDetail(url, idx) {
  try {
    await sleep(300 + Math.random() * 400);
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://newyork.craigslist.org/search/mnh/sub"
      }
    });
    if (!res.ok) return null;
    const html = await res.text();
    const titleMatch = html.match(/<span\s+id="titletextonly"[^>]*>([\s\S]*?)<\/span>/i) ||
                       html.match(/<h1[^>]*class="[^"]*postingtitle[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : "";
    const priceMatch = html.match(/class="[^"]*price[^"]*"[^>]*>\s*(\$[\d,]+)/i) ||
                       html.match(/(\$[\d,]+)\s*(?:\/mo|per month)?/i);
    const price = priceMatch ? priceMatch[1] : "";
    const bodyMatch = html.match(/<section\s+id="postingbody"[^>]*>([\s\S]*?)<\/section>/i);
    const post = bodyMatch ? bodyMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 800) : "";
    const brMatch = (title + " " + post).match(/(\d)\s*b(?:r|ed(?:room)?s?)/i);
    const bedrooms = brMatch ? parseInt(brMatch[1]) : 2;
    const locMatch = html.match(/class="[^"]*mapaddress[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i) ||
                     html.match(/<small[^>]*>\(([^)]+)\)<\/small>/i);
    const location = locMatch ? locMatch[1].replace(/<[^>]+>/g, "").trim() : "Manhattan, NY";
    const availMatch = post.match(/avail(?:able)?(?:\s+(?:starting|from|on|beginning))?\s+([a-z]+\s+\d+|\d+\/\d+)/i) ||
                       html.match(/available\s+([a-z]+ \d+)/i);
    const availableFrom = availMatch ? "available " + availMatch[1].toLowerCase() : "";
    const phoneMatches = html.match(/\+?1?\s*[-.]?\s*\(?\d{3}\)?\s*[-.]?\s*\d{3}\s*[-.]?\s*\d{4}/g) || [];
    const phoneNumbers = [...new Set(phoneMatches)].slice(0, 2);
    const amenities = [];
    const amenityMap = { laundry: "laundry", parking: "parking", cats_ok: "cats OK", dogs_ok: "dogs OK", is_furnished: "furnished", air_conditioning: "A/C", no_smoking: "no smoking" };
    for (const [k, v] of Object.entries(amenityMap)) { if (html.includes(k)) amenities.push(v); }
    const imgMatches = html.matchAll(/https:\/\/images\.craigslist\.org\/[^"'\s]+_600x450\.jpg/g);
    const pics = [...new Set([...imgMatches].map(m => m[0]))].slice(0, 3);
    return { title, price, post, bedrooms, location, availableFrom, phoneNumbers, amenities, pics };
  } catch (e) { console.error(`Failed to fetch ${url}:`, e.message); return null; }
}

async function initDb() {
  const { default: pg } = await import("pg");
  const { Pool } = pg;
  db = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.query(`
    CREATE TABLE IF NOT EXISTS listings (id TEXT PRIMARY KEY, data JSONB NOT NULL, created_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS actions (id SERIAL PRIMARY KEY, listing_id TEXT NOT NULL, user_name TEXT NOT NULL, action TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS comments (id SERIAL PRIMARY KEY, listing_id TEXT NOT NULL, user_name TEXT NOT NULL, body TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS seen (id SERIAL PRIMARY KEY, listing_id TEXT NOT NULL UNIQUE, seen_by TEXT NOT NULL, seen_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  const r = await db.query("SELECT value FROM meta WHERE key='last_fetch'");
  if (r.rows.length) lastFetchTime = r.rows[0].value;
  console.log("Database ready");
}

async function loadListings() {
  if (!db) return [];
  try { const r = await db.query("SELECT data FROM listings ORDER BY created_at DESC LIMIT 200"); return r.rows.map(r => r.data); }
  catch (e) { return []; }
}
async function loadActions() {
  if (!db) return [];
  try { const r = await db.query("SELECT * FROM actions ORDER BY created_at DESC"); return r.rows; }
  catch (e) { return []; }
}
async function loadComments() {
  if (!db) return [];
  try { const r = await db.query("SELECT * FROM comments ORDER BY created_at ASC"); return r.rows; }
  catch (e) { return []; }
}
async function loadSeen() {
  if (!db) return new Set();
  try { const r = await db.query("SELECT listing_id FROM seen"); return new Set(r.rows.map(r => r.listing_id)); }
  catch (e) { return new Set(); }
}
async function markAllSeen(listingIds, userName) {
  if (!db || !listingIds.length) return;
  for (const id of listingIds) {
    try { await db.query("INSERT INTO seen (listing_id, seen_by) VALUES ($1, $2) ON CONFLICT (listing_id) DO NOTHING", [id, userName]); } catch (e) {}
  }
}
async function saveListing(listing) {
  if (!db) return;
  try { await db.query("INSERT INTO listings (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2", [listing.id, JSON.stringify(listing)]); }
  catch (e) { console.error("Failed to save listing:", e.message); }
}
async function saveAction(lid, un, action) {
  if (!db) return;
  await db.query("INSERT INTO actions (listing_id, user_name, action) VALUES ($1, $2, $3)", [lid, un, action]);
}
async function saveComment(lid, un, body) {
  if (!db) return;
  await db.query("INSERT INTO comments (listing_id, user_name, body) VALUES ($1, $2, $3)", [lid, un, body]);
}

function passes(l) {
  if ((l.bedrooms || 0) < 2) return false;
  const bad = ["Brooklyn", "Queens", "Bronx", "Jersey City", "Ridgewood", "Woodside", "Long Island City"];
  if (bad.some(b => (l.location || "").includes(b) || (l.address?.city || "").includes(b))) return false;
  const av = (l.availableFrom || "").toLowerCase();
  if (av.includes("jul") || av.includes("aug") || av.includes("sep")) return false;
  return true;
}

async function fetchListings() {
  console.log("Fetching listing index...");
  const res = await fetch("https://newyork.craigslist.org/search/mnh/sub?min_bedrooms=2&max_bedrooms=3", {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", "Accept": "text/html" }
  });
  const html = await res.text();
  const pat = /href="(https:\/\/newyork\.craigslist\.org\/mnh\/sub\/d\/[^"]+)"/g;
  let m; const links = [];
  while ((m = pat.exec(html)) !== null) { if (!links.includes(m[1])) links.push(m[1]); }
  console.log(`Found ${links.length} listing links, fetching details for up to 20...`);
  const items = [];
  for (let i = 0; i < Math.min(links.length, 20); i++) {
    const link = links[i];
    const id = (link.match(/(\d+)\.html/) || [])[1] || Math.random().toString(36).slice(2);
    console.log(`Fetching listing ${i + 1}/20: ${id}`);
    const detail = await fetchListingDetail(link, i);
    if (detail && detail.title) {
      items.push({ id, title: detail.title, url: link, post: detail.post, price: detail.price, bedrooms: detail.bedrooms, location: detail.location || "Manhattan, NY", availableFrom: detail.availableFrom, datetime: new Date().toISOString(), phoneNumbers: detail.phoneNumbers || [], amenities: detail.amenities || [], platform: "Craigslist", address: { city: "New York" }, pics: detail.pics?.length ? detail.pics : [APARTMENT_PHOTOS[i % APARTMENT_PHOTOS.length]] });
    } else {
      items.push({ id, title: "Manhattan Sublet", url: link, post: "", price: "", bedrooms: 2, location: "Manhattan, NY", availableFrom: "", datetime: new Date().toISOString(), phoneNumbers: [], amenities: [], platform: "Craigslist", address: { city: "New York" }, pics: [APARTMENT_PHOTOS[i % APARTMENT_PHOTOS.length]] });
    }
  }
  console.log(`Successfully fetched details for ${items.length} listings`);
  return items;
}

async function generateDraftAndScore(l) {
  const system = `You help three HBS students (Alex from Germany, Julian from Germany, Nora from Austria) find a 2-3BR Manhattan sublet for June-August 2026. Return ONLY valid JSON with these exact fields:
{"inApp":"...","email":{"subject":"...","body":"..."},"sms":"...","whatsapp":"...","score":7,"scoreReason":"one sentence","availableFrom":"june"}

inApp: Short casual Craigslist internal message, 3-4 sentences. Say they are 3 HBS students looking for a summer sublet June-August 2026, ask if still available and about the price. Sign off "- Alex, Julian & Nora". No Dear/Hi, just get to the point.

email: Professional but warm. Subject line should mention dates and bedroom count. Body introduces all three as HBS MBA students, mentions they are responsible international students, confirms exact dates (June 1 - Aug 31), asks about availability, price, and viewing. Sign off "Alex, Julian & Nora".

sms: Max 2 sentences. Just: who they are, what they want, the dates. No sign-off needed.

whatsapp: Casual and friendly, 3-5 sentences. Similar to inApp but slightly warmer, can use an emoji or two. Sign off "Alex, Julian & Nora".

score: 1-10 strictly on price ($4-8k/mo ideal), Manhattan location, June availability, furnished status.

availableFrom: Extract the availability month from the listing as a lowercase string - one of: "may", "june", "july", "august", "september", or "unknown". Use the description to infer this even if not explicitly stated.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, system, messages: [{ role: "user", content: `Title: ${l.title}\nPrice: ${l.price}\nLocation: ${l.location}\nBedrooms: ${l.bedrooms}\nAvailable: ${l.availableFrom}\nDescription: ${(l.post || "").slice(0, 400)}\nAmenities: ${(l.amenities || []).join(", ")}` }] })
  });
  const data = await res.json();
  return JSON.parse((data.content?.[0]?.text || "{}").replace(/```json|```/g, "").trim());
}

async function sendSms(to, body) {
  if (DRY_RUN) { console.log(`[DRY RUN] SMS to ${to}`); return { dryRun: true }; }
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64") }, body: new URLSearchParams({ To: to, From: TWILIO_FROM, Body: body }).toString() });
  return await res.json();
}

async function sendAlertToMe(count) {
  if (!TWILIO_SID || !ALERT_PHONE || DRY_RUN) return;
  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64") }, body: new URLSearchParams({ To: ALERT_PHONE, From: TWILIO_FROM, Body: `${count} new NYC sublet${count > 1 ? "s" : ""} found. Review: https://sublet-agent-production.up.railway.app` }).toString() });
}

async function sendDailySummaryEmail() {
  if (!SENDGRID_API_KEY) { console.log("No SendGrid key, skipping daily summary"); return; }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const listings = await loadListings();
  const actions = await loadActions();
  const todayListings = listings.filter(l => new Date(l.datetime) >= today);
  const todayContacted = actions.filter(a => a.action === "contacted" && new Date(a.created_at) >= today);
  const todayReplies = actions.filter(a => a.action === "reply" && new Date(a.created_at) >= today);
  const todayViewings = actions.filter(a => a.action === "viewing" && new Date(a.created_at) >= today);
  const totalContacted = actions.filter(a => a.action === "contacted");
  const totalReplies = actions.filter(a => a.action === "reply");
  const prices = todayListings.map(l => { const m = (l.price || "").replace(/,/g, "").match(/\d+/); return m ? parseInt(m[0]) : 0; }).filter(p => p > 0);
  const avgPrice = prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : 0;
  const top3 = listings.filter(l => l.score && new Date(l.datetime) >= today).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 3);
  const dateStr = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const topListingsHtml = top3.length ? top3.map((l, i) => `<tr><td style="padding:10px;border-bottom:1px solid #f0f0f0"><strong style="color:#18181b">${i + 1}. ${(l.title || "Manhattan Sublet").slice(0, 50)}</strong><br><span style="color:#71717a;font-size:13px">${l.location || "Manhattan"} · ${l.price || "price TBD"} · Score: ${l.score}/10</span><br><span style="color:#a1a1aa;font-size:12px;font-style:italic">${l.scoreReason || ""}</span><br><a href="${l.url}" style="color:#0070f3;font-size:13px;text-decoration:none">View listing</a></td></tr>`).join("") : `<tr><td style="padding:10px;color:#71717a">No new scored listings today.</td></tr>`;
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f7f7f5;margin:0;padding:24px"><div style="max-width:560px;margin:0 auto"><div style="background:#0070f3;border-radius:12px 12px 0 0;padding:24px 28px;color:white"><div style="font-size:20px;font-weight:700;margin-bottom:4px">Summer Sublet Agent</div><div style="font-size:14px;opacity:0.85">Daily Summary - ${dateStr}</div></div><div style="background:white;padding:24px 28px;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><table style="width:100%;border-collapse:collapse;margin-bottom:24px"><tr><td style="padding:12px;background:#f4f4f5;border-radius:8px;text-align:center;width:25%"><div style="font-size:26px;font-weight:700;color:#0070f3">${todayListings.length}</div><div style="font-size:12px;color:#71717a;margin-top:2px">New today</div></td><td style="width:4%"></td><td style="padding:12px;background:#f4f4f5;border-radius:8px;text-align:center;width:25%"><div style="font-size:26px;font-weight:700;color:#00a651">${todayContacted.length}</div><div style="font-size:12px;color:#71717a;margin-top:2px">Contacted</div></td><td style="width:4%"></td><td style="padding:12px;background:#f4f4f5;border-radius:8px;text-align:center;width:25%"><div style="font-size:26px;font-weight:700;color:#7c3aed">${todayReplies.length}</div><div style="font-size:12px;color:#71717a;margin-top:2px">Replies</div></td><td style="width:4%"></td><td style="padding:12px;background:#f4f4f5;border-radius:8px;text-align:center;width:25%"><div style="font-size:26px;font-weight:700;color:#f59e0b">${todayViewings.length}</div><div style="font-size:12px;color:#71717a;margin-top:2px">Viewings</div></td></tr></table>${avgPrice ? `<div style="background:#e8f2ff;border-radius:8px;padding:12px 16px;margin-bottom:24px;font-size:14px;color:#0051a8">Average listing price today: <strong>$${avgPrice.toLocaleString()}/mo</strong></div>` : ""}<div style="margin-bottom:8px;font-size:11px;font-weight:700;color:#a1a1aa;text-transform:uppercase;letter-spacing:0.8px">Top listings today</div><table style="width:100%;border-collapse:collapse;margin-bottom:24px">${topListingsHtml}</table><div style="background:#f4f4f5;border-radius:8px;padding:12px 16px;margin-bottom:24px;font-size:13px;color:#71717a"><strong style="color:#18181b">All time:</strong> ${listings.length} listings found - ${totalContacted.length} contacted - ${totalReplies.length} replies received</div><a href="https://sublet-agent-production.up.railway.app" style="display:block;background:#0070f3;color:white;text-align:center;padding:12px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">Open Summer Sublet Agent</a></div><div style="background:#f4f4f5;border-radius:0 0 12px 12px;padding:14px 28px;border:1px solid #e4e4e7;border-top:none;font-size:12px;color:#a1a1aa;text-align:center">Sent automatically every evening - Manhattan - June-August 2026</div></div></body></html>`;
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SENDGRID_API_KEY}` }, body: JSON.stringify({ personalizations: [{ to: [{ email: SUMMARY_EMAIL }] }], from: { email: "noreply@subletfinder.app", name: "Summer Sublet Agent" }, subject: `Sublet Daily Summary - ${todayListings.length} new listings - ${dateStr}`, content: [{ type: "text/html", value: html }] }) });
  if (res.ok) console.log("Daily summary email sent to", SUMMARY_EMAIL);
  else { const err = await res.text(); console.error("SendGrid error:", err); }
}

function scheduleDailySummary() {
  const now = new Date(); const next7pm = new Date(); next7pm.setHours(19, 0, 0, 0);
  if (now >= next7pm) next7pm.setDate(next7pm.getDate() + 1);
  const msUntil = next7pm - now;
  console.log(`Daily summary scheduled in ${Math.round(msUntil / 60000)} minutes`);
  setTimeout(() => { sendDailySummaryEmail().catch(console.error); setInterval(() => sendDailySummaryEmail().catch(console.error), 24 * 60 * 60 * 1000); }, msUntil);
}

async function fetchAndProcess() {
  if (isFetching) return 0;
  isFetching = true;
  try {
    const items = await fetchListings();
    const eligible = items.filter(passes);
    const existing = await loadListings();
    const seen = new Set(existing.map(l => l.id));
    const newListings = eligible.filter(l => !seen.has(l.id));
    console.log(`${newListings.length} new listings after filtering`);
    for (const l of newListings) {
      try {
        const r = await generateDraftAndScore(l);
        l.drafts = { inApp: r.inApp, email: r.email, sms: r.sms, whatsapp: r.whatsapp };
        l.score = r.score;
        l.scoreReason = r.scoreReason;
        if (r.availableFrom && r.availableFrom !== "unknown") l.availableFrom = r.availableFrom;
      } catch (e) { console.error("Draft failed:", e.message); }
      if (l.phoneNumbers?.length > 0 && l.drafts) { const r = await sendSms(l.phoneNumbers[0], l.drafts.sms); l.smsSent = !r?.dryRun; l.smsDryRun = r?.dryRun || false; } else { l.needsManualSend = true; }
      await saveListing(l);
    }
    if (newListings.length > 0) await sendAlertToMe(newListings.length);
    lastFetchTime = new Date().toISOString();
    if (db) await db.query("INSERT INTO meta (key, value) VALUES ('last_fetch', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [lastFetchTime]);
    return newListings.length;
  } finally { isFetching = false; }
}

app.post("/send-sms", async (req, res) => {
  const { listingId, userName } = req.body;
  if (!listingId || !userName) return res.status(400).json({ error: "Missing listingId or userName" });
  const listings = await loadListings();
  const l = listings.find(x => x.id === listingId);
  if (!l) return res.status(404).json({ error: "Listing not found" });
  if (!l.phoneNumbers?.length) return res.status(400).json({ error: "No phone number available" });
  if (!l.drafts?.sms) return res.status(400).json({ error: "No SMS draft available" });
  const result = await sendSms(l.phoneNumbers[0], l.drafts.sms);
  if (result.dryRun) { await saveAction(listingId, userName, "contacted"); return res.json({ success: true, dryRun: true }); }
  if (result.sid) { await saveAction(listingId, userName, "contacted"); return res.json({ success: true, sid: result.sid }); }
  return res.status(500).json({ error: result.message || "SMS failed" });
});

app.post("/action", async (req, res) => { const { listingId, userName, action } = req.body; if (!listingId || !userName || !action) return res.status(400).json({ error: "Missing" }); await saveAction(listingId, userName, action); res.json({ success: true }); });
app.post("/comment", async (req, res) => { const { listingId, userName, body } = req.body; if (!listingId || !userName || !body) return res.status(400).json({ error: "Missing" }); await saveComment(listingId, userName, body); res.json({ success: true }); });
app.post("/seen", async (req, res) => { const { listingIds, userName } = req.body; if (!listingIds || !userName) return res.status(400).json({ error: "Missing" }); await markAllSeen(listingIds, userName); res.json({ success: true }); });
app.get("/refresh", async (req, res) => { try { const count = await fetchAndProcess(); res.json({ success: true, newListings: count, dryRun: DRY_RUN }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get("/test-email", async (req, res) => { try { await sendDailySummaryEmail(); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); } });

app.get("/", async (req, res) => {
  const [listings, actions, comments, seenSet] = await Promise.all([loadListings(), loadActions(), loadComments(), loadSeen()]);
  const actionMap = {}; actions.forEach(a => { if (!actionMap[a.listing_id]) actionMap[a.listing_id] = []; actionMap[a.listing_id].push(a); });
  const commentMap = {}; comments.forEach(c => { if (!commentMap[c.listing_id]) commentMap[c.listing_id] = []; commentMap[c.listing_id].push(c); });
  const newIds = listings.filter(l => !seenSet.has(l.id)).map(l => l.id);
  const prices = listings.map(l => { const m = (l.price || "").replace(/,/g, "").match(/\d+/); return m ? parseInt(m[0]) : 0; }).filter(p => p > 0);
  const avgPrice = prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : 0;
  const maxPrice = Math.max(...prices, 10000);
  const lastUpdated = lastFetchTime ? timeAgo(lastFetchTime) : "never";
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayCount = listings.filter(l => new Date(l.datetime) >= today).length;
  const LOGO_SVG = `<svg width="36" height="36" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="36" height="36" rx="8" fill="#0070f3"/><path d="M18 8L30 18H27V28H9V18H6L18 8Z" fill="white"/><rect x="14" y="20" width="8" height="8" rx="1.5" fill="#0070f3"/></svg>`;

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Summer Sublet Agent</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 36 36'><rect width='36' height='36' rx='8' fill='%230070f3'/><path d='M18 8L30 18H27V28H9V18H6L18 8Z' fill='white'/><rect x='14' y='20' width='8' height='8' rx='1.5' fill='%230070f3'/></svg>">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --blue:#0070f3;--blue-dark:#0051a8;--blue-light:#e8f2ff;
  --green:#00a651;--green-bg:#e6f7ee;
  --amber:#f59e0b;--amber-bg:#fffbeb;
  --red:#e53e3e;--red-bg:#fff5f5;
  --purple:#7c3aed;--purple-bg:#f5f3ff;
  --gray-50:#fafafa;--gray-100:#f4f4f5;--gray-200:#e4e4e7;
  --gray-300:#d4d4d8;--gray-400:#a1a1aa;--gray-500:#71717a;
  --gray-700:#3f3f46;--gray-900:#18181b;
  --white:#ffffff;
  --r-sm:6px;--r:10px;--r-lg:16px;
  --sh-sm:0 1px 2px rgba(0,0,0,0.06);
  --sh:0 2px 8px rgba(0,0,0,0.08),0 1px 2px rgba(0,0,0,0.04);
  --sh-lg:0 8px 30px rgba(0,0,0,0.12),0 2px 8px rgba(0,0,0,0.06);
}
body{font-family:'Inter',sans-serif;background:var(--gray-50);color:var(--gray-900);min-height:100vh;font-size:14px;line-height:1.5}
nav{background:var(--white);border-bottom:1px solid var(--gray-200);padding:0 32px;height:60px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:200;box-shadow:var(--sh-sm)}
.nav-brand{display:flex;align-items:center;gap:10px}
.nav-logo{display:flex;align-items:center;flex-shrink:0}
.nav-title{font-size:15px;font-weight:700;letter-spacing:-0.3px}
.nav-sub{font-size:12px;color:var(--gray-400);margin-top:1px}
.user-wrap{position:relative}
.user-btn{height:36px;padding:0 14px;border-radius:20px;border:1.5px solid var(--gray-200);background:var(--white);cursor:pointer;font-size:13px;font-weight:500;font-family:'Inter',sans-serif;color:var(--gray-700);display:flex;align-items:center;gap:8px;transition:all 0.15s}
.user-btn:hover{border-color:var(--blue);color:var(--blue)}
.user-btn.has-user{border-color:var(--blue);color:var(--blue);background:var(--blue-light)}
.uav{width:22px;height:22px;border-radius:50%;background:var(--blue);color:white;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center}
.uav.j{background:var(--purple)}.uav.n{background:#db2777}.uav.m{background:#059669}
.chevron{font-size:10px;color:var(--gray-400);transition:transform 0.15s}
.user-btn.open .chevron{transform:rotate(180deg)}
.user-menu{position:absolute;top:calc(100% + 8px);right:0;background:var(--white);border:1px solid var(--gray-200);border-radius:var(--r);box-shadow:var(--sh-lg);min-width:200px;overflow:hidden;display:none;z-index:300}
.user-menu.open{display:block}
.udiv{height:1px;background:var(--gray-200);margin:4px 0}
.uopt{display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:pointer;font-size:13px;font-weight:500;color:var(--gray-700);transition:background 0.1s;border:none;background:transparent;width:100%;text-align:left;font-family:'Inter',sans-serif}
.uopt:hover{background:var(--gray-50)}
.uopt.active{background:var(--blue-light);color:var(--blue)}
.uopt-sub{font-size:11px;color:var(--gray-400);font-weight:400;margin-top:1px}
.hero{background:linear-gradient(135deg,#0070f3 0%,#0051a8 100%);color:white;padding:28px 32px 24px}
.hero-inner{max-width:1100px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;gap:24px;flex-wrap:wrap}
.hero-left h2{font-size:22px;font-weight:700;letter-spacing:-0.4px;margin-bottom:6px}
.hero-left p{font-size:14px;opacity:0.85;max-width:520px;line-height:1.6}
.hero-pills{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}
.hero-pill{background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.25);border-radius:20px;padding:4px 12px;font-size:12px;font-weight:500}
.hero-right{text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:8px}
.hero-stats{display:flex;gap:20px;align-items:center}
.hero-stat-block{text-align:center}
.hero-stat{font-size:32px;font-weight:800;line-height:1}
.hero-stat-lbl{font-size:12px;opacity:0.75;margin-top:2px}
.hero-stat-divider{width:1px;height:48px;background:rgba(255,255,255,0.25)}
.last-updated{font-size:11px;opacity:0.6}
.layout{display:grid;grid-template-columns:272px 1fr;min-height:calc(100vh - 60px - 160px)}
.sidebar{background:var(--white);border-right:1px solid var(--gray-200);padding:20px 18px;position:sticky;top:60px;height:calc(100vh - 60px);overflow-y:auto}
.sb-section{margin-bottom:22px}
.sb-label{font-size:11px;font-weight:600;color:var(--gray-400);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px}
.stats-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-bottom:22px}
.scard{background:var(--gray-50);border:1px solid var(--gray-200);border-radius:var(--r);padding:10px 12px;text-align:center}
.scard.hi{background:var(--blue-light);border-color:var(--blue)}
.sval{font-size:20px;font-weight:700;line-height:1}
.scard.hi .sval{color:var(--blue)}
.slbl{font-size:11px;color:var(--gray-400);margin-top:2px}
.fi-group{display:flex;flex-direction:column;gap:3px}
.fi{display:flex;align-items:center;justify-content:space-between;padding:7px 10px;border-radius:var(--r-sm);cursor:pointer;border:none;background:transparent;text-align:left;font-family:'Inter',sans-serif;font-size:13px;color:var(--gray-700);width:100%;transition:background 0.1s}
.fi:hover{background:var(--gray-100)}
.fi.active{background:var(--blue-light);color:var(--blue);font-weight:500}
.fc{font-size:11px;background:var(--gray-200);color:var(--gray-500);padding:1px 7px;border-radius:20px;font-weight:500}
.fi.active .fc{background:var(--blue);color:white}
.hood-grid{display:flex;flex-wrap:wrap;gap:5px}
.hbtn{font-size:12px;padding:4px 10px;border-radius:20px;border:1px solid var(--gray-200);background:var(--white);cursor:pointer;color:var(--gray-500);font-family:'Inter',sans-serif;transition:all 0.12s}
.hbtn:hover{border-color:var(--blue);color:var(--blue)}
.hbtn.active{background:var(--blue);color:white;border-color:var(--blue)}
.price-wrap input[type=range]{width:100%;accent-color:var(--blue);margin-bottom:5px}
.price-labels{display:flex;justify-content:space-between;font-size:11px;color:var(--gray-400)}
.price-val{font-size:13px;font-weight:600;margin-bottom:5px}
.sort-sel{width:100%;padding:7px 10px;border:1px solid var(--gray-200);border-radius:var(--r-sm);background:var(--white);font-family:'Inter',sans-serif;font-size:13px;color:var(--gray-700);cursor:pointer}
.kb-hint{background:var(--gray-50);border:1px solid var(--gray-200);border-radius:var(--r);padding:10px 12px;font-size:11px;color:var(--gray-400);line-height:2}
.kb-key{display:inline-block;background:var(--white);border:1px solid var(--gray-300);border-radius:4px;padding:1px 5px;font-size:11px;font-weight:600;color:var(--gray-600);box-shadow:0 1px 0 var(--gray-300);margin-right:3px}
.main-content{padding:20px 24px}
.main-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.results-lbl{font-size:13px;color:var(--gray-400)}
.results-lbl strong{color:var(--gray-900)}
.refresh-btn{height:32px;padding:0 12px;border-radius:var(--r-sm);border:1px solid var(--gray-200);background:var(--white);cursor:pointer;font-size:12px;font-family:'Inter',sans-serif;color:var(--gray-500);display:flex;align-items:center;gap:5px;transition:all 0.12s}
.refresh-btn:hover{border-color:var(--blue);color:var(--blue)}
.skeleton-list{display:flex;flex-direction:column;gap:12px}
.skeleton-card{background:var(--white);border:1px solid var(--gray-200);border-radius:var(--r-lg);overflow:hidden;display:grid;grid-template-columns:200px 1fr;height:160px}
.skeleton-img{background:linear-gradient(90deg,var(--gray-100) 25%,var(--gray-200) 50%,var(--gray-100) 75%);background-size:200% 100%;animation:shimmer 1.5s infinite}
.skeleton-body{padding:16px;display:flex;flex-direction:column;gap:10px;justify-content:center}
.skeleton-line{height:12px;background:linear-gradient(90deg,var(--gray-100) 25%,var(--gray-200) 50%,var(--gray-100) 75%);background-size:200% 100%;animation:shimmer 1.5s infinite;border-radius:6px}
.skeleton-line.wide{width:75%}.skeleton-line.medium{width:50%}.skeleton-line.short{width:35%}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
.card{background:var(--white);border:1px solid var(--gray-200);border-radius:var(--r-lg);overflow:hidden;margin-bottom:10px;cursor:pointer;transition:box-shadow 0.2s,border-color 0.2s;display:grid;grid-template-columns:200px 1fr;height:160px;border-left-width:4px}
.card:hover{box-shadow:var(--sh-lg);border-color:var(--gray-300)}
.card.score-border-high{border-left-color:var(--green)}
.card.score-border-mid{border-left-color:var(--amber)}
.card.score-border-low{border-left-color:var(--red)}
.card.score-border-none{border-left-color:var(--gray-200)}
.card.is-new{box-shadow:0 0 0 2px rgba(0,112,243,0.15),var(--sh)}
.card.status-skipped{opacity:0.4}
.card.focused{box-shadow:0 0 0 3px rgba(0,112,243,0.3),var(--sh-lg)}
.card-img-wrap{position:relative;overflow:hidden;height:160px}
.card-img{width:100%;height:100%;object-fit:cover;display:block;transition:transform 0.3s}
.card:hover .card-img{transform:scale(1.04)}
.card-img-ph{width:100%;height:100%;background:linear-gradient(135deg,var(--gray-100),var(--gray-200));display:flex;align-items:center;justify-content:center;color:var(--gray-400);font-size:12px}
.new-badge{position:absolute;top:10px;left:10px;background:var(--blue);color:white;font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;animation:pulse 2s infinite}
.score-float{position:absolute;bottom:10px;left:10px;padding:4px 9px;border-radius:20px;font-size:12px;font-weight:700;backdrop-filter:blur(8px)}
.sf-high{background:rgba(0,166,81,0.92);color:white}
.sf-mid{background:rgba(245,158,11,0.92);color:white}
.sf-low{background:rgba(229,62,62,0.92);color:white}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.7}}
.card-body{padding:14px 16px;display:flex;flex-direction:column;justify-content:space-between;overflow:hidden}
.card-row1{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
.card-title{font-size:13px;font-weight:600;color:var(--gray-900);line-height:1.3;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card-price-wrap{text-align:right;flex-shrink:0}
.card-price{font-size:15px;font-weight:700}
.card-price-diff{font-size:11px;font-weight:500;margin-top:1px}
.price-below{color:var(--green)}.price-above{color:var(--red)}.price-avg{color:var(--gray-400)}
.card-meta{font-size:12px;color:var(--gray-400);display:flex;gap:8px;flex-wrap:wrap}
.card-score-reason{font-size:11px;color:var(--gray-400);font-style:italic;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.avail-bar{margin:2px 0}
.avail-label{font-size:10px;font-weight:600;color:var(--gray-400);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px;display:flex;justify-content:space-between}
.avail-track{height:5px;background:var(--gray-100);border-radius:3px;position:relative;overflow:hidden}
.avail-target{position:absolute;top:-1px;height:7px;border-radius:3px;background:rgba(0,112,243,0.18);border:1px solid var(--blue)}
.avail-fill{position:absolute;top:0;height:100%;border-radius:3px}
.af-green{background:var(--green)}.af-amber{background:var(--amber)}.af-gray{background:var(--gray-300)}
.card-bottom{display:flex;align-items:center;justify-content:space-between;gap:6px}
.card-tags{display:flex;gap:4px;flex-wrap:wrap}
.tag{font-size:11px;font-weight:500;padding:2px 7px;border-radius:20px}
.tag-gray{background:var(--gray-100);color:var(--gray-500)}
.tag-blue{background:var(--blue-light);color:var(--blue)}
.tag-green{background:var(--green-bg);color:var(--green)}
.tag-amber{background:var(--amber-bg);color:var(--amber)}
.tag-purple{background:var(--purple-bg);color:var(--purple)}
.tag-red{background:var(--red-bg);color:var(--red)}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:300;opacity:0;pointer-events:none;transition:opacity 0.25s;backdrop-filter:blur(2px)}
.overlay.open{opacity:1;pointer-events:all}
.panel{position:fixed;top:0;right:0;height:100vh;width:520px;max-width:100vw;background:var(--white);z-index:400;transform:translateX(100%);transition:transform 0.3s cubic-bezier(0.32,0.72,0,1);overflow-y:auto;box-shadow:var(--sh-lg)}
.panel.open{transform:translateX(0)}
.ph{padding:18px 22px 14px;border-bottom:1px solid var(--gray-200);position:sticky;top:0;background:var(--white);z-index:10;display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.pclose{width:30px;height:30px;border-radius:50%;border:1px solid var(--gray-200);background:var(--white);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:15px;color:var(--gray-400);flex-shrink:0;transition:all 0.12s}
.pclose:hover{background:var(--gray-100)}
.ptitle{font-size:14px;font-weight:600;line-height:1.3}
.pprice{font-size:20px;font-weight:700;margin-top:2px}
.pmeta{font-size:12px;color:var(--gray-400);margin-top:2px}
.pimg{width:100%;height:210px;object-fit:cover;display:block}
.pbody{padding:18px 22px}
.ps{margin-bottom:22px}
.ps-title{font-size:11px;font-weight:700;color:var(--gray-400);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:10px}
.dtabs{display:flex;border-bottom:1px solid var(--gray-200);margin-bottom:12px}
.dtab{font-size:13px;padding:8px 14px;border:none;background:transparent;cursor:pointer;color:var(--gray-400);font-family:'Inter',sans-serif;font-weight:500;border-bottom:2px solid transparent;margin-bottom:-1px;transition:all 0.12s}
.dtab.active{color:var(--blue);border-bottom-color:var(--blue)}
.dpane{display:none}.dpane.active{display:block}
.dsubj{font-size:12px;color:var(--gray-400);margin-bottom:6px;font-weight:500}
.dbox{position:relative}
.dta{width:100%;min-height:95px;font-size:13px;line-height:1.6;resize:vertical;background:var(--gray-50);border:1px solid var(--gray-200);border-radius:var(--r);padding:10px 44px 10px 12px;color:var(--gray-900);font-family:'Inter',sans-serif}
.dta:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 3px rgba(0,112,243,0.1)}
.cbtn{position:absolute;top:8px;right:8px;font-size:11px;padding:3px 9px;background:var(--white);border:1px solid var(--gray-200);border-radius:var(--r-sm);cursor:pointer;color:var(--gray-400);font-family:'Inter',sans-serif;transition:all 0.12s}
.cbtn:hover{border-color:var(--blue);color:var(--blue)}
.abtns{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:10px}
.abtn{height:33px;padding:0 13px;border-radius:var(--r-sm);border:1.5px solid var(--gray-200);cursor:pointer;font-size:12px;font-weight:500;font-family:'Inter',sans-serif;transition:all 0.15s;display:flex;align-items:center;gap:4px}
.abtn:hover{filter:brightness(0.95);transform:translateY(-1px)}
.abtn:disabled{opacity:0.5;cursor:not-allowed;transform:none}
.btn-sms{background:#e8f2ff;color:var(--blue);border-color:#93c5fd}
.btn-sms-sent{background:var(--green-bg);color:var(--green);border-color:#86efac}
.btn-r{background:var(--purple-bg);color:var(--purple);border-color:#c4b5fd}
.btn-v{background:var(--blue-light);color:var(--blue);border-color:#93c5fd}
.btn-p{background:var(--red-bg);color:var(--red);border-color:#fca5a5}
.alog{display:flex;flex-direction:column;gap:5px}
.alog-i{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--gray-500);padding:5px 9px;background:var(--gray-50);border-radius:var(--r-sm)}
.clist{display:flex;flex-direction:column;gap:9px;margin-bottom:10px}
.comment{display:flex;gap:9px}
.cav{width:28px;height:28px;border-radius:50%;background:var(--blue);color:white;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.cav.j{background:var(--purple)}.cav.n{background:#db2777}.cav.m{background:#059669}
.cbub{flex:1;background:var(--gray-50);border:1px solid var(--gray-200);border-radius:4px 10px 10px 10px;padding:7px 11px}
.cmeta{font-size:11px;color:var(--gray-400);margin-bottom:2px;font-weight:500}
.cbody{font-size:13px;color:var(--gray-800);line-height:1.5}
.cinput-wrap{display:flex;gap:7px}
.cinput{flex:1;padding:8px 11px;border:1px solid var(--gray-200);border-radius:var(--r);font-family:'Inter',sans-serif;font-size:13px;background:var(--white);transition:border-color 0.12s}
.cinput:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 3px rgba(0,112,243,0.1)}
.csend{height:36px;padding:0 14px;border-radius:var(--r);border:none;background:var(--blue);color:white;font-size:13px;font-weight:600;font-family:'Inter',sans-serif;cursor:pointer}
.csend:hover{background:var(--blue-dark)}
.map-btn{display:inline-flex;align-items:center;gap:5px;font-size:13px;color:var(--blue);text-decoration:none;font-weight:500}
.map-btn:hover{text-decoration:underline}
.amen-list{display:flex;flex-wrap:wrap;gap:4px}
.amen{font-size:11px;padding:2px 8px;border-radius:var(--r-sm);background:var(--gray-100);color:var(--gray-600);border:1px solid var(--gray-200)}
.mobile-filter-btn{display:none;position:fixed;bottom:24px;right:24px;z-index:250;background:var(--blue);color:white;border:none;border-radius:20px;padding:10px 18px;font-size:13px;font-weight:600;font-family:'Inter',sans-serif;cursor:pointer;box-shadow:var(--sh-lg);align-items:center;gap:6px}
.drawer-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:260;display:none;backdrop-filter:blur(2px)}
.drawer{position:fixed;bottom:0;left:0;right:0;background:var(--white);z-index:270;border-radius:20px 20px 0 0;padding:20px 20px 40px;max-height:80vh;overflow-y:auto;transform:translateY(100%);transition:transform 0.3s cubic-bezier(0.32,0.72,0,1)}
.drawer.open{transform:translateY(0)}
.drawer-handle{width:40px;height:4px;background:var(--gray-300);border-radius:2px;margin:0 auto 20px}
.drawer-title{font-size:15px;font-weight:600;margin-bottom:16px}
.drawer-section{margin-bottom:20px}
@media(max-width:768px){
  .layout{grid-template-columns:1fr}
  .sidebar{display:none}
  .card{grid-template-columns:120px 1fr;height:140px}
  .card-img-wrap{height:140px}
  .panel{width:100vw}
  nav{padding:0 16px}
  nav .nav-sub{display:none}
  .main-content{padding:14px 16px}
  .hero{padding:20px 16px}
  .mobile-filter-btn{display:flex}
}
</style>
</head>
<body>
<nav>
  <div class="nav-brand">
    <div class="nav-logo">${LOGO_SVG}</div>
    <div style="margin-left:2px">
      <div class="nav-title">Summer Sublet Agent</div>
      <div class="nav-sub">Target: Manhattan, June–Aug 2026</div>
    </div>
  </div>
  <div class="user-wrap" id="uwrap">
    <button class="user-btn" id="ubtn" onclick="toggleDD()">
      <div class="uav" id="nav-av" style="display:none"></div>
      <span id="nav-lbl">Select user</span>
      <span class="chevron">▾</span>
    </button>
    <div class="user-menu" id="umenu">
      <button class="uopt" onclick="setUser('Alex','A','')"><div class="uav">A</div><div><div>Alex</div><div class="uopt-sub">HBS · Germany</div></div></button>
      <button class="uopt" onclick="setUser('Julian','J','j')"><div class="uav j">J</div><div><div>Julian</div><div class="uopt-sub">HBS · Germany</div></div></button>
      <button class="uopt" onclick="setUser('Nora','N','n')"><div class="uav n">N</div><div><div>Nora</div><div class="uopt-sub">HBS · Austria</div></div></button>
      <div class="udiv"></div>
      <button class="uopt" onclick="setUser('Marco','M','m')"><div class="uav m">M</div><div><div>Marco</div><div class="uopt-sub">For review only</div></div></button>
    </div>
  </div>
</nav>

<div class="hero">
  <div class="hero-inner">
    <div class="hero-left">
      <h2>Manhattan Sublet Search · Summer 2026</h2>
      <p>AI-powered apartment finder that automatically scans Craigslist, scores listings by fit, drafts and sends personalized outreach via SMS, and delivers a daily email summary.</p>
      <div class="hero-pills">
        <span class="hero-pill">🤖 Auto-scraped every 30 min</span>
        <span class="hero-pill">✍️ AI-drafted messages</span>
        <span class="hero-pill">📱 Auto SMS outreach</span>
        <span class="hero-pill">👥 Shared team workspace</span>
        <span class="hero-pill">📧 Daily email summary</span>
      </div>
    </div>
    <div class="hero-right">
      <div class="hero-stats">
        <div class="hero-stat-block">
          <div class="hero-stat">${listings.length}</div>
          <div class="hero-stat-lbl">total listings</div>
        </div>
        <div class="hero-stat-divider"></div>
        <div class="hero-stat-block">
          <div class="hero-stat">${todayCount}</div>
          <div class="hero-stat-lbl">found today</div>
        </div>
      </div>
      <div class="last-updated">Last updated: ${lastUpdated}</div>
    </div>
  </div>
</div>

<div class="layout">
  <aside class="sidebar">
    <div class="stats-grid">
      <div class="scard hi"><div class="sval" id="s-new">${newIds.length}</div><div class="slbl">New</div></div>
      <div class="scard"><div class="sval" id="s-total">${listings.length}</div><div class="slbl">Total</div></div>
      <div class="scard"><div class="sval" id="s-pending">–</div><div class="slbl">Needs Review</div></div>
      <div class="scard"><div class="sval" id="s-contacted">–</div><div class="slbl">Contacted</div></div>
    </div>
    <div class="sb-section">
      <div class="sb-label">Status</div>
      <div class="fi-group">
        <button class="fi active" onclick="setFilter('all',this)">All listings <span class="fc">${listings.length}</span></button>
        <button class="fi" onclick="setFilter('new',this)">✨ New <span class="fc">${newIds.length}</span></button>
        <button class="fi" onclick="setFilter('pending',this)">Needs Review</button>
        <button class="fi" onclick="setFilter('contacted',this)">Contacted</button>
        <button class="fi" onclick="setFilter('reply',this)">💬 Got reply</button>
        <button class="fi" onclick="setFilter('viewing',this)">📅 Viewing</button>
        <button class="fi" onclick="setFilter('skipped',this)">Passed</button>
      </div>
    </div>
    <div class="sb-section">
      <div class="sb-label">Neighborhood</div>
      <div class="hood-grid">
        <button class="hbtn active" onclick="toggleHood('all',this)">All</button>
        <button class="hbtn" onclick="toggleHood('upper east',this)">UES</button>
        <button class="hbtn" onclick="toggleHood('upper west',this)">UWS</button>
        <button class="hbtn" onclick="toggleHood('midtown',this)">Midtown</button>
        <button class="hbtn" onclick="toggleHood('village',this)">Village</button>
        <button class="hbtn" onclick="toggleHood('soho',this)">SoHo</button>
        <button class="hbtn" onclick="toggleHood('tribeca',this)">Tribeca</button>
        <button class="hbtn" onclick="toggleHood('financial',this)">FiDi</button>
        <button class="hbtn" onclick="toggleHood('harlem',this)">Harlem</button>
      </div>
    </div>
    <div class="sb-section">
      <div class="sb-label">Max price</div>
      <div class="price-wrap">
        <div class="price-val" id="price-lbl">$${maxPrice.toLocaleString()}/mo</div>
        <input type="range" id="price-slider" min="1000" max="${maxPrice}" value="${maxPrice}" step="100" oninput="updatePrice(this.value)">
        <div class="price-labels"><span>$1k</span><span>$${Math.round(maxPrice / 1000)}k</span></div>
      </div>
    </div>
    <div class="sb-section">
      <div class="sb-label">Sort by</div>
      <select class="sort-sel" id="sort-sel" onchange="sortCards()">
        <option value="newest">Newest first</option>
        <option value="score">Best match score</option>
        <option value="price-low">Price: low to high</option>
        <option value="price-high">Price: high to low</option>
      </select>
    </div>
    <div class="sb-section">
      <div class="sb-label">Keyboard shortcuts</div>
      <div class="kb-hint">
        <span class="kb-key">↑↓</span> Navigate · <span class="kb-key">Enter</span> Open<br>
        <span class="kb-key">Esc</span> Close · <span class="kb-key">C</span> Send SMS · <span class="kb-key">P</span> Pass
      </div>
    </div>
  </aside>

  <main class="main-content">
    <div class="main-hdr">
      <div class="results-lbl"><strong id="results-count">${listings.length} listings</strong>${avgPrice ? ` · avg $${avgPrice.toLocaleString()}/mo` : ""} · updated ${lastUpdated}</div>
      <button class="refresh-btn" onclick="location.reload()">↻ Refresh</button>
    </div>
    <div id="cards-container">
    ${listings.length === 0 ? `<div class="skeleton-list">${[1,2,3].map(()=>`<div class="skeleton-card"><div class="skeleton-img"></div><div class="skeleton-body"><div class="skeleton-line wide"></div><div class="skeleton-line medium"></div><div class="skeleton-line short"></div><div class="skeleton-line medium"></div></div></div>`).join("")}</div>` :
    listings.map((l) => {
      const la = actionMap[l.id] || [];
      const isNew = newIds.includes(l.id);
      const ca = la.find(a => a.action === "contacted");
      const ra = la.find(a => a.action === "reply");
      const va = la.find(a => a.action === "viewing");
      const pa = la.find(a => a.action === "pass" || a.action === "skipped");
      const status = ra ? "reply" : va ? "viewing" : ca ? "contacted" : pa ? "skipped" : "pending";
      const pm = (l.price || "").replace(/,/g, "").match(/\d+/);
      const price = pm ? parseInt(pm[0]) : 0;
      const loc = (l.location || "").toLowerCase();
      const score = l.score || 0;
      const sc = score >= 7 ? "high" : score >= 5 ? "mid" : score > 0 ? "low" : "none";
      const statusTag = ra ? `<span class="tag tag-purple">💬 Reply</span>` : va ? `<span class="tag tag-blue">📅 Viewing</span>` : ca ? `<span class="tag tag-green">✓ Contacted</span>` : pa ? `<span class="tag tag-gray">Passed</span>` : "";
      let priceDiff = "";
      if (price > 0 && avgPrice > 0) {
        const diff = Math.round((price - avgPrice) / avgPrice * 100);
        if (diff < -5) priceDiff = `<div class="card-price-diff price-below">↓ ${Math.abs(diff)}% below avg</div>`;
        else if (diff > 5) priceDiff = `<div class="card-price-diff price-above">↑ ${Math.abs(diff)}% above avg</div>`;
        else priceDiff = `<div class="card-price-diff price-avg">≈ avg price</div>`;
      }
      const monthMap = { may: 0, june: 25, july: 50, august: 75 };
      const avStr = (l.availableFrom || "").toLowerCase();
      let avPos = -1;
      for (const [mon, pos] of Object.entries(monthMap)) { if (avStr.includes(mon)) { avPos = pos; break; } }
      const avFillClass = avPos === 0 || avPos === 25 ? "af-green" : avPos === 50 ? "af-amber" : "af-gray";
      const availBarHtml = `<div class="avail-bar"><div class="avail-label"><span>May</span><span>Jun</span><span>Jul</span><span>Aug</span></div><div class="avail-track"><div class="avail-target" style="left:25%;width:50%"></div>${avPos >= 0 ? `<div class="avail-fill ${avFillClass}" style="left:${avPos}%;width:25%"></div>` : ""}</div></div>`;

      return `
<div class="card score-border-${sc} ${isNew ? "is-new" : ""} status-${status}"
  data-id="${l.id}" data-status="${status}" data-isnew="${isNew}"
  data-price="${price}" data-score="${score}" data-loc="${loc}" data-datetime="${l.datetime || ""}"
  onclick="openPanel('${l.id}')">
  <div class="card-img-wrap">
    ${l.pics?.[0] ? `<img class="card-img" src="${l.pics[0]}" loading="lazy" alt="" onerror="this.parentNode.innerHTML='<div class=card-img-ph>No photo</div>'">` : `<div class="card-img-ph">No photo</div>`}
    ${isNew ? `<div class="new-badge">New</div>` : ""}
    ${score ? `<div class="score-float sf-${sc}">${score}/10</div>` : ""}
  </div>
  <div class="card-body">
    <div>
      <div class="card-row1">
        <div class="card-title">${(l.title || "Manhattan Sublet").slice(0, 60)}</div>
        <div class="card-price-wrap">
          ${l.price ? `<div class="card-price">${l.price}</div>` : ""}
          ${priceDiff}
        </div>
      </div>
      <div class="card-meta">
        <span>📍 ${l.location || "Manhattan"}</span>
        ${l.bedrooms ? `<span>🛏 ${l.bedrooms}BR</span>` : ""}
        ${l.availableFrom ? `<span>📅 ${l.availableFrom}</span>` : ""}
      </div>
      ${l.scoreReason ? `<div class="card-score-reason">${l.scoreReason}</div>` : ""}
      ${availBarHtml}
    </div>
    <div class="card-bottom">
      <div class="card-tags"><span class="tag tag-gray">${l.platform || "Craigslist"}</span>${l.smsSent ? `<span class="tag tag-green">SMS ✓</span>` : ""}${l.amenities?.includes("furnished") ? `<span class="tag tag-blue">Furnished</span>` : ""}</div>
      <div>${statusTag}</div>
    </div>
  </div>
</div>`;
    }).join("")}
    </div>
  </main>
</div>

<button class="mobile-filter-btn" onclick="openDrawer()">⚙ Filters</button>
<div class="drawer-overlay" id="drawer-overlay" onclick="closeDrawer()"></div>
<div class="drawer" id="drawer">
  <div class="drawer-handle"></div>
  <div class="drawer-title">Filters</div>
  <div class="drawer-section">
    <div class="sb-label">Status</div>
    <div class="fi-group">
      <button class="fi active" onclick="setFilter('all',this);closeDrawer()">All <span class="fc">${listings.length}</span></button>
      <button class="fi" onclick="setFilter('new',this);closeDrawer()">✨ New</button>
      <button class="fi" onclick="setFilter('pending',this);closeDrawer()">Needs Review</button>
      <button class="fi" onclick="setFilter('contacted',this);closeDrawer()">Contacted</button>
      <button class="fi" onclick="setFilter('skipped',this);closeDrawer()">Passed</button>
    </div>
  </div>
  <div class="drawer-section">
    <div class="sb-label">Max price</div>
    <div class="price-val" id="price-lbl-m">$${maxPrice.toLocaleString()}/mo</div>
    <input type="range" min="1000" max="${maxPrice}" value="${maxPrice}" step="100" style="width:100%;accent-color:var(--blue)" oninput="updatePrice(this.value,true)">
  </div>
</div>

<div class="overlay" id="overlay" onclick="closePanel()"></div>
<div class="panel" id="panel"><div id="panel-content"></div></div>

<script>
const listings = ${JSON.stringify(listings)};
const actionMap = ${JSON.stringify(actionMap)};
const commentMap = ${JSON.stringify(commentMap)};
const newIds = ${JSON.stringify(newIds)};
const avgPrice = ${avgPrice};

let currentUser = localStorage.getItem("sublet_user");
if (currentUser) restoreUser();
function restoreUser() {
  const cm={Alex:"",Julian:"j",Nora:"n",Marco:"m"};const cl=cm[currentUser]||"";
  document.getElementById("nav-lbl").textContent=currentUser;
  const av=document.getElementById("nav-av");
  av.textContent=currentUser[0];av.className="uav"+(cl?" "+cl:"");av.style.display="flex";
  document.getElementById("ubtn").classList.add("has-user");
}
function toggleDD(){document.getElementById("umenu").classList.toggle("open");document.getElementById("ubtn").classList.toggle("open");}
function setUser(name,init,cl){
  currentUser=name;localStorage.setItem("sublet_user",name);
  document.getElementById("nav-lbl").textContent=name;
  const av=document.getElementById("nav-av");
  av.textContent=init;av.className="uav"+(cl?" "+cl:"");av.style.display="flex";
  document.getElementById("ubtn").classList.add("has-user");
  document.querySelectorAll(".uopt").forEach(o=>o.classList.remove("active"));
  event.currentTarget.classList.add("active");
  document.getElementById("umenu").classList.remove("open");
  document.getElementById("ubtn").classList.remove("open");
}
document.addEventListener("click",e=>{if(!document.getElementById("uwrap").contains(e.target)){document.getElementById("umenu").classList.remove("open");document.getElementById("ubtn").classList.remove("open");}});

if(newIds.length>0)setTimeout(()=>{fetch("/seen",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({listingIds:newIds,userName:localStorage.getItem("sublet_user")||"unknown"})});},3000);

function animCount(el,target){const dur=700,start=performance.now();function step(now){const p=Math.min((now-start)/dur,1);const e=1-Math.pow(1-p,3);el.textContent=Math.round(target*e);if(p<1)requestAnimationFrame(step);}requestAnimationFrame(step);}
window.addEventListener("load",()=>{
  const cards=document.querySelectorAll(".card");let pending=0,contacted=0;
  cards.forEach(c=>{if(c.dataset.status==="pending")pending++;if(["contacted","reply","viewing"].includes(c.dataset.status))contacted++;});
  animCount(document.getElementById("s-new"),${newIds.length});
  animCount(document.getElementById("s-total"),${listings.length});
  animCount(document.getElementById("s-pending"),pending);
  animCount(document.getElementById("s-contacted"),contacted);
});

function openDrawer(){document.getElementById("drawer").classList.add("open");document.getElementById("drawer-overlay").style.display="block";}
function closeDrawer(){document.getElementById("drawer").classList.remove("open");document.getElementById("drawer-overlay").style.display="none";}

let panelOpen=false;
function openPanel(id){
  const l=listings.find(x=>x.id===id);if(!l)return;
  const la=actionMap[id]||[],lc=commentMap[id]||[];
  const ca=la.find(a=>a.action==="contacted"),ra=la.find(a=>a.action==="reply");
  const va=la.find(a=>a.action==="viewing"),pa=la.find(a=>a.action==="pass"||a.action==="skipped");
  const hasPhone=l.phoneNumbers&&l.phoneNumbers.length>0;
  const sc=(l.score||0)>=7?"high":(l.score||0)>=5?"mid":"low";
  const ta=t=>{const s=Math.floor((Date.now()-new Date(t))/1000);if(s<60)return"just now";if(s<3600)return Math.floor(s/60)+"m ago";if(s<86400)return Math.floor(s/3600)+"h ago";return Math.floor(s/86400)+"d ago";};
  const avCls=n=>n==="Julian"?"j":n==="Nora"?"n":n==="Marco"?"m":"";
  const pm=(l.price||"").replace(/,/g,"").match(/\\d+/);const price=pm?parseInt(pm[0]):0;
  let pdiff="";if(price>0&&avgPrice>0){const d=Math.round((price-avgPrice)/avgPrice*100);if(d<-5)pdiff=\`<span style="color:var(--green);font-size:12px;font-weight:500">↓ \${Math.abs(d)}% below avg</span>\`;else if(d>5)pdiff=\`<span style="color:var(--red);font-size:12px;font-weight:500">↑ \${Math.abs(d)}% above avg</span>\`;}

  let actionBtns="";
  if(!ca){
    if(hasPhone&&l.drafts?.sms){actionBtns+=\`<button class="abtn btn-sms" id="sms-btn-\${l.id}" onclick="doSendSms('\${l.id}')">📱 Send SMS</button>\`;}
    else{actionBtns+=\`<button class="abtn btn-sms" \${!hasPhone?"disabled":""} title="\${!hasPhone?"No phone number available":""}">✓ \${hasPhone?"Contacted":"No phone #"}</button>\`;}
  }
  if(ca&&!ra)actionBtns+=\`<button class="abtn btn-r" onclick="doAction('\${l.id}','reply')">💬 Got reply</button>\`;
  if((ca||ra)&&!va)actionBtns+=\`<button class="abtn btn-v" onclick="doAction('\${l.id}','viewing')">📅 Viewing</button>\`;
  if(!pa)actionBtns+=\`<button class="abtn btn-p" onclick="doAction('\${l.id}','pass')">✕ Pass</button>\`;

  document.getElementById("panel").dataset.listingId=id;
  document.getElementById("panel-content").innerHTML=\`
    <div class="ph"><div style="flex:1;min-width:0">
      <div class="ptitle">\${(l.title||"Manhattan Sublet").replace(/</g,"&lt;")}</div>
      \${l.price?\`<div class="pprice">\${l.price}<span style="font-size:12px;font-weight:400;color:var(--gray-400)">/mo</span> \${pdiff}</div>\`:""}
      <div class="pmeta">📍 \${l.location||"Manhattan"}\${l.bedrooms?" · 🛏 "+l.bedrooms+"BR":""}\${l.availableFrom?" · 📅 "+l.availableFrom:""}</div>
    </div><button class="pclose" onclick="closePanel()">✕</button></div>
    \${l.pics?.[0]?\`<img class="pimg" src="\${l.pics[0]}" alt="">\`:""}
    <div class="pbody">
      \${l.score?\`<div class="ps"><div class="ps-title">Match Score</div><div style="display:flex;align-items:center;gap:12px;padding:11px;background:var(--gray-50);border-radius:var(--r);border:1px solid var(--gray-200)"><span class="score-float sf-\${sc}" style="position:static;font-size:15px;padding:5px 13px">\${l.score}/10</span><span style="font-size:13px;color:var(--gray-500);font-style:italic">\${l.scoreReason||""}</span></div></div>\`:""}
      \${l.post?\`<div class="ps"><div class="ps-title">Description</div><p style="font-size:13px;color:var(--gray-600);line-height:1.7">\${l.post.slice(0,600).replace(/</g,"&lt;")}</p></div>\`:""}
      \${l.amenities?.length?\`<div class="ps"><div class="ps-title">Amenities</div><div class="amen-list">\${l.amenities.map(a=>\`<span class="amen">\${a}</span>\`).join("")}</div></div>\`:""}
      <div class="ps"><a class="map-btn" href="https://maps.google.com?q=\${encodeURIComponent((l.location||"Manhattan")+" New York NY")}" target="_blank">🗺 View on Google Maps →</a></div>
      \${l.drafts?\`<div class="ps"><div class="ps-title">Message Drafts</div><div class="dtabs"><button class="dtab active" onclick="showDraft('inApp',this)">In-app</button><button class="dtab" onclick="showDraft('email',this)">Email</button><button class="dtab" onclick="showDraft('sms',this)">SMS</button><button class="dtab" onclick="showDraft('whatsapp',this)">WhatsApp</button></div><div id="dp-inApp" class="dpane active"><div class="dbox"><textarea class="dta">\${(l.drafts.inApp||"").replace(/</g,"&lt;")}</textarea><button class="cbtn" onclick="copyDraft(this)">Copy</button></div></div><div id="dp-email" class="dpane"><div class="dsubj"><strong>Subject:</strong> \${(l.drafts.email?.subject||"").replace(/</g,"&lt;")}</div><div class="dbox"><textarea class="dta">\${(l.drafts.email?.body||"").replace(/</g,"&lt;")}</textarea><button class="cbtn" onclick="copyDraft(this)">Copy</button></div></div><div id="dp-sms" class="dpane"><div class="dbox"><textarea class="dta">\${(l.drafts.sms||"").replace(/</g,"&lt;")}</textarea><button class="cbtn" onclick="copyDraft(this)">Copy</button></div></div><div id="dp-whatsapp" class="dpane"><div class="dbox"><textarea class="dta">\${(l.drafts.whatsapp||"").replace(/</g,"&lt;")}</textarea><button class="cbtn" onclick="copyDraft(this)">Copy</button></div></div></div>\`:""}
      <div class="ps"><div class="ps-title">Outreach Status</div>
        <div class="abtns">\${actionBtns}</div>
        \${la.length?\`<div class="alog">\${la.map(a=>\`<div class="alog-i">\${a.action==="contacted"?"📱":a.action==="reply"?"💬":a.action==="viewing"?"📅":"✕"} <strong>\${a.user_name}</strong> \${a.action==="contacted"?"sent SMS":a.action==="reply"?"got a reply":a.action==="viewing"?"viewing scheduled":"passed"} · \${ta(a.created_at)}</div>\`).join("")}</div>\`:""}
      </div>
      <div class="ps"><div class="ps-title">Notes</div>
        <div class="clist">\${lc.map(c=>\`<div class="comment"><div class="cav \${avCls(c.user_name)}">\${c.user_name[0]}</div><div class="cbub"><div class="cmeta">\${c.user_name} · \${ta(c.created_at)}</div><div class="cbody">\${c.body.replace(/</g,"&lt;")}</div></div></div>\`).join("")}</div>
        <div class="cinput-wrap"><input class="cinput" id="ci-\${l.id}" placeholder="Add a note..." onkeydown="if(event.key==='Enter')sendComment('\${l.id}')"><button class="csend" onclick="sendComment('\${l.id}')">Send</button></div>
      </div>
      <div style="padding-top:8px"><a href="\${l.url}" target="_blank" style="font-size:13px;color:var(--blue);font-weight:500;text-decoration:none">View original listing →</a></div>
    </div>
  \`;
  document.getElementById("overlay").classList.add("open");
  document.getElementById("panel").classList.add("open");
  document.body.style.overflow="hidden";panelOpen=true;
}
function closePanel(){document.getElementById("overlay").classList.remove("open");document.getElementById("panel").classList.remove("open");document.body.style.overflow="";panelOpen=false;}
function showDraft(tab,btn){document.querySelectorAll(".dpane").forEach(p=>p.classList.remove("active"));document.getElementById("dp-"+tab).classList.add("active");document.querySelectorAll(".dtab").forEach(t=>t.classList.remove("active"));btn.classList.add("active");}
function copyDraft(btn){navigator.clipboard.writeText(btn.previousElementSibling.value).then(()=>{btn.textContent="Copied!";setTimeout(()=>btn.textContent="Copy",1500);});}
async function doSendSms(lid){
  if(!currentUser){alert("Select your name from the dropdown first.");return;}
  const btn=document.getElementById("sms-btn-"+lid);
  if(btn){btn.disabled=true;btn.textContent="Sending...";}
  try{
    const res=await fetch("/send-sms",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({listingId:lid,userName:currentUser})});
    const data=await res.json();
    if(data.success){if(btn){btn.textContent="✓ SMS Sent!";btn.className="abtn btn-sms-sent";}setTimeout(()=>location.reload(),1200);}
    else{if(btn){btn.disabled=false;btn.textContent="📱 Send SMS";}alert("SMS failed: "+(data.error||"Unknown error"));}
  }catch(e){if(btn){btn.disabled=false;btn.textContent="📱 Send SMS";}alert("SMS failed: "+e.message);}
}
async function doAction(lid,action){if(!currentUser){alert("Select your name from the dropdown first.");return;}await fetch("/action",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({listingId:lid,userName:currentUser,action})});location.reload();}
async function sendComment(lid){if(!currentUser){alert("Select your name from the dropdown first.");return;}const input=document.getElementById("ci-"+lid);const body=input.value.trim();if(!body)return;input.value="";await fetch("/comment",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({listingId:lid,userName:currentUser,body})});location.reload();}

let activeFilter="all",activeHood="all",maxPF=${maxPrice};
function setFilter(f,btn){activeFilter=f;document.querySelectorAll(".fi").forEach(b=>b.classList.remove("active"));btn.classList.add("active");applyFilters();}
function toggleHood(hood,btn){activeHood=hood;document.querySelectorAll(".hbtn").forEach(b=>b.classList.remove("active"));btn.classList.add("active");applyFilters();}
function updatePrice(val,mobile){maxPF=parseInt(val);const lbl="$"+parseInt(val).toLocaleString()+"/mo";document.getElementById("price-lbl").textContent=lbl;if(document.getElementById("price-lbl-m"))document.getElementById("price-lbl-m").textContent=lbl;applyFilters();}
function applyFilters(){
  let v=0;
  document.querySelectorAll(".card").forEach(card=>{
    const s=card.dataset.status,n=card.dataset.isnew==="true";
    const p=parseInt(card.dataset.price)||0,l=card.dataset.loc||"";
    const ok=(activeFilter==="all"||(activeFilter==="new"&&n)||s===activeFilter)&&(activeHood==="all"||l.includes(activeHood))&&(p===0||p<=maxPF);
    card.style.display=ok?"grid":"none";if(ok)v++;
  });
  document.getElementById("results-count").textContent=v+" listing"+(v!==1?"s":"");
}
function sortCards(){
  const sort=document.getElementById("sort-sel").value;
  const c=document.getElementById("cards-container");
  const cards=Array.from(c.querySelectorAll(".card"));
  cards.sort((a,b)=>{
    if(sort==="score")return(parseInt(b.dataset.score)||0)-(parseInt(a.dataset.score)||0);
    if(sort==="price-low")return(parseInt(a.dataset.price)||0)-(parseInt(b.dataset.price)||0);
    if(sort==="price-high")return(parseInt(b.dataset.price)||0)-(parseInt(a.dataset.price)||0);
    return new Date(b.dataset.datetime)-new Date(a.dataset.datetime);
  });
  cards.forEach(c=>document.getElementById("cards-container").appendChild(c));
}
let focusedIdx=-1;
const visCards=()=>Array.from(document.querySelectorAll(".card")).filter(c=>c.style.display!=="none");
document.addEventListener("keydown",e=>{
  if(e.target.tagName==="INPUT"||e.target.tagName==="TEXTAREA")return;
  const cards=visCards();
  if(e.key==="ArrowDown"){e.preventDefault();focusedIdx=Math.min(focusedIdx+1,cards.length-1);cards.forEach((c,i)=>c.classList.toggle("focused",i===focusedIdx));cards[focusedIdx]?.scrollIntoView({behavior:"smooth",block:"nearest"});}
  else if(e.key==="ArrowUp"){e.preventDefault();focusedIdx=Math.max(focusedIdx-1,0);cards.forEach((c,i)=>c.classList.toggle("focused",i===focusedIdx));cards[focusedIdx]?.scrollIntoView({behavior:"smooth",block:"nearest"});}
  else if(e.key==="Enter"&&focusedIdx>=0&&!panelOpen){const id=cards[focusedIdx]?.dataset.id;if(id)openPanel(id);}
  else if(e.key==="Escape")closePanel();
  else if((e.key==="c"||e.key==="C")&&focusedIdx>=0){const id=cards[focusedIdx]?.dataset.id;if(id)doSendSms(id);}
  else if((e.key==="p"||e.key==="P")&&focusedIdx>=0){const id=cards[focusedIdx]?.dataset.id;if(id)doAction(id,"pass");}
});
</script>
</body>
</html>`);
});

app.listen(PORT, async () => {
  console.log(`Sublet agent running on port ${PORT} [DRY_RUN=${DRY_RUN}]`);
  await initDb();
  fetchAndProcess().catch(console.error);
  setInterval(() => fetchAndProcess().catch(console.error), 30 * 60 * 1000);
  scheduleDailySummary();
});
