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
async function saveAction(listingId, userName, action) {
  if (!db) return;
  await db.query("INSERT INTO actions (listing_id, user_name, action) VALUES ($1, $2, $3)", [listingId, userName, action]);
}
async function saveComment(listingId, userName, body) {
  if (!db) return;
  await db.query("INSERT INTO comments (listing_id, user_name, body) VALUES ($1, $2, $3)", [listingId, userName, body]);
}

function passes(listing) {
  if ((listing.bedrooms || 0) < 2) return false;
  const nonManhattan = ["Brooklyn", "Queens", "Bronx", "Jersey City", "Ridgewood", "Woodside", "Long Island City"];
  const loc = (listing.location || "") + (listing.address?.city || "");
  if (nonManhattan.some(b => loc.includes(b))) return false;
  const avail = (listing.availableFrom || "").toLowerCase();
  if (avail.includes("jul") || avail.includes("aug") || avail.includes("sep")) return false;
  return true;
}

async function fetchListings() {
  const url = "https://newyork.craigslist.org/search/mnh/sub?min_bedrooms=2&max_bedrooms=3";
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", "Accept": "text/html,application/xhtml+xml" } });
  const html = await res.text();
  const items = [];
  const linkPattern = /href="(https:\/\/newyork\.craigslist\.org\/mnh\/sub\/d\/[^"]+)"/g;
  let m; const links = [];
  while ((m = linkPattern.exec(html)) !== null) { if (!links.includes(m[1])) links.push(m[1]); }
  for (const link of links.slice(0, 50)) {
    const idMatch = link.match(/(\d+)\.html/);
    const id = idMatch ? idMatch[1] : Math.random().toString(36).slice(2);
    const title = link.split("/").pop().replace(".html", "").replace(/-/g, " ");
    const li = html.indexOf(link);
    const sur = html.slice(Math.max(0, li - 200), li + 200);
    const pm = sur.match(/\$[\d,]+/);
    items.push({ id, title, url: link, post: "", price: pm ? pm[0] : "", bedrooms: 2, location: "Manhattan, NY", availableFrom: "", datetime: new Date().toISOString(), phoneNumbers: [], platform: "Craigslist", address: { city: "New York" } });
  }
  return items;
}

async function generateDraftAndScore(listing) {
  const system = `You help three HBS students (Alex, Julian, Nora from Germany/Austria) find a 2-3BR Manhattan sublet for June–August 2026. Return ONLY valid JSON: {"inApp":"...","email":{"subject":"...","body":"..."},"sms":"...","whatsapp":"...","score":7,"scoreReason":"one sentence"}. Score 1-10 on price fit ($4-8k/mo for 2-3BR), location, June availability, furnished. Be strict — 8+ only for great fits.`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, system, messages: [{ role: "user", content: `Title: ${listing.title}\nPrice: ${listing.price}\nLocation: ${listing.location}\nBedrooms: ${listing.bedrooms}\nAvailable: ${listing.availableFrom}` }] }),
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
    for (const listing of newListings) {
      try { const r = await generateDraftAndScore(listing); listing.drafts = { inApp: r.inApp, email: r.email, sms: r.sms, whatsapp: r.whatsapp }; listing.score = r.score; listing.scoreReason = r.scoreReason; } catch (e) { console.error("Draft failed:", e.message); }
      if (listing.phoneNumbers?.length > 0 && listing.drafts) { const r = await sendSms(listing.phoneNumbers[0], listing.drafts.sms); listing.smsSent = !r?.dryRun; listing.smsDryRun = r?.dryRun || false; } else { listing.needsManualSend = true; }
      await saveListing(listing);
    }
    if (newListings.length > 0) await sendAlertToMe(newListings.length);
    return newListings.length;
  } finally { isFetching = false; }
}

app.post("/action", async (req, res) => { const { listingId, userName, action } = req.body; if (!listingId || !userName || !action) return res.status(400).json({ error: "Missing fields" }); await saveAction(listingId, userName, action); res.json({ success: true }); });
app.post("/comment", async (req, res) => { const { listingId, userName, body } = req.body; if (!listingId || !userName || !body) return res.status(400).json({ error: "Missing fields" }); await saveComment(listingId, userName, body); res.json({ success: true }); });
app.post("/seen", async (req, res) => { const { listingIds, userName } = req.body; if (!listingIds || !userName) return res.status(400).json({ error: "Missing fields" }); await markAllSeen(listingIds, userName); res.json({ success: true }); });
app.get("/refresh", async (req, res) => { try { const count = await fetchAndProcess(); res.json({ success: true, newListings: count, dryRun: DRY_RUN }); } catch (e) { res.status(500).json({ error: e.message }); } });

app.get("/", async (req, res) => {
  const [listings, actions, comments, seenSet] = await Promise.all([loadListings(), loadActions(), loadComments(), loadSeen()]);
  const actionMap = {}; actions.forEach(a => { if (!actionMap[a.listing_id]) actionMap[a.listing_id] = []; actionMap[a.listing_id].push(a); });
  const commentMap = {}; comments.forEach(c => { if (!commentMap[c.listing_id]) commentMap[c.listing_id] = []; commentMap[c.listing_id].push(c); });
  const newIds = listings.filter(l => !seenSet.has(l.id)).map(l => l.id);
  const maxPrice = Math.max(...listings.map(l => { const m = (l.price || "").replace(/,/g, "").match(/\d+/); return m ? parseInt(m[0]) : 0; }).filter(p => p > 0), 10000);

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
  --radius-sm:6px;--radius:10px;--radius-lg:16px;
  --shadow-sm:0 1px 2px rgba(0,0,0,0.06);
  --shadow:0 2px 8px rgba(0,0,0,0.08),0 1px 2px rgba(0,0,0,0.04);
  --shadow-lg:0 8px 30px rgba(0,0,0,0.12),0 2px 8px rgba(0,0,0,0.06);
}
body{font-family:'Inter',sans-serif;background:var(--gray-50);color:var(--gray-900);min-height:100vh;font-size:14px;line-height:1.5}

/* NAV */
nav{background:var(--white);border-bottom:1px solid var(--gray-200);padding:0 32px;height:60px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:200;box-shadow:var(--shadow-sm)}
.nav-brand{display:flex;align-items:center;gap:10px}
.nav-logo{width:32px;height:32px;background:var(--blue);border-radius:8px;display:flex;align-items:center;justify-content:center;color:white;font-size:16px}
.nav-title{font-size:15px;font-weight:700;letter-spacing:-0.3px;color:var(--gray-900)}
.nav-subtitle{font-size:12px;color:var(--gray-400);margin-top:1px}
.nav-users{display:flex;align-items:center;gap:6px}
.user-btn{height:34px;padding:0 14px;border-radius:20px;border:1.5px solid var(--gray-200);background:var(--white);cursor:pointer;color:var(--gray-500);font-size:13px;font-weight:500;font-family:'Inter',sans-serif;transition:all 0.15s;display:flex;align-items:center;gap:6px}
.user-btn:hover{border-color:var(--blue);color:var(--blue)}
.user-btn.active{border-color:var(--blue);color:var(--blue);background:var(--blue-light)}
.user-avatar{width:20px;height:20px;border-radius:50%;background:var(--blue);color:white;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center}
.user-avatar.j{background:var(--purple)}
.user-avatar.n{background:#db2777}

/* LAYOUT */
.layout{display:grid;grid-template-columns:280px 1fr;min-height:calc(100vh - 60px)}

/* SIDEBAR */
.sidebar{background:var(--white);border-right:1px solid var(--gray-200);padding:24px 20px;position:sticky;top:60px;height:calc(100vh - 60px);overflow-y:auto}
.sidebar-section{margin-bottom:28px}
.sidebar-label{font-size:11px;font-weight:600;color:var(--gray-400);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:10px}

/* Stats in sidebar */
.stats-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:28px}
.stat-card{background:var(--gray-50);border:1px solid var(--gray-200);border-radius:var(--radius);padding:12px;text-align:center}
.stat-card.highlight{background:var(--blue-light);border-color:var(--blue)}
.stat-val{font-size:22px;font-weight:700;line-height:1}
.stat-card.highlight .stat-val{color:var(--blue)}
.stat-lbl{font-size:11px;color:var(--gray-400);margin-top:3px}

.filter-group{display:flex;flex-direction:column;gap:4px}
.filter-item{display:flex;align-items:center;justify-content:space-between;padding:7px 10px;border-radius:var(--radius-sm);cursor:pointer;transition:all 0.12s;border:none;background:transparent;text-align:left;font-family:'Inter',sans-serif;font-size:13px;color:var(--gray-700);width:100%}
.filter-item:hover{background:var(--gray-100)}
.filter-item.active{background:var(--blue-light);color:var(--blue);font-weight:500}
.filter-count{font-size:11px;background:var(--gray-200);color:var(--gray-500);padding:1px 7px;border-radius:20px;font-weight:500}
.filter-item.active .filter-count{background:var(--blue);color:white}

.hood-grid{display:flex;flex-wrap:wrap;gap:5px}
.hood-btn{font-size:12px;padding:4px 10px;border-radius:20px;border:1px solid var(--gray-200);background:var(--white);cursor:pointer;color:var(--gray-500);font-family:'Inter',sans-serif;transition:all 0.12s}
.hood-btn:hover{border-color:var(--blue);color:var(--blue)}
.hood-btn.active{background:var(--blue);color:white;border-color:var(--blue)}

.price-slider-wrap{padding:4px 0}
.price-slider-wrap input[type=range]{width:100%;accent-color:var(--blue);margin-bottom:6px}
.price-slider-labels{display:flex;justify-content:space-between;font-size:12px;color:var(--gray-400)}
.price-val{font-size:14px;font-weight:600;color:var(--gray-900);margin-bottom:6px}

.sort-select{width:100%;padding:8px 10px;border:1px solid var(--gray-200);border-radius:var(--radius-sm);background:var(--white);font-family:'Inter',sans-serif;font-size:13px;color:var(--gray-700);cursor:pointer}

/* MAIN */
.main-content{padding:24px 28px}
.main-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}
.results-label{font-size:14px;color:var(--gray-400)}
.results-label strong{color:var(--gray-900)}
.refresh-btn{height:34px;padding:0 14px;border-radius:var(--radius-sm);border:1px solid var(--gray-200);background:var(--white);cursor:pointer;font-size:13px;font-family:'Inter',sans-serif;color:var(--gray-500);display:flex;align-items:center;gap:6px;transition:all 0.12s}
.refresh-btn:hover{border-color:var(--blue);color:var(--blue)}

/* CARD */
.card{background:var(--white);border:1px solid var(--gray-200);border-radius:var(--radius-lg);overflow:hidden;margin-bottom:12px;cursor:pointer;transition:box-shadow 0.2s,border-color 0.2s;display:grid;grid-template-columns:220px 1fr;min-height:160px}
.card:hover{box-shadow:var(--shadow-lg);border-color:var(--gray-300)}
.card.is-new{border-color:var(--blue);box-shadow:0 0 0 2px rgba(0,112,243,0.12)}
.card.status-skipped{opacity:0.45}
.card-img-wrap{position:relative;overflow:hidden}
.card-img{width:100%;height:100%;object-fit:cover;display:block;transition:transform 0.3s}
.card:hover .card-img{transform:scale(1.03)}
.card-img-placeholder{width:100%;height:100%;background:linear-gradient(135deg,var(--gray-100),var(--gray-200));display:flex;align-items:center;justify-content:center;color:var(--gray-400);font-size:12px}
.new-badge{position:absolute;top:10px;left:10px;background:var(--blue);color:white;font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;animation:pulse 2s infinite}
.score-badge{position:absolute;bottom:10px;left:10px;padding:4px 9px;border-radius:20px;font-size:12px;font-weight:700;backdrop-filter:blur(8px)}
.score-high{background:rgba(0,166,81,0.9);color:white}
.score-mid{background:rgba(245,158,11,0.9);color:white}
.score-low{background:rgba(229,62,62,0.9);color:white}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.75}}

.card-body{padding:16px 18px;display:flex;flex-direction:column;justify-content:space-between}
.card-top{}
.card-row1{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px}
.card-title{font-size:14px;font-weight:600;color:var(--gray-900);line-height:1.3;flex:1;margin-right:12px;text-transform:capitalize}
.card-price{font-size:16px;font-weight:700;white-space:nowrap;color:var(--gray-900)}
.card-price small{font-size:11px;font-weight:400;color:var(--gray-400)}
.card-meta{font-size:12px;color:var(--gray-400);margin-bottom:8px;display:flex;gap:10px;flex-wrap:wrap}
.card-desc{font-size:12px;color:var(--gray-500);line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-bottom:10px}
.card-score-reason{font-size:11px;color:var(--gray-400);font-style:italic;margin-bottom:8px}

.card-bottom{display:flex;align-items:center;justify-content:space-between;gap:8px}
.card-tags{display:flex;gap:5px;flex-wrap:wrap}
.tag{font-size:11px;font-weight:500;padding:2px 8px;border-radius:20px}
.tag-gray{background:var(--gray-100);color:var(--gray-500)}
.tag-blue{background:var(--blue-light);color:var(--blue)}
.tag-green{background:var(--green-bg);color:var(--green)}
.tag-amber{background:var(--amber-bg);color:var(--amber)}
.tag-purple{background:var(--purple-bg);color:var(--purple)}
.tag-red{background:var(--red-bg);color:var(--red)}
.card-action-tags{display:flex;gap:4px}

/* PANEL */
.panel-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:300;opacity:0;pointer-events:none;transition:opacity 0.25s;backdrop-filter:blur(2px)}
.panel-overlay.open{opacity:1;pointer-events:all}
.panel{position:fixed;top:0;right:0;height:100vh;width:520px;max-width:100vw;background:var(--white);z-index:400;transform:translateX(100%);transition:transform 0.3s cubic-bezier(0.32,0.72,0,1);overflow-y:auto;box-shadow:var(--shadow-lg)}
.panel.open{transform:translateX(0)}
.panel-header{padding:20px 24px 16px;border-bottom:1px solid var(--gray-200);position:sticky;top:0;background:var(--white);z-index:10;display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.panel-close{width:32px;height:32px;border-radius:50%;border:1px solid var(--gray-200);background:var(--white);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:16px;color:var(--gray-400);flex-shrink:0;transition:all 0.12s}
.panel-close:hover{background:var(--gray-100);color:var(--gray-900)}
.panel-title{font-size:15px;font-weight:600;color:var(--gray-900);line-height:1.3;text-transform:capitalize}
.panel-price{font-size:20px;font-weight:700;color:var(--gray-900);margin-top:2px}
.panel-meta{font-size:12px;color:var(--gray-400);margin-top:2px}
.panel-img{width:100%;height:220px;object-fit:cover;display:block}
.panel-body{padding:20px 24px}
.panel-section{margin-bottom:24px}
.panel-section-title{font-size:11px;font-weight:700;color:var(--gray-400);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:12px}

.draft-tabs{display:flex;gap:4px;margin-bottom:12px;border-bottom:1px solid var(--gray-200);padding-bottom:0}
.draft-tab{font-size:13px;padding:8px 14px;border:none;background:transparent;cursor:pointer;color:var(--gray-400);font-family:'Inter',sans-serif;font-weight:500;border-bottom:2px solid transparent;margin-bottom:-1px;transition:all 0.12s}
.draft-tab.active{color:var(--blue);border-bottom-color:var(--blue)}
.draft-pane{display:none}
.draft-pane.active{display:block}
.draft-subject{font-size:12px;color:var(--gray-400);margin-bottom:6px;font-weight:500}
.draft-box{position:relative}
.draft-ta{width:100%;min-height:100px;font-size:13px;line-height:1.6;resize:vertical;background:var(--gray-50);border:1px solid var(--gray-200);border-radius:var(--radius);padding:12px 44px 12px 14px;color:var(--gray-900);font-family:'Inter',sans-serif}
.draft-ta:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 3px rgba(0,112,243,0.1)}
.copy-btn{position:absolute;top:10px;right:10px;font-size:11px;padding:4px 10px;background:var(--white);border:1px solid var(--gray-200);border-radius:var(--radius-sm);cursor:pointer;color:var(--gray-400);font-family:'Inter',sans-serif;transition:all 0.12s}
.copy-btn:hover{border-color:var(--blue);color:var(--blue)}

.action-btns-panel{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.action-btn{height:34px;padding:0 14px;border-radius:var(--radius-sm);border:1.5px solid var(--gray-200);cursor:pointer;font-size:13px;font-weight:500;font-family:'Inter',sans-serif;transition:all 0.15s;display:flex;align-items:center;gap:5px}
.btn-contacted{background:var(--green-bg);color:var(--green);border-color:#86efac}
.btn-reply{background:var(--purple-bg);color:var(--purple);border-color:#c4b5fd}
.btn-viewing{background:var(--blue-light);color:var(--blue);border-color:#93c5fd}
.btn-pass{background:var(--red-bg);color:var(--red);border-color:#fca5a5}
.action-btn:hover{filter:brightness(0.95);transform:translateY(-1px)}

.action-log{display:flex;flex-direction:column;gap:6px}
.action-log-item{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--gray-500);padding:6px 10px;background:var(--gray-50);border-radius:var(--radius-sm)}

.comment-list{display:flex;flex-direction:column;gap:10px;margin-bottom:12px}
.comment{display:flex;gap:10px}
.c-avatar{width:30px;height:30px;border-radius:50%;background:var(--blue);color:white;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.c-avatar.j{background:var(--purple)}
.c-avatar.n{background:#db2777}
.c-bubble{flex:1;background:var(--gray-50);border:1px solid var(--gray-200);border-radius:4px 12px 12px 12px;padding:8px 12px}
.c-meta{font-size:11px;color:var(--gray-400);margin-bottom:3px;font-weight:500}
.c-body{font-size:13px;color:var(--gray-800);line-height:1.5}
.comment-input-wrap{display:flex;gap:8px}
.comment-input{flex:1;padding:9px 12px;border:1px solid var(--gray-200);border-radius:var(--radius);font-family:'Inter',sans-serif;font-size:13px;background:var(--white);transition:border-color 0.12s}
.comment-input:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 3px rgba(0,112,243,0.1)}
.comment-send{height:38px;padding:0 16px;border-radius:var(--radius);border:none;background:var(--blue);color:white;font-size:13px;font-weight:600;font-family:'Inter',sans-serif;cursor:pointer;transition:background 0.15s}
.comment-send:hover{background:var(--blue-dark)}

.map-btn{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--blue);text-decoration:none;font-weight:500;padding:6px 0}
.map-btn:hover{text-decoration:underline}

.amenity-list{display:flex;flex-wrap:wrap;gap:5px}
.amenity{font-size:11px;padding:3px 9px;border-radius:var(--radius-sm);background:var(--gray-100);color:var(--gray-600);border:1px solid var(--gray-200)}

.dry-run-bar{background:var(--amber-bg);border-bottom:1px solid #fde68a;padding:8px 32px;font-size:12px;color:var(--amber);font-weight:500;text-align:center}

.empty-state{text-align:center;padding:80px 20px;color:var(--gray-400)}
.empty-state h3{font-size:18px;color:var(--gray-700);margin-bottom:8px}

@media(max-width:768px){
  .layout{grid-template-columns:1fr}
  .sidebar{display:none}
  .card{grid-template-columns:140px 1fr;min-height:120px}
  .panel{width:100vw}
  nav{padding:0 16px}
  .main-content{padding:16px}
}
</style>
</head>
<body>

${DRY_RUN ? `<div class="dry-run-bar">⚠️ Dry run mode — messages not sending. Set DRY_RUN=false in Railway to go live.</div>` : ""}

<nav>
  <div class="nav-brand">
    <div class="nav-logo">🏙</div>
    <div>
      <div class="nav-title">NYC Sublet Finder</div>
      <div class="nav-subtitle">Alex · Julian · Nora · Manhattan · June–Aug 2026</div>
    </div>
  </div>
  <div class="nav-users">
    <button class="user-btn" onclick="setUser('Alex',this)"><div class="user-avatar">A</div>Alex</button>
    <button class="user-btn" onclick="setUser('Julian',this)"><div class="user-avatar j">J</div>Julian</button>
    <button class="user-btn" onclick="setUser('Nora',this)"><div class="user-avatar n">N</div>Nora</button>
  </div>
</nav>

<div class="layout">
  <aside class="sidebar">
    <div class="stats-grid">
      <div class="stat-card highlight"><div class="stat-val" id="s-new">${newIds.length}</div><div class="stat-lbl">New</div></div>
      <div class="stat-card"><div class="stat-val" id="s-total">${listings.length}</div><div class="stat-lbl">Total</div></div>
      <div class="stat-card"><div class="stat-val" id="s-pending">–</div><div class="stat-lbl">Pending</div></div>
      <div class="stat-card"><div class="stat-val" id="s-contacted">–</div><div class="stat-lbl">Contacted</div></div>
    </div>

    <div class="sidebar-section">
      <div class="sidebar-label">Status</div>
      <div class="filter-group">
        <button class="filter-item active" onclick="setFilter('all',this)">All listings <span class="filter-count">${listings.length}</span></button>
        <button class="filter-item" onclick="setFilter('new',this)">✨ New <span class="filter-count">${newIds.length}</span></button>
        <button class="filter-item" onclick="setFilter('pending',this)">Pending</button>
        <button class="filter-item" onclick="setFilter('contacted',this)">Contacted</button>
        <button class="filter-item" onclick="setFilter('reply',this)">💬 Got reply</button>
        <button class="filter-item" onclick="setFilter('viewing',this)">📅 Viewing</button>
        <button class="filter-item" onclick="setFilter('skipped',this)">Passed</button>
      </div>
    </div>

    <div class="sidebar-section">
      <div class="sidebar-label">Neighborhood</div>
      <div class="hood-grid">
        <button class="hood-btn active" data-hood="all" onclick="toggleHood('all',this)">All</button>
        <button class="hood-btn" data-hood="upper east" onclick="toggleHood('upper east',this)">UES</button>
        <button class="hood-btn" data-hood="upper west" onclick="toggleHood('upper west',this)">UWS</button>
        <button class="hood-btn" data-hood="midtown" onclick="toggleHood('midtown',this)">Midtown</button>
        <button class="hood-btn" data-hood="village" onclick="toggleHood('village',this)">Village</button>
        <button class="hood-btn" data-hood="soho" onclick="toggleHood('soho',this)">SoHo</button>
        <button class="hood-btn" data-hood="tribeca" onclick="toggleHood('tribeca',this)">Tribeca</button>
        <button class="hood-btn" data-hood="financial" onclick="toggleHood('financial',this)">FiDi</button>
        <button class="hood-btn" data-hood="harlem" onclick="toggleHood('harlem',this)">Harlem</button>
      </div>
    </div>

    <div class="sidebar-section">
      <div class="sidebar-label">Max price</div>
      <div class="price-slider-wrap">
        <div class="price-val" id="price-label">$${maxPrice.toLocaleString()}/mo</div>
        <input type="range" id="price-slider" min="1000" max="${maxPrice}" value="${maxPrice}" step="100" oninput="updatePrice(this.value)">
        <div class="price-slider-labels"><span>$1k</span><span>$${Math.round(maxPrice/1000)}k</span></div>
      </div>
    </div>

    <div class="sidebar-section">
      <div class="sidebar-label">Sort by</div>
      <select class="sort-select" id="sort-select" onchange="sortCards()">
        <option value="newest">Newest first</option>
        <option value="score">Best match score</option>
        <option value="price-low">Price: low to high</option>
        <option value="price-high">Price: high to low</option>
      </select>
    </div>
  </aside>

  <main class="main-content">
    <div class="main-header">
      <div class="results-label"><strong id="results-count">${listings.length} listings</strong> in Manhattan</div>
      <button class="refresh-btn" onclick="location.reload()">↻ Refresh</button>
    </div>

    <div id="cards-container">
    ${listings.length === 0 ? `<div class="empty-state"><h3>No listings yet</h3><p>The agent checks every 30 minutes.</p></div>` :
    listings.map(l => {
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
      const sc = (l.score || 0) >= 7 ? "score-high" : (l.score || 0) >= 5 ? "score-mid" : "score-low";
      const statusTag = ra ? `<span class="tag tag-purple">💬 Reply</span>` : va ? `<span class="tag tag-blue">📅 Viewing</span>` : ca ? `<span class="tag tag-green">✓ Contacted</span>` : pa ? `<span class="tag tag-gray">Passed</span>` : "";

      return `
<div class="card ${isNew ? "is-new" : ""} status-${status}"
  data-id="${l.id}" data-status="${status}" data-isnew="${isNew}"
  data-price="${price}" data-score="${l.score || 0}" data-loc="${loc}" data-datetime="${l.datetime || ""}"
  onclick="openPanel('${l.id}')">
  <div class="card-img-wrap">
    ${l.pics?.[0] ? `<img class="card-img" src="${l.pics[0]}" loading="lazy" alt="" onerror="this.parentNode.innerHTML='<div class=card-img-placeholder>No photo</div>'">` : `<div class="card-img-placeholder">No photo</div>`}
    ${isNew ? `<div class="new-badge">New</div>` : ""}
    ${l.score ? `<div class="score-badge ${sc}">${l.score}/10</div>` : ""}
  </div>
  <div class="card-body">
    <div class="card-top">
      <div class="card-row1">
        <div class="card-title">${(l.title || "Untitled listing").slice(0, 60)}</div>
        ${l.price ? `<div class="card-price">${l.price}<small>/mo</small></div>` : ""}
      </div>
      <div class="card-meta">
        <span>📍 ${l.location || "Manhattan"}</span>
        ${l.bedrooms ? `<span>🛏 ${l.bedrooms}BR</span>` : ""}
        ${l.availableFrom ? `<span>📅 ${l.availableFrom}</span>` : ""}
      </div>
      ${l.scoreReason ? `<div class="card-score-reason">${l.scoreReason}</div>` : ""}
    </div>
    <div class="card-bottom">
      <div class="card-tags">
        <span class="tag tag-gray">${l.platform || "Craigslist"}</span>
        ${l.needsManualSend ? `<span class="tag tag-amber">Manual send</span>` : ""}
        ${l.smsSent ? `<span class="tag tag-green">SMS sent</span>` : ""}
      </div>
      <div class="card-action-tags">${statusTag}</div>
    </div>
  </div>
</div>`;
    }).join("")}
    </div>
  </main>
</div>

<!-- SLIDE PANEL -->
<div class="panel-overlay" id="overlay" onclick="closePanel()"></div>
<div class="panel" id="panel">
  <div id="panel-content"></div>
</div>

<script>
const listings = ${JSON.stringify(listings)};
const actionMap = ${JSON.stringify(actionMap)};
const commentMap = ${JSON.stringify(commentMap)};
const newIds = ${JSON.stringify(newIds)};
let currentUser = localStorage.getItem("sublet_user");
if (currentUser) document.querySelectorAll(".user-btn").forEach(b => { if(b.textContent.includes(currentUser)) b.classList.add("active"); });

// Mark seen after 3s
if (newIds.length > 0) setTimeout(() => {
  fetch("/seen", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ listingIds: newIds, userName: localStorage.getItem("sublet_user") || "unknown" }) });
}, 3000);

function setUser(name, btn) {
  currentUser = name; localStorage.setItem("sublet_user", name);
  document.querySelectorAll(".user-btn").forEach(b => b.classList.remove("active")); btn.classList.add("active");
}

// Panel
function openPanel(id) {
  const l = listings.find(x => x.id === id); if (!l) return;
  const la = actionMap[id] || [];
  const lc = commentMap[id] || [];
  const ca = la.find(a => a.action === "contacted");
  const ra = la.find(a => a.action === "reply");
  const va = la.find(a => a.action === "viewing");
  const pa = la.find(a => a.action === "pass" || a.action === "skipped");
  const sc = (l.score || 0) >= 7 ? "score-high" : (l.score || 0) >= 5 ? "score-mid" : "score-low";
  const timeAgo = t => { const s = Math.floor((Date.now() - new Date(t))/1000); if(s<60) return "just now"; if(s<3600) return Math.floor(s/60)+"m ago"; if(s<86400) return Math.floor(s/3600)+"h ago"; return Math.floor(s/86400)+"d ago"; };
  const avCls = n => n==="Julian"?"j":n==="Nora"?"n":"";

  document.getElementById("panel-content").innerHTML = \`
    <div class="panel-header">
      <div style="flex:1;min-width:0">
        <div class="panel-title">\${(l.title||"Untitled").replace(/</g,"&lt;")}</div>
        \${l.price ? \`<div class="panel-price">\${l.price}<span style="font-size:13px;font-weight:400;color:var(--gray-400)">/mo</span></div>\` : ""}
        <div class="panel-meta">📍 \${l.location || "Manhattan"} \${l.bedrooms ? "· 🛏 "+l.bedrooms+"BR" : ""} \${l.availableFrom ? "· 📅 "+l.availableFrom : ""}</div>
      </div>
      <button class="panel-close" onclick="closePanel()">✕</button>
    </div>
    \${l.pics?.[0] ? \`<img class="panel-img" src="\${l.pics[0]}" alt="">\` : ""}
    <div class="panel-body">
      \${l.score ? \`<div class="panel-section"><div class="panel-section-title">Match Score</div><div style="display:flex;align-items:center;gap:12px;padding:12px;background:var(--gray-50);border-radius:var(--radius);border:1px solid var(--gray-200)"><span class="score-badge \${sc}" style="position:static;font-size:18px;padding:6px 14px">\${l.score}/10</span><span style="font-size:13px;color:var(--gray-500);font-style:italic">\${l.scoreReason||""}</span></div></div>\` : ""}
      \${l.post ? \`<div class="panel-section"><div class="panel-section-title">Description</div><p style="font-size:13px;color:var(--gray-600);line-height:1.7">\${l.post.slice(0,600).replace(/</g,"&lt;")}</p></div>\` : ""}
      \${l.amenities?.length ? \`<div class="panel-section"><div class="panel-section-title">Amenities</div><div class="amenity-list">\${l.amenities.map(a=>\`<span class="amenity">\${a}</span>\`).join("")}</div></div>\` : ""}
      <div class="panel-section"><a class="map-btn" href="https://maps.google.com?q=\${encodeURIComponent((l.address?.street||l.location||"Manhattan")+" New York NY")}" target="_blank">🗺 View on Google Maps →</a></div>
      \${l.drafts ? \`
      <div class="panel-section">
        <div class="panel-section-title">Message Drafts</div>
        <div class="draft-tabs">
          <button class="draft-tab active" onclick="showDraft('inApp',this)">In-app</button>
          <button class="draft-tab" onclick="showDraft('email',this)">Email</button>
          <button class="draft-tab" onclick="showDraft('sms',this)">SMS</button>
          <button class="draft-tab" onclick="showDraft('whatsapp',this)">WhatsApp</button>
        </div>
        <div id="dp-inApp" class="draft-pane active"><div class="draft-box"><textarea class="draft-ta">\${(l.drafts.inApp||"").replace(/</g,"&lt;")}</textarea><button class="copy-btn" onclick="copyDraft(this)">Copy</button></div></div>
        <div id="dp-email" class="draft-pane"><div class="draft-subject"><strong>Subject:</strong> \${(l.drafts.email?.subject||"").replace(/</g,"&lt;")}</div><div class="draft-box"><textarea class="draft-ta">\${(l.drafts.email?.body||"").replace(/</g,"&lt;")}</textarea><button class="copy-btn" onclick="copyDraft(this)">Copy</button></div></div>
        <div id="dp-sms" class="draft-pane"><div class="draft-box"><textarea class="draft-ta">\${(l.drafts.sms||"").replace(/</g,"&lt;")}</textarea><button class="copy-btn" onclick="copyDraft(this)">Copy</button></div></div>
        <div id="dp-whatsapp" class="draft-pane"><div class="draft-box"><textarea class="draft-ta">\${(l.drafts.whatsapp||"").replace(/</g,"&lt;")}</textarea><button class="copy-btn" onclick="copyDraft(this)">Copy</button></div></div>
      </div>\` : ""}
      <div class="panel-section">
        <div class="panel-section-title">Outreach Status</div>
        <div class="action-btns-panel">
          \${!ca ? \`<button class="action-btn btn-contacted" onclick="doAction('\${l.id}','contacted')">✓ Contacted</button>\` : ""}
          \${ca && !ra ? \`<button class="action-btn btn-reply" onclick="doAction('\${l.id}','reply')">💬 Got reply</button>\` : ""}
          \${(ca||ra) && !va ? \`<button class="action-btn btn-viewing" onclick="doAction('\${l.id}','viewing')">📅 Viewing scheduled</button>\` : ""}
          \${!pa ? \`<button class="action-btn btn-pass" onclick="doAction('\${l.id}','pass')">✕ Pass</button>\` : ""}
        </div>
        \${la.length ? \`<div class="action-log">\${la.map(a=>\`<div class="action-log-item"><span>\${a.action==="contacted"?"✓":a.action==="reply"?"💬":a.action==="viewing"?"📅":"✕"}</span><strong>\${a.user_name}</strong> \${a.action==="contacted"?"contacted":a.action==="reply"?"got a reply":a.action==="viewing"?"scheduled a viewing":"passed"} · \${timeAgo(a.created_at)}</div>\`).join("")}</div>\` : ""}
      </div>
      <div class="panel-section">
        <div class="panel-section-title">Notes</div>
        <div class="comment-list" id="comment-list-\${l.id}">
          \${lc.map(c=>\`<div class="comment"><div class="c-avatar \${avCls(c.user_name)}">\${c.user_name[0]}</div><div class="c-bubble"><div class="c-meta">\${c.user_name} · \${timeAgo(c.created_at)}</div><div class="c-body">\${c.body.replace(/</g,"&lt;")}</div></div></div>\`).join("")}
        </div>
        <div class="comment-input-wrap">
          <input class="comment-input" id="ci-\${l.id}" placeholder="Add a note..." onkeydown="if(event.key==='Enter')sendComment('\${l.id}')">
          <button class="comment-send" onclick="sendComment('\${l.id}')">Send</button>
        </div>
      </div>
      <div style="padding-top:8px"><a href="\${l.url}" target="_blank" style="font-size:13px;color:var(--blue);font-weight:500;text-decoration:none">View original listing →</a></div>
    </div>
  \`;
  document.getElementById("overlay").classList.add("open");
  document.getElementById("panel").classList.add("open");
  document.body.style.overflow = "hidden";
}

function closePanel() {
  document.getElementById("overlay").classList.remove("open");
  document.getElementById("panel").classList.remove("open");
  document.body.style.overflow = "";
}

function showDraft(tab, btn) {
  document.querySelectorAll(".draft-pane").forEach(p => p.classList.remove("active"));
  document.getElementById("dp-"+tab).classList.add("active");
  document.querySelectorAll(".draft-tab").forEach(t => t.classList.remove("active"));
  btn.classList.add("active");
}

function copyDraft(btn) {
  navigator.clipboard.writeText(btn.previousElementSibling.value).then(() => { btn.textContent = "Copied!"; setTimeout(() => btn.textContent = "Copy", 1500); });
}

async function doAction(listingId, action) {
  if (!currentUser) { alert("Select your name at the top first."); return; }
  await fetch("/action", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ listingId, userName: currentUser, action }) });
  location.reload();
}

async function sendComment(listingId) {
  if (!currentUser) { alert("Select your name at the top first."); return; }
  const input = document.getElementById("ci-"+listingId);
  const body = input.value.trim(); if (!body) return;
  input.value = "";
  await fetch("/comment", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ listingId, userName: currentUser, body }) });
  location.reload();
}

// Filters
let activeFilter = "all", activeHood = "all", maxPriceFilter = ${maxPrice};

function setFilter(f, btn) {
  activeFilter = f;
  document.querySelectorAll(".filter-item").forEach(b => b.classList.remove("active")); btn.classList.add("active");
  applyFilters();
}
function toggleHood(hood, btn) {
  activeHood = hood;
  document.querySelectorAll(".hood-btn").forEach(b => b.classList.remove("active")); btn.classList.add("active");
  applyFilters();
}
function updatePrice(val) {
  maxPriceFilter = parseInt(val);
  document.getElementById("price-label").textContent = "$"+parseInt(val).toLocaleString()+"/mo";
  applyFilters();
}
function applyFilters() {
  let visible = 0;
  document.querySelectorAll(".card").forEach(card => {
    const status = card.dataset.status, isNew = card.dataset.isnew === "true";
    const price = parseInt(card.dataset.price) || 0, loc = card.dataset.loc || "";
    const statusOk = activeFilter === "all" || (activeFilter === "new" && isNew) || status === activeFilter;
    const hoodOk = activeHood === "all" || loc.includes(activeHood);
    const priceOk = price === 0 || price <= maxPriceFilter;
    const show = statusOk && hoodOk && priceOk;
    card.style.display = show ? "grid" : "none";
    if (show) visible++;
  });
  document.getElementById("results-count").textContent = visible + " listing" + (visible !== 1 ? "s" : "");
  updateStats();
}
function sortCards() {
  const sort = document.getElementById("sort-select").value;
  const container = document.getElementById("cards-container");
  const cards = Array.from(container.querySelectorAll(".card"));
  cards.sort((a, b) => {
    if (sort === "score") return (parseInt(b.dataset.score)||0)-(parseInt(a.dataset.score)||0);
    if (sort === "price-low") return (parseInt(a.dataset.price)||0)-(parseInt(b.dataset.price)||0);
    if (sort === "price-high") return (parseInt(b.dataset.price)||0)-(parseInt(a.dataset.price)||0);
    return new Date(b.dataset.datetime)-new Date(a.dataset.datetime);
  });
  cards.forEach(c => container.appendChild(c));
}
function updateStats() {
  const cards = document.querySelectorAll(".card");
  let pending = 0, contacted = 0;
  cards.forEach(c => { if(c.dataset.status==="pending") pending++; if(["contacted","reply","viewing"].includes(c.dataset.status)) contacted++; });
  document.getElementById("s-pending").textContent = pending;
  document.getElementById("s-contacted").textContent = contacted;
}
updateStats();
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
