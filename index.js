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
  await db.query(
    "INSERT INTO actions (listing_id, user_name, action) VALUES ($1, $2, $3)",
    [listingId, userName, action]
  );
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

async function generateDraft(listing) {
  const system = `You draft sublet outreach messages for three HBS students: Alex, Julian, and Nora (from Germany and Austria). They need a 2-3 bedroom apartment in Manhattan (south of 105th St) from June to August 2026 for internships. Sign as Alex. Keep messages warm, genuine, and brief. Mention HBS and the summer internship. Always ask if it's still available and mention June–August dates. Return ONLY valid JSON, no markdown: {"inApp":"...","email":{"subject":"...","body":"..."},"sms":"...","whatsapp":"..."}`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514", max_tokens: 1000, system,
      messages: [{ role: "user", content: `Title: ${listing.title}\nPrice: ${listing.price}\nLocation: ${listing.location}\n\nDraft all 4 message types.` }]
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
      try { listing.drafts = await generateDraft(listing); } catch (e) { console.error(`Draft failed:`, e.message); }
      if (listing.phoneNumbers?.length > 0 && listing.drafts) {
        const phone = listing.phoneNumbers[0];
        const result = await sendSms(phone, listing.drafts.sms);
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
app.get("/listings", async (req, res) => { res.header("Access-Control-Allow-Origin", "*"); res.json(await loadListings()); });
app.get("/refresh", async (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  try { const count = await fetchAndProcess(); res.json({ success: true, newListings: count, dryRun: DRY_RUN }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/action", async (req, res) => {
  const { listingId, userName, action } = req.body;
  if (!listingId || !userName || !action) return res.status(400).json({ error: "Missing fields" });
  await saveAction(listingId, userName, action);
  res.json({ success: true });
});
app.get("/actions", async (req, res) => { res.json(await loadActions()); });

// Serve frontend
app.get("/", async (req, res) => {
  const listings = await loadListings();
  const actions = await loadActions();
  const actionMap = {};
  actions.forEach(a => { if (!actionMap[a.listing_id]) actionMap[a.listing_id] = []; actionMap[a.listing_id].push(a); });

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NYC Sublet Finder</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #ffffff;
      --bg2: #f7f7f5;
      --bg3: #efefed;
      --border: #e8e8e6;
      --text: #111111;
      --text2: #666666;
      --text3: #999999;
      --accent: #2563eb;
      --accent-bg: #eff6ff;
      --green: #16a34a;
      --green-bg: #f0fdf4;
      --amber: #d97706;
      --amber-bg: #fffbeb;
      --red: #dc2626;
      --red-bg: #fef2f2;
      --radius: 12px;
      --shadow: 0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04);
    }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg2); color: var(--text); min-height: 100vh; }

    /* Header */
    .header { background: var(--bg); border-bottom: 1px solid var(--border); padding: 16px 24px; position: sticky; top: 0; z-index: 100; }
    .header-inner { max-width: 760px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .header-left h1 { font-size: 18px; font-weight: 600; letter-spacing: -0.3px; }
    .header-left p { font-size: 13px; color: var(--text2); margin-top: 2px; }
    .header-right { display: flex; align-items: center; gap: 8px; }
    .user-select { display: flex; gap: 6px; }
    .user-btn { font-size: 13px; padding: 6px 12px; border-radius: 20px; border: 1px solid var(--border); background: var(--bg); cursor: pointer; color: var(--text2); transition: all 0.15s; font-weight: 500; }
    .user-btn.active { background: var(--accent); color: white; border-color: var(--accent); }
    .refresh-btn { font-size: 13px; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); cursor: pointer; color: var(--text2); }

    /* Stats bar */
    .stats { max-width: 760px; margin: 0 auto; padding: 16px 24px 0; display: flex; gap: 10px; }
    .stat { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 10px 16px; flex: 1; box-shadow: var(--shadow); }
    .stat-val { font-size: 22px; font-weight: 600; }
    .stat-label { font-size: 12px; color: var(--text2); margin-top: 2px; }

    /* Filters */
    .filters { max-width: 760px; margin: 0 auto; padding: 14px 24px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .filter-btn { font-size: 13px; padding: 5px 14px; border-radius: 20px; border: 1px solid var(--border); background: var(--bg); cursor: pointer; color: var(--text2); transition: all 0.15s; }
    .filter-btn.active { background: var(--text); color: white; border-color: var(--text); }
    .filter-count { font-size: 11px; opacity: 0.7; margin-left: 3px; }

    /* Dry run banner */
    .banner { max-width: 760px; margin: 0 auto; padding: 0 24px 14px; }
    .banner-inner { background: var(--amber-bg); border: 1px solid #fcd34d; border-radius: 10px; padding: 10px 14px; font-size: 13px; color: var(--amber); }

    /* Cards */
    .cards { max-width: 760px; margin: 0 auto; padding: 0 24px 40px; display: flex; flex-direction: column; gap: 14px; }
    .card { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; box-shadow: var(--shadow); transition: box-shadow 0.2s; }
    .card:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
    .card.sent { opacity: 0.5; }

    /* Card photo */
    .card-photo { width: 100%; height: 200px; object-fit: cover; background: var(--bg3); display: block; }
    .card-photo-placeholder { width: 100%; height: 140px; background: linear-gradient(135deg, #f0f0ee 0%, #e8e8e6 100%); display: flex; align-items: center; justify-content: center; color: var(--text3); font-size: 13px; }

    /* Card body */
    .card-body { padding: 16px; }
    .card-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 6px; }
    .card-title { font-size: 15px; font-weight: 600; color: var(--text); text-decoration: none; line-height: 1.3; flex: 1; }
    .card-title:hover { color: var(--accent); }
    .card-price { font-size: 16px; font-weight: 700; white-space: nowrap; color: var(--text); }
    .card-price span { font-size: 12px; font-weight: 400; color: var(--text2); }
    .card-location { font-size: 13px; color: var(--text2); margin-bottom: 10px; display: flex; align-items: center; gap: 4px; }
    .card-desc { font-size: 13px; color: var(--text2); line-height: 1.6; margin-bottom: 12px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }

    /* Badges */
    .badges { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; }
    .badge { font-size: 11px; font-weight: 500; padding: 3px 8px; border-radius: 20px; }
    .badge-gray { background: var(--bg3); color: var(--text2); }
    .badge-green { background: var(--green-bg); color: var(--green); }
    .badge-blue { background: var(--accent-bg); color: var(--accent); }
    .badge-amber { background: var(--amber-bg); color: var(--amber); }
    .badge-red { background: var(--red-bg); color: var(--red); }

    /* Amenities */
    .amenities { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; }
    .amenity { font-size: 11px; padding: 3px 8px; border-radius: 6px; background: var(--bg2); color: var(--text2); border: 1px solid var(--border); }

    /* Map link */
    .map-link { font-size: 13px; color: var(--accent); text-decoration: none; display: inline-flex; align-items: center; gap: 4px; margin-bottom: 14px; }
    .map-link:hover { text-decoration: underline; }

    /* Drafts */
    .drafts-section { border-top: 1px solid var(--border); padding-top: 14px; }
    .drafts-label { font-size: 12px; font-weight: 600; color: var(--text2); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 10px; }
    .draft-tabs { display: flex; gap: 4px; margin-bottom: 10px; overflow-x: auto; padding-bottom: 2px; }
    .draft-tab { font-size: 12px; padding: 5px 12px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); cursor: pointer; color: var(--text2); white-space: nowrap; transition: all 0.15s; }
    .draft-tab.active { background: var(--text); color: white; border-color: var(--text); }
    .draft-content { display: none; }
    .draft-content.active { display: block; }
    .draft-box { position: relative; }
    .draft-textarea { width: 100%; min-height: 85px; font-size: 13px; line-height: 1.6; resize: vertical; background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 44px 10px 12px; color: var(--text); font-family: inherit; }
    .draft-subject { font-size: 12px; color: var(--text2); margin-bottom: 6px; }
    .copy-btn { position: absolute; top: 8px; right: 8px; font-size: 11px; padding: 3px 8px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; color: var(--text2); }

    /* Actions */
    .actions-section { border-top: 1px solid var(--border); padding: 12px 16px; display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    .action-btns { display: flex; gap: 8px; flex-wrap: wrap; }
    .action-btn { font-size: 13px; padding: 7px 14px; border-radius: 8px; border: 1px solid var(--border); cursor: pointer; font-weight: 500; transition: all 0.15s; }
    .action-btn-sent { background: var(--green-bg); color: var(--green); border-color: #bbf7d0; }
    .action-btn-skip { background: var(--bg2); color: var(--text2); }
    .action-btn:hover { filter: brightness(0.95); }
    .action-status { font-size: 13px; color: var(--text2); }
    .action-log { display: flex; gap: 6px; flex-wrap: wrap; }
    .action-tag { font-size: 12px; padding: 3px 10px; border-radius: 20px; background: var(--green-bg); color: var(--green); font-weight: 500; }
    .action-tag-skip { background: var(--bg3); color: var(--text2); }

    /* Empty state */
    .empty { text-align: center; padding: 60px 20px; color: var(--text2); }
    .empty h3 { font-size: 18px; margin-bottom: 8px; color: var(--text); }

    @media (max-width: 600px) {
      .header-inner { flex-direction: column; align-items: flex-start; }
      .stats { gap: 8px; }
      .stat-val { font-size: 18px; }
      .cards, .filters, .stats, .banner { padding-left: 16px; padding-right: 16px; }
      .card-photo { height: 160px; }
    }
  </style>
</head>
<body>

<div class="header">
  <div class="header-inner">
    <div class="header-left">
      <h1>NYC Sublet Finder 🏙️</h1>
      <p>Alex · Julian · Nora &nbsp;·&nbsp; Manhattan · June–August 2026</p>
    </div>
    <div class="header-right">
      <div class="user-select">
        <button class="user-btn" onclick="setUser('Alex',this)">Alex</button>
        <button class="user-btn" onclick="setUser('Julian',this)">Julian</button>
        <button class="user-btn" onclick="setUser('Nora',this)">Nora</button>
      </div>
    </div>
  </div>
</div>

<div class="stats">
  <div class="stat"><div class="stat-val" id="stat-total">${listings.length}</div><div class="stat-label">Total listings</div></div>
  <div class="stat"><div class="stat-val" id="stat-pending">-</div><div class="stat-label">Pending</div></div>
  <div class="stat"><div class="stat-val" id="stat-sent">-</div><div class="stat-label">Contacted</div></div>
</div>

<div class="filters">
  <button class="filter-btn active" onclick="setFilter('all',this)">All <span class="filter-count">${listings.length}</span></button>
  <button class="filter-btn" onclick="setFilter('pending',this)">Pending</button>
  <button class="filter-btn" onclick="setFilter('sent',this)">Contacted</button>
  <button class="filter-btn" onclick="setFilter('skipped',this)">Skipped</button>
  <button class="refresh-btn" onclick="location.reload()" style="margin-left:auto">↻ Refresh</button>
</div>

${DRY_RUN ? `<div class="banner"><div class="banner-inner">⚠️ Dry run mode — messages are not being sent automatically. Set <strong>DRY_RUN=false</strong> in Railway to go live.</div></div>` : ""}

<div class="cards" id="cards-container">
${listings.length === 0 ? `<div class="empty"><h3>No listings yet</h3><p>The agent checks every 30 minutes. Check back soon.</p></div>` :
listings.map(l => {
  const listingActions = actionMap[l.id] || [];
  const sentAction = listingActions.find(a => a.action === "sent");
  const skippedAction = listingActions.find(a => a.action === "skipped");
  const mapUrl = l.address?.postalCode ? `https://maps.google.com?q=${encodeURIComponent((l.address?.street || "") + " " + (l.address?.city || "New York") + " NY")}` : null;

  return `
<div class="card ${sentAction ? "sent" : ""}" id="card-${l.id}" data-status="${sentAction ? "sent" : skippedAction ? "skipped" : "pending"}">
  ${l.pics?.[0] ? `<img class="card-photo" src="${l.pics[0]}" alt="${l.title}" loading="lazy" onerror="this.style.display='none'">` : `<div class="card-photo-placeholder">No photo available</div>`}
  <div class="card-body">
    <div class="card-top">
      <a class="card-title" href="${l.url}" target="_blank">${l.title || "Untitled listing"}</a>
      ${l.price ? `<div class="card-price">${l.price}<span>/mo</span></div>` : ""}
    </div>
    <div class="card-location">📍 ${l.location || "Manhattan, NY"}</div>
    ${l.post ? `<div class="card-desc">${l.post.slice(0, 300)}</div>` : ""}

    <div class="badges">
      ${l.bedrooms ? `<span class="badge badge-blue">${l.bedrooms}BR</span>` : ""}
      ${l.bathrooms ? `<span class="badge badge-gray">${l.bathrooms} bath</span>` : ""}
      ${l.space ? `<span class="badge badge-gray">${l.space}</span>` : ""}
      ${l.availableFrom ? `<span class="badge badge-green">${l.availableFrom}</span>` : ""}
      <span class="badge badge-gray">${l.platform || "Craigslist"}</span>
      ${l.smsSent ? `<span class="badge badge-green">SMS sent ✓</span>` : ""}
      ${l.smsDryRun ? `<span class="badge badge-amber">SMS (dry run)</span>` : ""}
      ${l.needsManualSend ? `<span class="badge badge-amber">Manual send needed</span>` : ""}
    </div>

    ${l.amenities?.length ? `<div class="amenities">${l.amenities.slice(0, 8).map(a => `<span class="amenity">${a}</span>`).join("")}</div>` : ""}

    ${mapUrl ? `<a class="map-link" href="${mapUrl}" target="_blank">🗺 View on map</a>` : ""}

    ${l.drafts ? `
    <div class="drafts-section">
      <div class="drafts-label">Message drafts</div>
      <div class="draft-tabs">
        <button class="draft-tab active" onclick="showDraft('${l.id}','inApp',this)">In-app</button>
        <button class="draft-tab" onclick="showDraft('${l.id}','email',this)">Email</button>
        <button class="draft-tab" onclick="showDraft('${l.id}','sms',this)">SMS</button>
        <button class="draft-tab" onclick="showDraft('${l.id}','whatsapp',this)">WhatsApp</button>
      </div>
      <div id="${l.id}-inApp" class="draft-content active">
        <div class="draft-box"><textarea class="draft-textarea">${(l.drafts.inApp || "").replace(/</g,"&lt;")}</textarea><button class="copy-btn" onclick="copyDraft(this)">Copy</button></div>
      </div>
      <div id="${l.id}-email" class="draft-content">
        <div class="draft-subject"><strong>Subject:</strong> ${(l.drafts.email?.subject || "").replace(/</g,"&lt;")}</div>
        <div class="draft-box"><textarea class="draft-textarea">${(l.drafts.email?.body || "").replace(/</g,"&lt;")}</textarea><button class="copy-btn" onclick="copyDraft(this)">Copy</button></div>
      </div>
      <div id="${l.id}-sms" class="draft-content">
        <div class="draft-box"><textarea class="draft-textarea">${(l.drafts.sms || "").replace(/</g,"&lt;")}</textarea><button class="copy-btn" onclick="copyDraft(this)">Copy</button></div>
      </div>
      <div id="${l.id}-whatsapp" class="draft-content">
        <div class="draft-box"><textarea class="draft-textarea">${(l.drafts.whatsapp || "").replace(/</g,"&lt;")}</textarea><button class="copy-btn" onclick="copyDraft(this)">Copy</button></div>
      </div>
    </div>` : `<div class="drafts-section"><p style="font-size:13px;color:var(--text2)">Drafts generating in background...</p></div>`}
  </div>

  <div class="actions-section">
    <div class="action-btns">
      ${!sentAction && !skippedAction ? `
        <button class="action-btn action-btn-sent" onclick="markAction('${l.id}','sent',this)">✓ Mark as contacted</button>
        <button class="action-btn action-btn-skip" onclick="markAction('${l.id}','skipped',this)">Skip</button>
      ` : ""}
    </div>
    <div class="action-log">
      ${listingActions.map(a => `<span class="action-tag ${a.action === "skipped" ? "action-tag-skip" : ""}">${a.action === "sent" ? "✓ " : ""}${a.user_name} ${a.action === "sent" ? "contacted" : "skipped"}</span>`).join("")}
    </div>
  </div>
</div>`;
}).join("")}
</div>

<script>
let currentUser = localStorage.getItem("sublet_user") || null;
if (currentUser) {
  document.querySelectorAll(".user-btn").forEach(b => { if (b.textContent === currentUser) b.classList.add("active"); });
}

function setUser(name, btn) {
  currentUser = name;
  localStorage.setItem("sublet_user", name);
  document.querySelectorAll(".user-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
}

function showDraft(id, tab, btn) {
  document.querySelectorAll('[id^="'+id+'-"]').forEach(el => el.classList.remove("active"));
  document.getElementById(id+"-"+tab).classList.add("active");
  btn.closest(".draft-tabs").querySelectorAll(".draft-tab").forEach(t => t.classList.remove("active"));
  btn.classList.add("active");
}

function copyDraft(btn) {
  const ta = btn.previousElementSibling;
  navigator.clipboard.writeText(ta.value).then(() => {
    btn.textContent = "Copied!";
    setTimeout(() => btn.textContent = "Copy", 1500);
  });
}

async function markAction(listingId, action, btn) {
  if (!currentUser) { alert("Please select your name (Alex, Julian, or Nora) at the top first."); return; }
  await fetch("/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ listingId, userName: currentUser, action })
  });
  location.reload();
}

function setFilter(f, btn) {
  document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  document.querySelectorAll(".card").forEach(card => {
    const status = card.dataset.status;
    card.style.display = (f === "all" || status === f) ? "block" : "none";
  });
  updateStats();
}

function updateStats() {
  const cards = document.querySelectorAll(".card");
  let pending = 0, sent = 0;
  cards.forEach(c => { if (c.dataset.status === "pending") pending++; if (c.dataset.status === "sent") sent++; });
  document.getElementById("stat-pending").textContent = pending;
  document.getElementById("stat-sent").textContent = sent;
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
