const express = require("express");
const app = express();
app.use(express.json());

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const TWILIO_SID = process.env.TWILIO_SID;
const TWILIO_TOKEN = process.env.TWILIO_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM;
const ALERT_PHONE = process.env.ALERT_PHONE;
const DATABASE_URL = process.env.DATABASE_URL;
const DRY_RUN = process.env.DRY_RUN !== "false";
const PORT = process.env.PORT || 3000;

let isFetching = false;
let db = null;

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

async function initDb() {
  const { default: pg } = await import("pg");
  const { Pool } = pg;
  db = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.query(`
    CREATE TABLE IF NOT EXISTS listings (id TEXT PRIMARY KEY, data JSONB NOT NULL, created_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS actions (id SERIAL PRIMARY KEY, listing_id TEXT NOT NULL, user_name TEXT NOT NULL, action TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS comments (id SERIAL PRIMARY KEY, listing_id TEXT NOT NULL, user_name TEXT NOT NULL, body TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS seen (id SERIAL PRIMARY KEY, listing_id TEXT NOT NULL UNIQUE, seen_by TEXT NOT NULL, seen_at TIMESTAMP DEFAULT NOW());
  `);
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
  const res = await fetch("https://newyork.craigslist.org/search/mnh/sub?min_bedrooms=2&max_bedrooms=3", { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", "Accept": "text/html" } });
  const html = await res.text();
  const pat = /href="(https:\/\/newyork\.craigslist\.org\/mnh\/sub\/d\/[^"]+)"/g;
  let m; const links = [];
  while ((m = pat.exec(html)) !== null) { if (!links.includes(m[1])) links.push(m[1]); }
  return links.slice(0, 50).map((link, i) => {
    const id = (link.match(/(\d+)\.html/) || [])[1] || Math.random().toString(36).slice(2);
    const title = link.split("/").pop().replace(".html", "").replace(/-/g, " ");
    const sur = html.slice(Math.max(0, html.indexOf(link) - 200), html.indexOf(link) + 200);
    const pm = sur.match(/\$[\d,]+/);
    return { id, title, url: link, post: "", price: pm ? pm[0] : "", bedrooms: 2, location: "Manhattan, NY", availableFrom: "", datetime: new Date().toISOString(), phoneNumbers: [], platform: "Craigslist", address: { city: "New York" }, pics: [APARTMENT_PHOTOS[i % APARTMENT_PHOTOS.length]] };
  });
}

async function generateDraftAndScore(l) {
  const system = `You help three HBS students (Alex, Julian, Nora from Germany/Austria) find a 2-3BR Manhattan sublet for June–August 2026. Return ONLY valid JSON: {"inApp":"...","email":{"subject":"...","body":"..."},"sms":"...","whatsapp":"...","score":7,"scoreReason":"one sentence"}. Score 1-10 strictly.`;
  const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, system, messages: [{ role: "user", content: `Title: ${l.title}\nPrice: ${l.price}\nLocation: ${l.location}\nBedrooms: ${l.bedrooms}\nAvailable: ${l.availableFrom}` }] }) });
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

async function fetchAndProcess() {
  if (isFetching) return 0;
  isFetching = true;
  try {
    const items = await fetchListings();
    const eligible = items.filter(passes);
    const existing = await loadListings();
    const seen = new Set(existing.map(l => l.id));
    const newListings = eligible.filter(l => !seen.has(l.id));
    console.log(`${newListings.length} new listings`);
    for (const l of newListings) {
      try { const r = await generateDraftAndScore(l); l.drafts = { inApp: r.inApp, email: r.email, sms: r.sms, whatsapp: r.whatsapp }; l.score = r.score; l.scoreReason = r.scoreReason; } catch (e) { console.error("Draft failed:", e.message); }
      if (l.phoneNumbers?.length > 0 && l.drafts) { const r = await sendSms(l.phoneNumbers[0], l.drafts.sms); l.smsSent = !r?.dryRun; l.smsDryRun = r?.dryRun || false; } else { l.needsManualSend = true; }
      await saveListing(l);
    }
    if (newListings.length > 0) await sendAlertToMe(newListings.length);
    return newListings.length;
  } finally { isFetching = false; }
}

app.post("/action", async (req, res) => { const { listingId, userName, action } = req.body; if (!listingId || !userName || !action) return res.status(400).json({ error: "Missing" }); await saveAction(listingId, userName, action); res.json({ success: true }); });
app.post("/comment", async (req, res) => { const { listingId, userName, body } = req.body; if (!listingId || !userName || !body) return res.status(400).json({ error: "Missing" }); await saveComment(listingId, userName, body); res.json({ success: true }); });
app.post("/seen", async (req, res) => { const { listingIds, userName } = req.body; if (!listingIds || !userName) return res.status(400).json({ error: "Missing" }); await markAllSeen(listingIds, userName); res.json({ success: true }); });
app.get("/refresh", async (req, res) => { try { const count = await fetchAndProcess(); res.json({ success: true, newListings: count, dryRun: DRY_RUN }); } catch (e) { res.status(500).json({ error: e.message }); } });

app.get("/", async (req, res) => {
  const [listings, actions, comments, seenSet] = await Promise.all([loadListings(), loadActions(), loadComments(), loadSeen()]);
  const actionMap = {}; actions.forEach(a => { if (!actionMap[a.listing_id]) actionMap[a.listing_id] = []; actionMap[a.listing_id].push(a); });
  const commentMap = {}; comments.forEach(c => { if (!commentMap[c.listing_id]) commentMap[c.listing_id] = []; commentMap[c.listing_id].push(c); });
  const newIds = listings.filter(l => !seenSet.has(l.id)).map(l => l.id);
  const prices = listings.map(l => { const m = (l.price || "").replace(/,/g, "").match(/\d+/); return m ? parseInt(m[0]) : 0; }).filter(p => p > 0);
  const avgPrice = prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : 0;
  const maxPrice = Math.max(...prices, 10000);

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NYC Sublet Finder</title>
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
.nav-logo{width:36px;height:36px;display:flex;align-items:center;justify-content:center;font-size:22px}
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

.layout{display:grid;grid-template-columns:280px 1fr;min-height:calc(100vh - 60px)}

.sidebar{background:var(--white);border-right:1px solid var(--gray-200);padding:24px 20px;position:sticky;top:60px;height:calc(100vh - 60px);overflow-y:auto}
.sb-section{margin-bottom:26px}
.sb-label{font-size:11px;font-weight:600;color:var(--gray-400);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:10px}

.stats-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:26px}
.scard{background:var(--gray-50);border:1px solid var(--gray-200);border-radius:var(--r);padding:12px;text-align:center}
.scard.hi{background:var(--blue-light);border-color:var(--blue)}
.sval{font-size:22px;font-weight:700;line-height:1}
.scard.hi .sval{color:var(--blue)}
.slbl{font-size:11px;color:var(--gray-400);margin-top:3px}

.fi-group{display:flex;flex-direction:column;gap:4px}
.fi{display:flex;align-items:center;justify-content:space-between;padding:7px 10px;border-radius:var(--r-sm);cursor:pointer;border:none;background:transparent;text-align:left;font-family:'Inter',sans-serif;font-size:13px;color:var(--gray-700);width:100%;transition:background 0.1s}
.fi:hover{background:var(--gray-100)}
.fi.active{background:var(--blue-light);color:var(--blue);font-weight:500}
.fc{font-size:11px;background:var(--gray-200);color:var(--gray-500);padding:1px 7px;border-radius:20px;font-weight:500}
.fi.active .fc{background:var(--blue);color:white}

.hood-grid{display:flex;flex-wrap:wrap;gap:5px}
.hbtn{font-size:12px;padding:4px 10px;border-radius:20px;border:1px solid var(--gray-200);background:var(--white);cursor:pointer;color:var(--gray-500);font-family:'Inter',sans-serif;transition:all 0.12s}
.hbtn:hover{border-color:var(--blue);color:var(--blue)}
.hbtn.active{background:var(--blue);color:white;border-color:var(--blue)}

.price-wrap input[type=range]{width:100%;accent-color:var(--blue);margin-bottom:6px}
.price-labels{display:flex;justify-content:space-between;font-size:12px;color:var(--gray-400)}
.price-val{font-size:14px;font-weight:600;margin-bottom:6px}

.sort-sel{width:100%;padding:8px 10px;border:1px solid var(--gray-200);border-radius:var(--r-sm);background:var(--white);font-family:'Inter',sans-serif;font-size:13px;color:var(--gray-700);cursor:pointer}

.kb-hint{background:var(--gray-50);border:1px solid var(--gray-200);border-radius:var(--r);padding:12px;font-size:11px;color:var(--gray-400);line-height:1.8}
.kb-hint strong{color:var(--gray-700)}
.kb-key{display:inline-block;background:var(--white);border:1px solid var(--gray-300);border-radius:4px;padding:1px 6px;font-size:11px;font-weight:600;color:var(--gray-600);box-shadow:0 1px 0 var(--gray-300);margin-right:4px}

.main-content{padding:24px 28px}
.main-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}
.results-lbl{font-size:14px;color:var(--gray-400)}
.results-lbl strong{color:var(--gray-900)}
.refresh-btn{height:34px;padding:0 14px;border-radius:var(--r-sm);border:1px solid var(--gray-200);background:var(--white);cursor:pointer;font-size:13px;font-family:'Inter',sans-serif;color:var(--gray-500);display:flex;align-items:center;gap:6px;transition:all 0.12s}
.refresh-btn:hover{border-color:var(--blue);color:var(--blue)}

/* CARD */
.card{background:var(--white);border:1px solid var(--gray-200);border-radius:var(--r-lg);overflow:hidden;margin-bottom:12px;cursor:pointer;transition:box-shadow 0.2s,border-color 0.2s;display:grid;grid-template-columns:220px 1fr;min-height:165px;position:relative;border-left-width:4px}
.card:hover{box-shadow:var(--sh-lg);border-color:var(--gray-300)}
.card.score-border-high{border-left-color:var(--green)}
.card.score-border-mid{border-left-color:var(--amber)}
.card.score-border-low{border-left-color:var(--red)}
.card.score-border-none{border-left-color:var(--gray-200)}
.card.is-new{box-shadow:0 0 0 2px rgba(0,112,243,0.15),var(--sh)}
.card.status-skipped{opacity:0.45}
.card.focused{box-shadow:0 0 0 3px rgba(0,112,243,0.3),var(--sh-lg)}

.card-img-wrap{position:relative;overflow:hidden}
.card-img{width:100%;height:100%;object-fit:cover;display:block;transition:transform 0.3s}
.card:hover .card-img{transform:scale(1.04)}
.card-img-ph{width:100%;height:100%;background:linear-gradient(135deg,var(--gray-100),var(--gray-200));display:flex;align-items:center;justify-content:center;color:var(--gray-400);font-size:12px}
.new-badge{position:absolute;top:10px;left:10px;background:var(--blue);color:white;font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;animation:pulse 2s infinite}
.score-float{position:absolute;bottom:10px;left:10px;padding:4px 9px;border-radius:20px;font-size:12px;font-weight:700;backdrop-filter:blur(8px)}
.sf-high{background:rgba(0,166,81,0.92);color:white}
.sf-mid{background:rgba(245,158,11,0.92);color:white}
.sf-low{background:rgba(229,62,62,0.92);color:white}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.7}}

.card-body{padding:14px 16px;display:flex;flex-direction:column;justify-content:space-between;gap:6px}
.card-row1{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
.card-title{font-size:13px;font-weight:600;color:var(--gray-900);line-height:1.3;flex:1;text-transform:capitalize}
.card-price-wrap{text-align:right;flex-shrink:0}
.card-price{font-size:15px;font-weight:700;white-space:nowrap}
.card-price-diff{font-size:11px;font-weight:500;margin-top:1px}
.price-below{color:var(--green)}
.price-above{color:var(--red)}
.price-avg{color:var(--gray-400)}

.card-meta{font-size:12px;color:var(--gray-400);display:flex;gap:8px;flex-wrap:wrap}
.card-score-reason{font-size:11px;color:var(--gray-400);font-style:italic;line-height:1.4}

/* Availability timeline */
.avail-bar{margin:2px 0}
.avail-label{font-size:10px;font-weight:600;color:var(--gray-400);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;display:flex;justify-content:space-between}
.avail-track{height:5px;background:var(--gray-100);border-radius:3px;position:relative;overflow:hidden}
.avail-range{position:absolute;top:0;height:100%;border-radius:3px;background:var(--gray-300)}
.avail-overlap{position:absolute;top:0;height:100%;border-radius:3px;background:var(--green)}
.avail-target{position:absolute;top:-1px;height:7px;border-radius:3px;background:rgba(0,112,243,0.25);border:1px solid var(--blue)}

.card-bottom{display:flex;align-items:center;justify-content:space-between;gap:6px}
.card-tags{display:flex;gap:4px;flex-wrap:wrap}
.tag{font-size:11px;font-weight:500;padding:2px 7px;border-radius:20px}
.tag-gray{background:var(--gray-100);color:var(--gray-500)}
.tag-blue{background:var(--blue-light);color:var(--blue)}
.tag-green{background:var(--green-bg);color:var(--green)}
.tag-amber{background:var(--amber-bg);color:var(--amber)}
.tag-purple{background:var(--purple-bg);color:var(--purple)}
.tag-red{background:var(--red-bg);color:var(--red)}

/* PANEL */
.overlay{position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:300;opacity:0;pointer-events:none;transition:opacity 0.25s;backdrop-filter:blur(2px)}
.overlay.open{opacity:1;pointer-events:all}
.panel{position:fixed;top:0;right:0;height:100vh;width:520px;max-width:100vw;background:var(--white);z-index:400;transform:translateX(100%);transition:transform 0.3s cubic-bezier(0.32,0.72,0,1);overflow-y:auto;box-shadow:var(--sh-lg)}
.panel.open{transform:translateX(0)}
.ph{padding:20px 24px 16px;border-bottom:1px solid var(--gray-200);position:sticky;top:0;background:var(--white);z-index:10;display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.pclose{width:32px;height:32px;border-radius:50%;border:1px solid var(--gray-200);background:var(--white);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:16px;color:var(--gray-400);flex-shrink:0;transition:all 0.12s}
.pclose:hover{background:var(--gray-100)}
.ptitle{font-size:15px;font-weight:600;line-height:1.3;text-transform:capitalize}
.pprice{font-size:20px;font-weight:700;margin-top:2px}
.pmeta{font-size:12px;color:var(--gray-400);margin-top:2px}
.pimg{width:100%;height:220px;object-fit:cover;display:block}
.pbody{padding:20px 24px}
.ps{margin-bottom:24px}
.ps-title{font-size:11px;font-weight:700;color:var(--gray-400);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:12px}

.dtabs{display:flex;gap:0;margin-bottom:12px;border-bottom:1px solid var(--gray-200)}
.dtab{font-size:13px;padding:8px 14px;border:none;background:transparent;cursor:pointer;color:var(--gray-400);font-family:'Inter',sans-serif;font-weight:500;border-bottom:2px solid transparent;margin-bottom:-1px;transition:all 0.12s}
.dtab.active{color:var(--blue);border-bottom-color:var(--blue)}
.dpane{display:none}.dpane.active{display:block}
.dsubj{font-size:12px;color:var(--gray-400);margin-bottom:6px;font-weight:500}
.dbox{position:relative}
.dta{width:100%;min-height:100px;font-size:13px;line-height:1.6;resize:vertical;background:var(--gray-50);border:1px solid var(--gray-200);border-radius:var(--r);padding:12px 44px 12px 14px;color:var(--gray-900);font-family:'Inter',sans-serif}
.dta:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 3px rgba(0,112,243,0.1)}
.cbtn{position:absolute;top:10px;right:10px;font-size:11px;padding:4px 10px;background:var(--white);border:1px solid var(--gray-200);border-radius:var(--r-sm);cursor:pointer;color:var(--gray-400);font-family:'Inter',sans-serif;transition:all 0.12s}
.cbtn:hover{border-color:var(--blue);color:var(--blue)}

.abtns{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.abtn{height:34px;padding:0 14px;border-radius:var(--r-sm);border:1.5px solid var(--gray-200);cursor:pointer;font-size:13px;font-weight:500;font-family:'Inter',sans-serif;transition:all 0.15s;display:flex;align-items:center;gap:5px}
.abtn:hover{filter:brightness(0.95);transform:translateY(-1px)}
.btn-c{background:var(--green-bg);color:var(--green);border-color:#86efac}
.btn-r{background:var(--purple-bg);color:var(--purple);border-color:#c4b5fd}
.btn-v{background:var(--blue-light);color:var(--blue);border-color:#93c5fd}
.btn-p{background:var(--red-bg);color:var(--red);border-color:#fca5a5}
.alog{display:flex;flex-direction:column;gap:6px}
.alog-i{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--gray-500);padding:6px 10px;background:var(--gray-50);border-radius:var(--r-sm)}

.clist{display:flex;flex-direction:column;gap:10px;margin-bottom:12px}
.comment{display:flex;gap:10px}
.cav{width:30px;height:30px;border-radius:50%;background:var(--blue);color:white;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.cav.j{background:var(--purple)}.cav.n{background:#db2777}.cav.m{background:#059669}
.cbub{flex:1;background:var(--gray-50);border:1px solid var(--gray-200);border-radius:4px 12px 12px 12px;padding:8px 12px}
.cmeta{font-size:11px;color:var(--gray-400);margin-bottom:3px;font-weight:500}
.cbody{font-size:13px;color:var(--gray-800);line-height:1.5}
.cinput-wrap{display:flex;gap:8px}
.cinput{flex:1;padding:9px 12px;border:1px solid var(--gray-200);border-radius:var(--r);font-family:'Inter',sans-serif;font-size:13px;background:var(--white);transition:border-color 0.12s}
.cinput:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 3px rgba(0,112,243,0.1)}
.csend{height:38px;padding:0 16px;border-radius:var(--r);border:none;background:var(--blue);color:white;font-size:13px;font-weight:600;font-family:'Inter',sans-serif;cursor:pointer}
.csend:hover{background:var(--blue-dark)}

.map-btn{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--blue);text-decoration:none;font-weight:500}
.map-btn:hover{text-decoration:underline}
.amen-list{display:flex;flex-wrap:wrap;gap:5px}
.amen{font-size:11px;padding:3px 9px;border-radius:var(--r-sm);background:var(--gray-100);color:var(--gray-600);border:1px solid var(--gray-200)}

.dry-bar{background:var(--amber-bg);border-bottom:1px solid #fde68a;padding:8px 32px;font-size:12px;color:var(--amber);font-weight:500;text-align:center}
.empty{text-align:center;padding:80px 20px;color:var(--gray-400)}
.empty h3{font-size:18px;color:var(--gray-700);margin-bottom:8px}

@media(max-width:768px){
  .layout{grid-template-columns:1fr}
  .sidebar{display:none}
  .card{grid-template-columns:130px 1fr;min-height:120px}
  .panel{width:100vw}
  nav{padding:0 16px}
  .main-content{padding:16px}
}
</style>
</head>
<body>

${DRY_RUN ? `<div class="dry-bar">⚠️ Dry run mode — messages not sending. Set DRY_RUN=false in Railway to go live.</div>` : ""}

<nav>
  <div class="nav-brand">
    <div class="nav-logo">🤝</div>
    <div>
      <div class="nav-title">NYC Sublet Finder</div>
      <div class="nav-sub">Alex · Julian · Nora · Manhattan · June–Aug 2026</div>
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
      <button class="uopt" onclick="setUser('Julian','J','j')"><div class="uav j">J</div><div><div>Julian</div><div class="uopt-sub">HBS · Austria</div></div></button>
      <button class="uopt" onclick="setUser('Nora','N','n')"><div class="uav n">N</div><div><div>Nora</div><div class="uopt-sub">HBS · Germany</div></div></button>
      <div class="udiv"></div>
      <button class="uopt" onclick="setUser('Marco','M','m')"><div class="uav m">M</div><div><div>Marco</div><div class="uopt-sub">For review only</div></div></button>
    </div>
  </div>
</nav>

<div class="layout">
  <aside class="sidebar">
    <div class="stats-grid">
      <div class="scard hi"><div class="sval" id="s-new">${newIds.length}</div><div class="slbl">New</div></div>
      <div class="scard"><div class="sval" id="s-total">${listings.length}</div><div class="slbl">Total</div></div>
      <div class="scard"><div class="sval" id="s-pending">–</div><div class="slbl">Pending</div></div>
      <div class="scard"><div class="sval" id="s-contacted">–</div><div class="slbl">Contacted</div></div>
    </div>
    <div class="sb-section">
      <div class="sb-label">Status</div>
      <div class="fi-group">
        <button class="fi active" onclick="setFilter('all',this)">All listings <span class="fc">${listings.length}</span></button>
        <button class="fi" onclick="setFilter('new',this)">✨ New <span class="fc">${newIds.length}</span></button>
        <button class="fi" onclick="setFilter('pending',this)">Pending</button>
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
        <div class="price-labels"><span>$1k</span><span>$${Math.round(maxPrice/1000)}k</span></div>
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
        <span class="kb-key">↑↓</span> Navigate cards<br>
        <span class="kb-key">Enter</span> Open listing<br>
        <span class="kb-key">Esc</span> Close panel<br>
        <span class="kb-key">C</span> Mark contacted<br>
        <span class="kb-key">P</span> Pass<br>
        <span class="kb-key">R</span> Got reply
      </div>
    </div>
  </aside>

  <main class="main-content">
    <div class="main-hdr">
      <div class="results-lbl"><strong id="results-count">${listings.length} listings</strong> in Manhattan ${avgPrice ? `· avg $${avgPrice.toLocaleString()}/mo` : ""}</div>
      <button class="refresh-btn" onclick="location.reload()">↻ Refresh</button>
    </div>
    <div id="cards-container">
    ${listings.length === 0 ? `<div class="empty"><h3>No listings yet</h3><p>The agent checks every 30 minutes.</p></div>` :
    listings.map((l, idx) => {
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

      // Price diff
      let priceDiff = "";
      if (price > 0 && avgPrice > 0) {
        const diff = Math.round((price - avgPrice) / avgPrice * 100);
        if (diff < -5) priceDiff = `<div class="card-price-diff price-below">↓ ${Math.abs(diff)}% below avg</div>`;
        else if (diff > 5) priceDiff = `<div class="card-price-diff price-above">↑ ${Math.abs(diff)}% above avg</div>`;
        else priceDiff = `<div class="card-price-diff price-avg">≈ avg price</div>`;
      }

      // Availability bar — June=0%, Aug end=100%
      // Target: June 1 to Aug 31 = days 0-91
      // Parse availableFrom
      const monthMap = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
      const avStr = (l.availableFrom || "").toLowerCase();
      let avStart = -1;
      for (const [mon, idx2] of Object.entries(monthMap)) {
        if (avStr.includes(mon)) { avStart = (idx2 - 5) / 3 * 100; break; }
      }
      const targetStart = 0, targetEnd = 100;
      const avEnd = avStart >= 0 ? Math.min(avStart + 60, 100) : -1;
      const overlapStart = avStart >= 0 ? Math.max(avStart, targetStart) : -1;
      const overlapEnd = avStart >= 0 ? Math.min(avEnd, targetEnd) : -1;
      const hasOverlap = overlapStart >= 0 && overlapEnd > overlapStart;
      const availBarHtml = `
        <div class="avail-bar">
          <div class="avail-label"><span>Jun</span><span>Jul</span><span>Aug</span></div>
          <div class="avail-track">
            <div class="avail-target" style="left:0%;width:100%"></div>
            ${avStart >= 0 ? `<div class="avail-range" style="left:${Math.max(0,avStart)}%;width:${Math.min(100-Math.max(0,avStart),60)}%"></div>` : ""}
            ${hasOverlap ? `<div class="avail-overlap" style="left:${overlapStart}%;width:${overlapEnd-overlapStart}%"></div>` : ""}
          </div>
        </div>`;

      return `
<div class="card score-border-${sc} ${isNew ? "is-new" : ""} status-${status}"
  data-id="${l.id}" data-idx="${idx}" data-status="${status}" data-isnew="${isNew}"
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
        <div class="card-title">${(l.title || "Untitled").slice(0, 55)}</div>
        <div class="card-price-wrap">
          ${l.price ? `<div class="card-price">${l.price}</div>` : ""}
          ${priceDiff}
        </div>
      </div>
      <div class="card-meta">
        <span>📍 ${l.location || "Manhattan"}</span>
        ${l.bedrooms ? `<span>🛏 ${l.bedrooms}BR</span>` : ""}
      </div>
      ${l.scoreReason ? `<div class="card-score-reason">${l.scoreReason}</div>` : ""}
      ${availBarHtml}
    </div>
    <div class="card-bottom">
      <div class="card-tags">
        <span class="tag tag-gray">${l.platform || "Craigslist"}</span>
        ${l.smsSent ? `<span class="tag tag-green">SMS ✓</span>` : ""}
      </div>
      <div>${statusTag}</div>
    </div>
  </div>
</div>`;
    }).join("")}
    </div>
  </main>
</div>

<div class="overlay" id="overlay" onclick="closePanel()"></div>
<div class="panel" id="panel"><div id="panel-content"></div></div>

<script>
const listings = ${JSON.stringify(listings)};
const actionMap = ${JSON.stringify(actionMap)};
const commentMap = ${JSON.stringify(commentMap)};
const newIds = ${JSON.stringify(newIds)};
const avgPrice = ${avgPrice};

// User
let currentUser = localStorage.getItem("sublet_user");
if (currentUser) restoreUser();
function restoreUser() {
  const cm = {Alex:"",Julian:"j",Nora:"n",Marco:"m"};
  const cl = cm[currentUser]||"";
  document.getElementById("nav-lbl").textContent = currentUser;
  const av = document.getElementById("nav-av");
  av.textContent = currentUser[0]; av.className = "uav"+(cl?" "+cl:""); av.style.display="flex";
  document.getElementById("ubtn").classList.add("has-user");
  document.querySelectorAll(".uopt").forEach(o => o.classList.toggle("active", o.textContent.trim().startsWith(currentUser)));
}
function toggleDD() {
  document.getElementById("umenu").classList.toggle("open");
  document.getElementById("ubtn").classList.toggle("open");
}
function setUser(name, init, cl) {
  currentUser = name; localStorage.setItem("sublet_user", name);
  document.getElementById("nav-lbl").textContent = name;
  const av = document.getElementById("nav-av");
  av.textContent = init; av.className = "uav"+(cl?" "+cl:""); av.style.display="flex";
  document.getElementById("ubtn").classList.add("has-user");
  document.querySelectorAll(".uopt").forEach(o => o.classList.remove("active"));
  event.currentTarget.classList.add("active");
  document.getElementById("umenu").classList.remove("open");
  document.getElementById("ubtn").classList.remove("open");
}
document.addEventListener("click", e => {
  if (!document.getElementById("uwrap").contains(e.target)) {
    document.getElementById("umenu").classList.remove("open");
    document.getElementById("ubtn").classList.remove("open");
  }
});

// Mark seen
if (newIds.length > 0) setTimeout(() => {
  fetch("/seen", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({listingIds:newIds,userName:localStorage.getItem("sublet_user")||"unknown"})});
}, 3000);

// Animated counters
function animateCount(el, target) {
  const start = 0, dur = 600;
  const startTime = performance.now();
  function step(now) {
    const p = Math.min((now - startTime) / dur, 1);
    const ease = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(start + (target - start) * ease);
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}
window.addEventListener("load", () => {
  const cards = document.querySelectorAll(".card");
  let pending = 0, contacted = 0;
  cards.forEach(c => { if(c.dataset.status==="pending") pending++; if(["contacted","reply","viewing"].includes(c.dataset.status)) contacted++; });
  animateCount(document.getElementById("s-new"), ${newIds.length});
  animateCount(document.getElementById("s-total"), ${listings.length});
  animateCount(document.getElementById("s-pending"), pending);
  animateCount(document.getElementById("s-contacted"), contacted);
});

// Keyboard navigation
let focusedIdx = -1;
let panelOpen = false;
const visibleCards = () => Array.from(document.querySelectorAll(".card")).filter(c => c.style.display !== "none");

document.addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  const cards = visibleCards();
  if (e.key === "ArrowDown" || e.key === "j") {
    e.preventDefault();
    focusedIdx = Math.min(focusedIdx + 1, cards.length - 1);
    cards.forEach((c,i) => c.classList.toggle("focused", i === focusedIdx));
    cards[focusedIdx]?.scrollIntoView({behavior:"smooth",block:"nearest"});
  } else if (e.key === "ArrowUp" || e.key === "k") {
    e.preventDefault();
    focusedIdx = Math.max(focusedIdx - 1, 0);
    cards.forEach((c,i) => c.classList.toggle("focused", i === focusedIdx));
    cards[focusedIdx]?.scrollIntoView({behavior:"smooth",block:"nearest"});
  } else if (e.key === "Enter" && focusedIdx >= 0 && !panelOpen) {
    const id = cards[focusedIdx]?.dataset.id;
    if (id) openPanel(id);
  } else if (e.key === "Escape") {
    closePanel();
  } else if (e.key === "c" || e.key === "C") {
    if (panelOpen) { const id = document.getElementById("panel").dataset.listingId; if(id) doAction(id,"contacted"); }
    else if (focusedIdx >= 0) { const id = cards[focusedIdx]?.dataset.id; if(id) doAction(id,"contacted"); }
  } else if (e.key === "p" || e.key === "P") {
    if (panelOpen) { const id = document.getElementById("panel").dataset.listingId; if(id) doAction(id,"pass"); }
    else if (focusedIdx >= 0) { const id = cards[focusedIdx]?.dataset.id; if(id) doAction(id,"pass"); }
  } else if (e.key === "r" || e.key === "R") {
    if (panelOpen) { const id = document.getElementById("panel").dataset.listingId; if(id) doAction(id,"reply"); }
  }
});

// Panel
function openPanel(id) {
  const l = listings.find(x => x.id === id); if (!l) return;
  const la = actionMap[id]||[], lc = commentMap[id]||[];
  const ca = la.find(a=>a.action==="contacted"), ra = la.find(a=>a.action==="reply");
  const va = la.find(a=>a.action==="viewing"), pa = la.find(a=>a.action==="pass"||a.action==="skipped");
  const sc = (l.score||0)>=7?"high":(l.score||0)>=5?"mid":"low";
  const timeAgo = t=>{const s=Math.floor((Date.now()-new Date(t))/1000);if(s<60)return"just now";if(s<3600)return Math.floor(s/60)+"m ago";if(s<86400)return Math.floor(s/3600)+"h ago";return Math.floor(s/86400)+"d ago";};
  const avCls = n=>n==="Julian"?"j":n==="Nora"?"n":n==="Marco"?"m":"";
  const pm = (l.price||"").replace(/,/g,"").match(/\\d+/);
  const price = pm?parseInt(pm[0]):0;
  let pdiff = "";
  if(price>0&&avgPrice>0){const d=Math.round((price-avgPrice)/avgPrice*100);if(d<-5)pdiff=\`<span style="color:var(--green);font-size:12px;font-weight:500"> ↓ \${Math.abs(d)}% below avg</span>\`;else if(d>5)pdiff=\`<span style="color:var(--red);font-size:12px;font-weight:500"> ↑ \${Math.abs(d)}% above avg</span>\`;}

  document.getElementById("panel").dataset.listingId = id;
  document.getElementById("panel-content").innerHTML = \`
    <div class="ph">
      <div style="flex:1;min-width:0">
        <div class="ptitle">\${(l.title||"Untitled").replace(/</g,"&lt;")}</div>
        \${l.price?\`<div class="pprice">\${l.price}<span style="font-size:13px;font-weight:400;color:var(--gray-400)">/mo</span>\${pdiff}</div>\`:""}
        <div class="pmeta">📍 \${l.location||"Manhattan"}\${l.bedrooms?" · 🛏 "+l.bedrooms+"BR":""}\${l.availableFrom?" · 📅 "+l.availableFrom:""}</div>
      </div>
      <button class="pclose" onclick="closePanel()">✕</button>
    </div>
    \${l.pics?.[0]?\`<img class="pimg" src="\${l.pics[0]}" alt="">\`:""}
    <div class="pbody">
      \${l.score?\`<div class="ps"><div class="ps-title">Match Score</div><div style="display:flex;align-items:center;gap:12px;padding:12px;background:var(--gray-50);border-radius:var(--r);border:1px solid var(--gray-200)"><span class="score-float sf-\${sc}" style="position:static;font-size:16px;padding:6px 14px">\${l.score}/10</span><span style="font-size:13px;color:var(--gray-500);font-style:italic">\${l.scoreReason||""}</span></div></div>\`:""}
      \${l.post?\`<div class="ps"><div class="ps-title">Description</div><p style="font-size:13px;color:var(--gray-600);line-height:1.7">\${l.post.slice(0,600).replace(/</g,"&lt;")}</p></div>\`:""}
      \${l.amenities?.length?\`<div class="ps"><div class="ps-title">Amenities</div><div class="amen-list">\${l.amenities.map(a=>\`<span class="amen">\${a}</span>\`).join("")}</div></div>\`:""}
      <div class="ps"><a class="map-btn" href="https://maps.google.com?q=\${encodeURIComponent((l.address?.street||l.location||"Manhattan")+" New York NY")}" target="_blank">🗺 View on Google Maps →</a></div>
      \${l.drafts?\`<div class="ps"><div class="ps-title">Message Drafts</div><div class="dtabs"><button class="dtab active" onclick="showDraft('inApp',this)">In-app</button><button class="dtab" onclick="showDraft('email',this)">Email</button><button class="dtab" onclick="showDraft('sms',this)">SMS</button><button class="dtab" onclick="showDraft('whatsapp',this)">WhatsApp</button></div><div id="dp-inApp" class="dpane active"><div class="dbox"><textarea class="dta">\${(l.drafts.inApp||"").replace(/</g,"&lt;")}</textarea><button class="cbtn" onclick="copyDraft(this)">Copy</button></div></div><div id="dp-email" class="dpane"><div class="dsubj"><strong>Subject:</strong> \${(l.drafts.email?.subject||"").replace(/</g,"&lt;")}</div><div class="dbox"><textarea class="dta">\${(l.drafts.email?.body||"").replace(/</g,"&lt;")}</textarea><button class="cbtn" onclick="copyDraft(this)">Copy</button></div></div><div id="dp-sms" class="dpane"><div class="dbox"><textarea class="dta">\${(l.drafts.sms||"").replace(/</g,"&lt;")}</textarea><button class="cbtn" onclick="copyDraft(this)">Copy</button></div></div><div id="dp-whatsapp" class="dpane"><div class="dbox"><textarea class="dta">\${(l.drafts.whatsapp||"").replace(/</g,"&lt;")}</textarea><button class="cbtn" onclick="copyDraft(this)">Copy</button></div></div></div>\`:""}
      <div class="ps"><div class="ps-title">Outreach Status</div>
        <div class="abtns">
          \${!ca?\`<button class="abtn btn-c" onclick="doAction('\${l.id}','contacted')">✓ Contacted</button>\`:""}
          \${ca&&!ra?\`<button class="abtn btn-r" onclick="doAction('\${l.id}','reply')">💬 Got reply</button>\`:""}
          \${(ca||ra)&&!va?\`<button class="abtn btn-v" onclick="doAction('\${l.id}','viewing')">📅 Viewing</button>\`:""}
          \${!pa?\`<button class="abtn btn-p" onclick="doAction('\${l.id}','pass')">✕ Pass</button>\`:""}
        </div>
        \${la.length?\`<div class="alog">\${la.map(a=>\`<div class="alog-i">\${a.action==="contacted"?"✓":a.action==="reply"?"💬":a.action==="viewing"?"📅":"✕"} <strong>\${a.user_name}</strong> \${a.action==="contacted"?"contacted":a.action==="reply"?"got a reply":a.action==="viewing"?"viewing scheduled":"passed"} · \${timeAgo(a.created_at)}</div>\`).join("")}</div>\`:""}
      </div>
      <div class="ps"><div class="ps-title">Notes</div>
        <div class="clist">\${lc.map(c=>\`<div class="comment"><div class="cav \${avCls(c.user_name)}">\${c.user_name[0]}</div><div class="cbub"><div class="cmeta">\${c.user_name} · \${timeAgo(c.created_at)}</div><div class="cbody">\${c.body.replace(/</g,"&lt;")}</div></div></div>\`).join("")}</div>
        <div class="cinput-wrap"><input class="cinput" id="ci-\${l.id}" placeholder="Add a note..." onkeydown="if(event.key==='Enter')sendComment('\${l.id}')"><button class="csend" onclick="sendComment('\${l.id}')">Send</button></div>
      </div>
      <div style="padding-top:8px"><a href="\${l.url}" target="_blank" style="font-size:13px;color:var(--blue);font-weight:500;text-decoration:none">View original listing →</a></div>
    </div>
  \`;
  document.getElementById("overlay").classList.add("open");
  document.getElementById("panel").classList.add("open");
  document.body.style.overflow="hidden";
  panelOpen = true;
}

function closePanel() {
  document.getElementById("overlay").classList.remove("open");
  document.getElementById("panel").classList.remove("open");
  document.body.style.overflow="";
  panelOpen = false;
}

function showDraft(tab,btn) {
  document.querySelectorAll(".dpane").forEach(p=>p.classList.remove("active"));
  document.getElementById("dp-"+tab).classList.add("active");
  document.querySelectorAll(".dtab").forEach(t=>t.classList.remove("active"));
  btn.classList.add("active");
}
function copyDraft(btn) { navigator.clipboard.writeText(btn.previousElementSibling.value).then(()=>{btn.textContent="Copied!";setTimeout(()=>btn.textContent="Copy",1500);}); }

async function doAction(lid, action) {
  if(!currentUser){alert("Select your name from the dropdown first.");return;}
  await fetch("/action",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({listingId:lid,userName:currentUser,action})});
  location.reload();
}
async function sendComment(lid) {
  if(!currentUser){alert("Select your name from the dropdown first.");return;}
  const input=document.getElementById("ci-"+lid);
  const body=input.value.trim();if(!body)return;
  input.value="";
  await fetch("/comment",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({listingId:lid,userName:currentUser,body})});
  location.reload();
}

let activeFilter="all",activeHood="all",maxPF=${maxPrice};
function setFilter(f,btn){activeFilter=f;document.querySelectorAll(".fi").forEach(b=>b.classList.remove("active"));btn.classList.add("active");applyFilters();}
function toggleHood(hood,btn){activeHood=hood;document.querySelectorAll(".hbtn").forEach(b=>b.classList.remove("active"));btn.classList.add("active");applyFilters();}
function updatePrice(val){maxPF=parseInt(val);document.getElementById("price-lbl").textContent="$"+parseInt(val).toLocaleString()+"/mo";applyFilters();}
function applyFilters(){
  let v=0;
  document.querySelectorAll(".card").forEach(card=>{
    const s=card.dataset.status,n=card.dataset.isnew==="true";
    const p=parseInt(card.dataset.price)||0,l=card.dataset.loc||"";
    const ok=(activeFilter==="all"||(activeFilter==="new"&&n)||s===activeFilter)&&(activeHood==="all"||l.includes(activeHood))&&(p===0||p<=maxPF);
    card.style.display=ok?"grid":"none";
    if(ok)v++;
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
  cards.forEach(c=>c.appendChild?c:null);
  cards.forEach(c=>document.getElementById("cards-container").appendChild(c));
}
</script>
</body>
</html>`);
});

app.listen(PORT, async () => {
  console.log(`Sublet agent running on port ${PORT} [DRY_RUN=${DRY_RUN}]`);
  await initDb();
  fetchAndProcess().catch(console.error);
  setInterval(() => fetchAndProcess().catch(console.error), 30 * 60 * 1000);
});
