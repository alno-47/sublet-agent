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
    CREATE TABLE IF NOT EXISTS listings (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS actions (
      id SERIAL PRIMARY KEY,
      listing_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      action TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS comments (
      id SERIAL PRIMARY KEY,
      listing_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS seen (
      id SERIAL PRIMARY KEY,
      listing_id TEXT NOT NULL UNIQUE,
      seen_by TEXT NOT NULL,
      seen_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log("Database ready");
}

async function loadListings() {
  if (!db) return [];
  try {
    const res = await db.query("SELECT data FROM listings ORDER BY created_at DESC LIMIT 200");
    return res.rows.map(r => r.data);
  } catch (e) { console.error("Failed to load listings:", e.message); return []; }
}

async function loadActions() {
  if (!db) return [];
  try {
    const res = await db.query("SELECT * FROM actions ORDER BY created_at DESC");
    return res.rows;
  } catch (e) { return []; }
}

async function loadComments() {
  if (!db) return [];
  try {
    const res = await db.query("SELECT * FROM comments ORDER BY created_at ASC");
    return res.rows;
  } catch (e) { return []; }
}

async function loadSeen() {
  if (!db) return new Set();
  try {
    const res = await db.query("SELECT listing_id FROM seen");
    return new Set(res.rows.map(r => r.listing_id));
  } catch (e) { return new Set(); }
}

async function markAllSeen(listingIds, userName) {
  if (!db || !listingIds.length) return;
  for (const id of listingIds) {
    try {
      await db.query("INSERT INTO seen (listing_id, seen_by) VALUES ($1, $2) ON CONFLICT (listing_id) DO NOTHING", [id, userName]);
    } catch (e) {}
  }
}

async function saveListing(listing) {
  if (!db) return;
  try {
    await db.query(
      "INSERT INTO listings (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2",
      [listing.id, JSON.stringify(listing)]
    );
  } catch (e) { console.error("Failed to save listing:", e.message); }
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
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }
  });
  const html = await res.text();
  const items = [];
  const linkPattern = /href="(https:\/\/newyork\.craigslist\.org\/mnh\/sub\/d\/[^"]+)"/g;
  let linkMatch;
  const links = [];
  while ((linkMatch = linkPattern.exec(html)) !== null) {
    if (!links.includes(linkMatch[1])) links.push(linkMatch[1]);
  }
  for (const link of links.slice(0, 50)) {
    const idMatch = link.match(/(\d+)\.html/);
    const id = idMatch ? idMatch[1] : Math.random().toString(36).slice(2);
    const titleFromUrl = link.split("/").pop().replace(".html", "").replace(/-/g, " ");
    const linkIndex = html.indexOf(link);
    const surrounding = html.slice(Math.max(0, linkIndex - 200), linkIndex + 200);
    const priceMatch = surrounding.match(/\$[\d,]+/);
    items.push({
      id, title: titleFromUrl, url: link, post: "", price: priceMatch ? priceMatch[0] : "",
      bedrooms: 2, location: "Manhattan, NY", availableFrom: "",
      datetime: new Date().toISOString(), phoneNumbers: [],
      platform: "Craigslist", address: { city: "New York" },
    });
  }
  return items;
}

async function generateDraftAndScore(listing) {
  const system = `You are helping three HBS students (Alex, Julian, Nora from Germany/Austria) find a 2-3 bedroom Manhattan sublet for June–August 2026. 

Return ONLY valid JSON, no markdown:
{
  "inApp": "...",
  "email": { "subject": "...", "body": "..." },
  "sms": "...",
  "whatsapp": "...",
  "score": 7,
  "scoreReason": "One sentence explaining the score"
}

Score 1-10 based on: price (ideal $4-8k/mo for 2-3BR), Manhattan location quality, June availability, furnished, 2-3 bedrooms. Be strict — only give 8+ to genuinely great fits.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514", max_tokens: 1000, system,
      messages: [{ role: "user", content: `Title: ${listing.title}\nPrice: ${listing.price}\nLocation: ${listing.location}\nBedrooms: ${listing.bedrooms}\nAvailable: ${listing.availableFrom}\nDescription: ${(listing.post || "").slice(0, 400)}` }]
    }),
  });
  const data = await res.json();
  const text = data.content?.[0]?.text || "{}";
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

async function sendSms(to, body) {
  if (DRY_RUN) { console.log(`[DRY RUN] SMS to ${to}: ${body.slice(0, 60)}...`); return { dryRun: true }; }
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64") },
    body: new URLSearchParams({ To: to, From: TWILIO_FROM, Body: body }).toString(),
  });
  return await res.json();
}

async function sendAlertToMe(count) {
  if (!TWILIO_SID || !ALERT_PHONE) return;
  if (DRY_RUN) { console.log(`[DRY RUN] Alert: ${count} new listings`); return; }
  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64") },
    body: new URLSearchParams({ To: ALERT_PHONE, From: TWILIO_FROM, Body: `${count} new NYC sublet${count > 1 ? "s" : ""} found. Review: https://sublet-agent-production.up.railway.app` }).toString(),
  });
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
    console.log(`${newListings.length} new listings [DRY_RUN=${DRY_RUN}]`);
    for (const listing of newListings) {
      try {
        const result = await generateDraftAndScore(listing);
        listing.drafts = { inApp: result.inApp, email: result.email, sms: result.sms, whatsapp: result.whatsapp };
        listing.score = result.score;
        listing.scoreReason = result.scoreReason;
      } catch (e) { console.error(`Draft/score failed:`, e.message); }
      if (listing.phoneNumbers?.length > 0 && listing.drafts) {
        const result = await sendSms(listing.phoneNumbers[0], listing.drafts.sms);
        listing.smsSent = !result?.dryRun;
        listing.smsDryRun = result?.dryRun || false;
      } else {
        listing.needsManualSend = true;
      }
      await saveListing(listing);
    }
    if (newListings.length > 0) await sendAlertToMe(newListings.length);
    return newListings.length;
  } finally { isFetching = false; }
}

// API routes
app.post("/action", async (req, res) => {
  const { listingId, userName, action } = req.body;
  if (!listingId || !userName || !action) return res.status(400).json({ error: "Missing fields" });
  await saveAction(listingId, userName, action);
  res.json({ success: true });
});

app.post("/comment", async (req, res) => {
  const { listingId, userName, body } = req.body;
  if (!listingId || !userName || !body) return res.status(400).json({ error: "Missing fields" });
  await saveComment(listingId, userName, body);
  res.json({ success: true });
});

app.post("/seen", async (req, res) => {
  const { listingIds, userName } = req.body;
  if (!listingIds || !userName) return res.status(400).json({ error: "Missing fields" });
  await markAllSeen(listingIds, userName);
  res.json({ success: true });
});

app.get("/refresh", async (req, res) => {
  try { const count = await fetchAndProcess(); res.json({ success: true, newListings: count, dryRun: DRY_RUN }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Main app
app.get("/", async (req, res) => {
  const [listings, actions, comments, seenSet] = await Promise.all([loadListings(), loadActions(), loadComments(), loadSeen()]);

  const actionMap = {};
  actions.forEach(a => { if (!actionMap[a.listing_id]) actionMap[a.listing_id] = []; actionMap[a.listing_id].push(a); });
  const commentMap = {};
  comments.forEach(c => { if (!commentMap[c.listing_id]) commentMap[c.listing_id] = []; commentMap[c.listing_id].push(c); });

  const newListingIds = listings.filter(l => !seenSet.has(l.id)).map(l => l.id);

  // Extract price number for filtering
  const priceNum = l => { const m = (l.price || "").replace(/,/g, "").match(/\d+/); return m ? parseInt(m[0]) : 0; };
  const maxPrice = Math.max(...listings.map(priceNum).filter(p => p > 0), 10000);

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NYC Sublet Finder</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #ffffff; --bg2: #f7f7f5; --bg3: #efefed; --border: #e8e8e6;
      --text: #111111; --text2: #666666; --text3: #999999;
      --accent: #2563eb; --accent-bg: #eff6ff;
      --green: #16a34a; --green-bg: #f0fdf4;
      --amber: #d97706; --amber-bg: #fffbeb;
      --red: #dc2626; --red-bg: #fef2f2;
      --purple: #7c3aed; --purple-bg: #f5f3ff;
      --radius: 12px; --shadow: 0 1px 3px rgba(0,0,0,0.08);
    }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg2); color: var(--text); min-height: 100vh; }

    .header { background: var(--bg); border-bottom: 1px solid var(--border); padding: 14px 24px; position: sticky; top: 0; z-index: 100; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
    .header-inner { max-width: 800px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .header-left h1 { font-size: 17px; font-weight: 700; letter-spacing: -0.3px; }
    .header-left p { font-size: 12px; color: var(--text2); margin-top: 2px; }
    .user-select { display: flex; gap: 6px; }
    .user-btn { font-size: 13px; padding: 6px 14px; border-radius: 20px; border: 1.5px solid var(--border); background: var(--bg); cursor: pointer; color: var(--text2); font-weight: 500; transition: all 0.15s; }
    .user-btn.active { border-color: var(--accent); color: var(--accent); background: var(--accent-bg); }

    .main { max-width: 800px; margin: 0 auto; padding: 20px 24px; }

    .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 20px; }
    .stat { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px; box-shadow: var(--shadow); }
    .stat-val { font-size: 24px; font-weight: 700; }
    .stat-label { font-size: 12px; color: var(--text2); margin-top: 2px; }
    .stat-new .stat-val { color: var(--accent); }

    .filters-panel { background: var(--bg); border: 1px solid var(--border); border-radius: 12px; padding: 16px; margin-bottom: 20px; box-shadow: var(--shadow); }
    .filters-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
    .filters-row:last-child { margin-bottom: 0; }
    .filter-label { font-size: 12px; font-weight: 600; color: var(--text2); text-transform: uppercase; letter-spacing: 0.5px; min-width: 70px; }
    .filter-btn { font-size: 12px; padding: 5px 12px; border-radius: 20px; border: 1px solid var(--border); background: var(--bg2); cursor: pointer; color: var(--text2); transition: all 0.15s; }
    .filter-btn.active { background: var(--text); color: white; border-color: var(--text); }
    .neighborhood-btn { font-size: 12px; padding: 4px 10px; border-radius: 20px; border: 1px solid var(--border); background: var(--bg2); cursor: pointer; color: var(--text2); transition: all 0.15s; }
    .neighborhood-btn.active { background: var(--accent); color: white; border-color: var(--accent); }
    .price-range { display: flex; align-items: center; gap: 10px; flex: 1; }
    .price-range input[type=range] { flex: 1; accent-color: var(--accent); }
    .price-range span { font-size: 13px; font-weight: 500; min-width: 60px; }
    .sort-select { font-size: 12px; padding: 5px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer; }

    .results-bar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
    .results-count { font-size: 13px; color: var(--text2); }
    .refresh-btn { font-size: 12px; padding: 5px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); cursor: pointer; color: var(--text2); }

    .banner { background: var(--amber-bg); border: 1px solid #fcd34d; border-radius: 10px; padding: 10px 14px; font-size: 13px; color: var(--amber); margin-bottom: 16px; }

    /* Card */
    .card { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; box-shadow: var(--shadow); margin-bottom: 16px; transition: box-shadow 0.2s; }
    .card:hover { box-shadow: 0 4px 16px rgba(0,0,0,0.1); }
    .card.is-new { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-bg), var(--shadow); }
    .card.status-sent { opacity: 0.55; }
    .card.status-skipped { opacity: 0.4; }

    .card-img { width: 100%; height: 200px; object-fit: cover; display: block; background: var(--bg3); }
    .card-img-placeholder { width: 100%; height: 120px; background: linear-gradient(135deg, #f0f0ee, #e4e4e2); display: flex; align-items: center; justify-content: center; color: var(--text3); font-size: 13px; }

    .card-body { padding: 16px; }
    .card-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 6px; }
    .card-title-link { font-size: 15px; font-weight: 600; color: var(--text); text-decoration: none; flex: 1; line-height: 1.3; }
    .card-title-link:hover { color: var(--accent); }
    .card-price { font-size: 17px; font-weight: 700; white-space: nowrap; }
    .card-price small { font-size: 12px; font-weight: 400; color: var(--text2); }

    .card-meta { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--text2); margin-bottom: 10px; flex-wrap: wrap; }
    .card-desc { font-size: 13px; color: var(--text2); line-height: 1.6; margin-bottom: 12px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }

    .score-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; padding: 10px 12px; background: var(--bg2); border-radius: 8px; }
    .score-num { font-size: 22px; font-weight: 800; min-width: 32px; }
    .score-high { color: var(--green); }
    .score-mid { color: var(--amber); }
    .score-low { color: var(--red); }
    .score-dots { display: flex; gap: 3px; }
    .score-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--bg3); }
    .score-dot.filled { background: var(--accent); }
    .score-reason { font-size: 12px; color: var(--text2); flex: 1; }

    .badges { display: flex; gap: 5px; flex-wrap: wrap; margin-bottom: 12px; }
    .badge { font-size: 11px; font-weight: 500; padding: 3px 8px; border-radius: 20px; }
    .badge-gray { background: var(--bg3); color: var(--text2); }
    .badge-green { background: var(--green-bg); color: var(--green); }
    .badge-blue { background: var(--accent-bg); color: var(--accent); }
    .badge-amber { background: var(--amber-bg); color: var(--amber); }
    .badge-purple { background: var(--purple-bg); color: var(--purple); }
    .badge-new { background: var(--accent); color: white; animation: pulse 2s infinite; }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.7; } }

    .amenities { display: flex; gap: 5px; flex-wrap: wrap; margin-bottom: 12px; }
    .amenity { font-size: 11px; padding: 3px 8px; border-radius: 6px; background: var(--bg2); color: var(--text2); border: 1px solid var(--border); }

    .map-link { font-size: 13px; color: var(--accent); text-decoration: none; display: inline-flex; align-items: center; gap: 4px; margin-bottom: 14px; }

    /* Drafts */
    .drafts { border-top: 1px solid var(--border); padding-top: 14px; margin-top: 4px; }
    .section-label { font-size: 11px; font-weight: 700; color: var(--text3); text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 10px; }
    .draft-tabs { display: flex; gap: 4px; margin-bottom: 10px; overflow-x: auto; }
    .draft-tab { font-size: 12px; padding: 5px 12px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg2); cursor: pointer; color: var(--text2); white-space: nowrap; }
    .draft-tab.active { background: var(--text); color: white; border-color: var(--text); }
    .draft-pane { display: none; }
    .draft-pane.active { display: block; }
    .draft-subject { font-size: 12px; color: var(--text2); margin-bottom: 6px; }
    .draft-box { position: relative; }
    .draft-ta { width: 100%; min-height: 80px; font-size: 13px; line-height: 1.6; resize: vertical; background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 44px 10px 12px; color: var(--text); font-family: inherit; }
    .copy-btn { position: absolute; top: 8px; right: 8px; font-size: 11px; padding: 3px 8px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; color: var(--text2); }

    /* Actions */
    .card-actions { border-top: 1px solid var(--border); padding: 12px 16px; display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    .action-btns { display: flex; gap: 6px; flex-wrap: wrap; }
    .action-btn { font-size: 12px; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--border); cursor: pointer; font-weight: 500; transition: all 0.15s; background: var(--bg2); color: var(--text2); }
    .action-btn:hover { filter: brightness(0.95); }
    .btn-contacted { background: var(--green-bg); color: var(--green); border-color: #bbf7d0; }
    .btn-reply { background: var(--purple-bg); color: var(--purple); border-color: #ddd6fe; }
    .btn-viewing { background: var(--accent-bg); color: var(--accent); border-color: #bfdbfe; }
    .btn-pass { background: var(--red-bg); color: var(--red); border-color: #fecaca; }
    .action-tags { display: flex; gap: 5px; flex-wrap: wrap; }
    .action-tag { font-size: 11px; padding: 3px 9px; border-radius: 20px; font-weight: 500; }
    .tag-contacted { background: var(--green-bg); color: var(--green); }
    .tag-reply { background: var(--purple-bg); color: var(--purple); }
    .tag-viewing { background: var(--accent-bg); color: var(--accent); }
    .tag-skipped { background: var(--bg3); color: var(--text2); }
    .tag-pass { background: var(--red-bg); color: var(--red); }

    /* Comments */
    .comments { border-top: 1px solid var(--border); padding: 14px 16px; }
    .comment { display: flex; gap: 8px; margin-bottom: 10px; }
    .comment-avatar { width: 28px; height: 28px; border-radius: 50%; background: var(--accent); color: white; font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .avatar-julian { background: #7c3aed; }
    .avatar-nora { background: #db2777; }
    .comment-bubble { background: var(--bg2); border-radius: 0 10px 10px 10px; padding: 8px 12px; flex: 1; }
    .comment-meta { font-size: 11px; color: var(--text3); margin-bottom: 3px; }
    .comment-body { font-size: 13px; color: var(--text); line-height: 1.5; }
    .comment-input-row { display: flex; gap: 8px; margin-top: 8px; }
    .comment-input { flex: 1; font-size: 13px; padding: 8px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); font-family: inherit; }
    .comment-send { font-size: 13px; padding: 8px 14px; border-radius: 8px; border: none; background: var(--accent); color: white; cursor: pointer; font-weight: 500; }

    @media (max-width: 600px) {
      .main { padding: 14px 16px; }
      .stats { grid-template-columns: repeat(2, 1fr); }
      .card-img { height: 160px; }
      .header-inner { gap: 8px; }
    }
  </style>
</head>
<body>

<div class="header">
  <div class="header-inner">
    <div class="header-left">
      <h1>🏙️ NYC Sublet Finder</h1>
      <p>Alex · Julian · Nora &nbsp;·&nbsp; Manhattan · June–August 2026</p>
    </div>
    <div class="user-select">
      <button class="user-btn" onclick="setUser('Alex',this)">Alex</button>
      <button class="user-btn" onclick="setUser('Julian',this)">Julian</button>
      <button class="user-btn" onclick="setUser('Nora',this)">Nora</button>
    </div>
  </div>
</div>

<div class="main">

  <div class="stats">
    <div class="stat stat-new"><div class="stat-val" id="s-new">${newListingIds.length}</div><div class="stat-label">New</div></div>
    <div class="stat"><div class="stat-val" id="s-total">${listings.length}</div><div class="stat-label">Total</div></div>
    <div class="stat"><div class="stat-val" id="s-pending">–</div><div class="stat-label">Pending</div></div>
    <div class="stat"><div class="stat-val" id="s-contacted">–</div><div class="stat-label">Contacted</div></div>
  </div>

  <div class="filters-panel">
    <div class="filters-row">
      <span class="filter-label">Status</span>
      <button class="filter-btn active" onclick="setFilter('all',this)">All</button>
      <button class="filter-btn" onclick="setFilter('new',this)">New ✨</button>
      <button class="filter-btn" onclick="setFilter('pending',this)">Pending</button>
      <button class="filter-btn" onclick="setFilter('contacted',this)">Contacted</button>
      <button class="filter-btn" onclick="setFilter('reply',this)">Got reply 💬</button>
      <button class="filter-btn" onclick="setFilter('viewing',this)">Viewing 📅</button>
      <button class="filter-btn" onclick="setFilter('skipped',this)">Skipped</button>
      <select class="sort-select" id="sort-select" onchange="sortCards()">
        <option value="newest">Newest first</option>
        <option value="score">Best score</option>
        <option value="price-low">Price: low to high</option>
        <option value="price-high">Price: high to low</option>
      </select>
    </div>
    <div class="filters-row">
      <span class="filter-label">Area</span>
      <button class="neighborhood-btn active" data-hood="all" onclick="toggleHood('all',this)">All Manhattan</button>
      <button class="neighborhood-btn" data-hood="upper east" onclick="toggleHood('upper east',this)">Upper East</button>
      <button class="neighborhood-btn" data-hood="upper west" onclick="toggleHood('upper west',this)">Upper West</button>
      <button class="neighborhood-btn" data-hood="midtown" onclick="toggleHood('midtown',this)">Midtown</button>
      <button class="neighborhood-btn" data-hood="village" onclick="toggleHood('village',this)">Village</button>
      <button class="neighborhood-btn" data-hood="soho" onclick="toggleHood('soho',this)">SoHo</button>
      <button class="neighborhood-btn" data-hood="tribeca" onclick="toggleHood('tribeca',this)">Tribeca</button>
      <button class="neighborhood-btn" data-hood="financial" onclick="toggleHood('financial',this)">FiDi</button>
    </div>
    <div class="filters-row">
      <span class="filter-label">Max price</span>
      <div class="price-range">
        <input type="range" id="price-slider" min="1000" max="${maxPrice}" value="${maxPrice}" step="100" oninput="updatePrice(this.value)">
        <span id="price-label">$${maxPrice.toLocaleString()}/mo</span>
      </div>
    </div>
  </div>

  ${DRY_RUN ? `<div class="banner">⚠️ Dry run mode — auto-send is off. Set <strong>DRY_RUN=false</strong> in Railway variables to go live.</div>` : ""}

  <div class="results-bar">
    <span class="results-count" id="results-count">${listings.length} listings</span>
    <button class="refresh-btn" onclick="location.reload()">↻ Refresh</button>
  </div>

  <div id="cards-container">
  ${listings.map(l => {
    const listingActions = actionMap[l.id] || [];
    const listingComments = commentMap[l.id] || [];
    const isNew = newListingIds.includes(l.id);
    const contactedAction = listingActions.find(a => a.action === "contacted");
    const replyAction = listingActions.find(a => a.action === "reply");
    const viewingAction = listingActions.find(a => a.action === "viewing");
    const skippedAction = listingActions.find(a => a.action === "skipped");
    const passAction = listingActions.find(a => a.action === "pass");
    const status = replyAction ? "reply" : viewingAction ? "viewing" : contactedAction ? "contacted" : skippedAction || passAction ? "skipped" : "pending";
    const priceNum = (l.price || "").replace(/,/g, "").match(/\d+/);
    const price = priceNum ? parseInt(priceNum[0]) : 0;
    const loc = (l.location || "").toLowerCase();
    const scoreClass = (l.score || 0) >= 7 ? "score-high" : (l.score || 0) >= 5 ? "score-mid" : "score-low";
    const mapUrl = `https://maps.google.com?q=${encodeURIComponent((l.address?.street || l.location || "Manhattan") + " New York NY")}`;
    const avatarClass = n => n === "Julian" ? "avatar-julian" : n === "Nora" ? "avatar-nora" : "";
    const timeAgo = t => { const s = Math.floor((Date.now() - new Date(t)) / 1000); if (s < 60) return "just now"; if (s < 3600) return Math.floor(s/60)+"m ago"; if (s < 86400) return Math.floor(s/3600)+"h ago"; return Math.floor(s/86400)+"d ago"; };

    return `
<div class="card ${isNew ? "is-new" : ""} status-${status}"
  data-id="${l.id}"
  data-status="${status}"
  data-isnew="${isNew}"
  data-price="${price}"
  data-score="${l.score || 0}"
  data-loc="${loc}"
  data-datetime="${l.datetime || ""}">

  ${l.pics?.[0] ? `<img class="card-img" src="${l.pics[0]}" loading="lazy" alt="${l.title}" onerror="this.parentNode.replaceChild(Object.assign(document.createElement('div'),{className:'card-img-placeholder',textContent:'No photo'}),this)">` : `<div class="card-img-placeholder">No photo available</div>`}

  <div class="card-body">
    <div class="card-header">
      <a class="card-title-link" href="${l.url}" target="_blank">${l.title || "Untitled listing"}</a>
      ${l.price ? `<div class="card-price">${l.price}<small>/mo</small></div>` : ""}
    </div>
    <div class="card-meta">
      <span>📍 ${l.location || "Manhattan"}</span>
      ${l.bedrooms ? `<span>🛏 ${l.bedrooms}BR</span>` : ""}
      ${l.bathrooms ? `<span>🚿 ${l.bathrooms} bath</span>` : ""}
      ${l.space ? `<span>📐 ${l.space}</span>` : ""}
    </div>
    ${l.post ? `<div class="card-desc">${l.post.slice(0, 280).replace(/</g,"&lt;")}</div>` : ""}

    ${l.score ? `
    <div class="score-bar">
      <div class="score-num ${scoreClass}">${l.score}</div>
      <div class="score-dots">${Array.from({length:10},(_,i)=>`<div class="score-dot ${i<l.score?"filled":""}"></div>`).join("")}</div>
      <div class="score-reason">${l.scoreReason || ""}</div>
    </div>` : ""}

    <div class="badges">
      ${isNew ? `<span class="badge badge-new">✨ New</span>` : ""}
      ${l.availableFrom ? `<span class="badge badge-green">${l.availableFrom}</span>` : ""}
      ${l.bedrooms ? `<span class="badge badge-blue">${l.bedrooms}BR</span>` : ""}
      <span class="badge badge-gray">${l.platform || "Craigslist"}</span>
      ${l.smsSent ? `<span class="badge badge-green">SMS sent ✓</span>` : ""}
      ${l.needsManualSend ? `<span class="badge badge-amber">Manual send</span>` : ""}
    </div>

    ${l.amenities?.length ? `<div class="amenities">${l.amenities.slice(0,8).map(a=>`<span class="amenity">${a}</span>`).join("")}</div>` : ""}

    <a class="map-link" href="${mapUrl}" target="_blank">🗺 View on map</a>

    ${l.drafts ? `
    <div class="drafts">
      <div class="section-label">Message drafts</div>
      <div class="draft-tabs">
        <button class="draft-tab active" onclick="showDraft('${l.id}','inApp',this)">In-app</button>
        <button class="draft-tab" onclick="showDraft('${l.id}','email',this)">Email</button>
        <button class="draft-tab" onclick="showDraft('${l.id}','sms',this)">SMS</button>
        <button class="draft-tab" onclick="showDraft('${l.id}','whatsapp',this)">WhatsApp</button>
      </div>
      <div id="${l.id}-inApp" class="draft-pane active"><div class="draft-box"><textarea class="draft-ta">${(l.drafts.inApp||"").replace(/</g,"&lt;")}</textarea><button class="copy-btn" onclick="copyDraft(this)">Copy</button></div></div>
      <div id="${l.id}-email" class="draft-pane"><div class="draft-subject"><strong>Subject:</strong> ${(l.drafts.email?.subject||"").replace(/</g,"&lt;")}</div><div class="draft-box"><textarea class="draft-ta">${(l.drafts.email?.body||"").replace(/</g,"&lt;")}</textarea><button class="copy-btn" onclick="copyDraft(this)">Copy</button></div></div>
      <div id="${l.id}-sms" class="draft-pane"><div class="draft-box"><textarea class="draft-ta">${(l.drafts.sms||"").replace(/</g,"&lt;")}</textarea><button class="copy-btn" onclick="copyDraft(this)">Copy</button></div></div>
      <div id="${l.id}-whatsapp" class="draft-pane"><div class="draft-box"><textarea class="draft-ta">${(l.drafts.whatsapp||"").replace(/</g,"&lt;")}</textarea><button class="copy-btn" onclick="copyDraft(this)">Copy</button></div></div>
    </div>` : ""}
  </div>

  <div class="card-actions">
    <div class="action-btns">
      ${!contactedAction ? `<button class="action-btn btn-contacted" onclick="doAction('${l.id}','contacted',this)">✓ Contacted</button>` : ""}
      ${contactedAction && !replyAction ? `<button class="action-btn btn-reply" onclick="doAction('${l.id}','reply',this)">💬 Got reply</button>` : ""}
      ${(contactedAction || replyAction) && !viewingAction ? `<button class="action-btn btn-viewing" onclick="doAction('${l.id}','viewing',this)">📅 Viewing scheduled</button>` : ""}
      ${!skippedAction && !passAction ? `<button class="action-btn btn-pass" onclick="doAction('${l.id}','pass',this)">✕ Pass</button>` : ""}
    </div>
    <div class="action-tags">
      ${listingActions.map(a => `<span class="action-tag tag-${a.action}">${a.action==="contacted"?"✓ ":a.action==="reply"?"💬 ":a.action==="viewing"?"📅 ":""}${a.user_name} ${a.action==="contacted"?"contacted":a.action==="reply"?"replied":a.action==="viewing"?"viewing":a.action==="pass"?"passed":"skipped"}</span>`).join("")}
    </div>
  </div>

  <div class="comments">
    <div class="section-label">Notes</div>
    ${listingComments.map(c => `
    <div class="comment">
      <div class="comment-avatar ${avatarClass(c.user_name)}">${c.user_name[0]}</div>
      <div class="comment-bubble">
        <div class="comment-meta">${c.user_name} · ${timeAgo(c.created_at)}</div>
        <div class="comment-body">${c.body.replace(/</g,"&lt;")}</div>
      </div>
    </div>`).join("")}
    <div class="comment-input-row">
      <input class="comment-input" id="ci-${l.id}" placeholder="Add a note..." onkeydown="if(event.key==='Enter')sendComment('${l.id}')">
      <button class="comment-send" onclick="sendComment('${l.id}')">Send</button>
    </div>
  </div>
</div>`;
  }).join("")}
  </div>
</div>

<script>
// User
let currentUser = localStorage.getItem("sublet_user");
if (currentUser) document.querySelectorAll(".user-btn").forEach(b => { if(b.textContent===currentUser) b.classList.add("active"); });

function setUser(name, btn) {
  currentUser = name;
  localStorage.setItem("sublet_user", name);
  document.querySelectorAll(".user-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
}

// Mark seen
const newIds = ${JSON.stringify(newListingIds)};
if (newIds.length > 0) {
  setTimeout(() => {
    const user = localStorage.getItem("sublet_user") || "unknown";
    fetch("/seen", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ listingIds: newIds, userName: user }) });
  }, 3000);
}

// Filters
let activeFilter = "all";
let activeHood = "all";
let maxPriceFilter = ${maxPrice};

function setFilter(f, btn) {
  activeFilter = f;
  document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  applyFilters();
}

function toggleHood(hood, btn) {
  activeHood = hood;
  document.querySelectorAll(".neighborhood-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  applyFilters();
}

function updatePrice(val) {
  maxPriceFilter = parseInt(val);
  document.getElementById("price-label").textContent = "$" + parseInt(val).toLocaleString() + "/mo";
  applyFilters();
}

function applyFilters() {
  let visible = 0;
  document.querySelectorAll(".card").forEach(card => {
    const status = card.dataset.status;
    const isNew = card.dataset.isnew === "true";
    const price = parseInt(card.dataset.price) || 0;
    const loc = card.dataset.loc || "";

    const statusOk = activeFilter === "all" || (activeFilter === "new" && isNew) || status === activeFilter;
    const hoodOk = activeHood === "all" || loc.includes(activeHood);
    const priceOk = price === 0 || price <= maxPriceFilter;

    const show = statusOk && hoodOk && priceOk;
    card.style.display = show ? "block" : "none";
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
    if (sort === "score") return (parseInt(b.dataset.score)||0) - (parseInt(a.dataset.score)||0);
    if (sort === "price-low") return (parseInt(a.dataset.price)||0) - (parseInt(b.dataset.price)||0);
    if (sort === "price-high") return (parseInt(b.dataset.price)||0) - (parseInt(a.dataset.price)||0);
    return new Date(b.dataset.datetime) - new Date(a.dataset.datetime);
  });
  cards.forEach(c => container.appendChild(c));
}

function updateStats() {
  const cards = document.querySelectorAll(".card");
  let pending = 0, contacted = 0;
  cards.forEach(c => {
    if (c.dataset.status === "pending") pending++;
    if (["contacted","reply","viewing"].includes(c.dataset.status)) contacted++;
  });
  document.getElementById("s-pending").textContent = pending;
  document.getElementById("s-contacted").textContent = contacted;
}

// Actions
async function doAction(listingId, action, btn) {
  if (!currentUser) { alert("Select your name at the top first (Alex, Julian, or Nora)."); return; }
  btn.disabled = true;
  await fetch("/action", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ listingId, userName: currentUser, action }) });
  location.reload();
}

// Drafts
function showDraft(id, tab, btn) {
  document.querySelectorAll('[id^="'+id+'-"]').forEach(el => el.classList.remove("active"));
  document.getElementById(id+"-"+tab).classList.add("active");
  btn.closest(".draft-tabs").querySelectorAll(".draft-tab").forEach(t => t.classList.remove("active"));
  btn.classList.add("active");
}

function copyDraft(btn) {
  navigator.clipboard.writeText(btn.previousElementSibling.value).then(() => {
    btn.textContent = "Copied!";
    setTimeout(() => btn.textContent = "Copy", 1500);
  });
}

// Comments
async function sendComment(listingId) {
  if (!currentUser) { alert("Select your name at the top first."); return; }
  const input = document.getElementById("ci-" + listingId);
  const body = input.value.trim();
  if (!body) return;
  input.value = "";
  await fetch("/comment", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ listingId, userName: currentUser, body }) });
  location.reload();
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
