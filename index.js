const express = require("express");
const app = express();
app.use(express.json());

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const TWILIO_SID = process.env.TWILIO_SID;
const TWILIO_TOKEN = process.env.TWILIO_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM;
const ALERT_PHONE = process.env.ALERT_PHONE;
const DATABASE_URL = process.env.DATABASE_URL;
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
    )
  `);
  console.log("Database ready");
}

async function loadListings() {
  if (!db) return [];
  try {
    const res = await db.query("SELECT data FROM listings ORDER BY created_at DESC LIMIT 200");
    return res.rows.map(r => r.data);
  } catch (e) {
    console.error("Failed to load listings:", e.message);
    return [];
  }
}

async function saveListing(listing) {
  if (!db) return;
  try {
    await db.query(
      "INSERT INTO listings (id, data) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
      [listing.id, JSON.stringify(listing)]
    );
  } catch (e) {
    console.error("Failed to save listing:", e.message);
  }
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

async function sendSmsAlert(count) {
  if (!TWILIO_SID || !ALERT_PHONE) return;
  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64") },
    body: new URLSearchParams({ To: ALERT_PHONE, From: TWILIO_FROM, Body: `${count} new NYC sublet${count > 1 ? "s" : ""} found. Review at: https://sublet-agent-production.up.railway.app` }).toString(),
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
    console.log(`${newListings.length} new listings`);
    for (const listing of newListings) {
      try { listing.drafts = await generateDraft(listing); } catch (e) { console.error(`Draft failed:`, e.message); }
      await saveListing(listing);
    }
    if (newListings.length > 0) await sendSmsAlert(newListings.length);
    return newListings.length;
  } finally { isFetching = false; }
}

// Serve the review app
app.get("/app", async (req, res) => {
  const listings = await loadListings();
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NYC Sublet Review</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f9f9f7; color: #1a1a1a; padding: 1.5rem 1rem; }
    .container { max-width: 680px; margin: 0 auto; }
    h1 { font-size: 22px; font-weight: 500; margin-bottom: 4px; }
    .subtitle { font-size: 14px; color: #666; margin-bottom: 1.5rem; }
    .card { background: white; border: 0.5px solid #e0e0e0; border-radius: 12px; padding: 1rem 1.25rem; margin-bottom: 14px; }
    .card-title { font-weight: 500; font-size: 15px; text-decoration: none; color: #1a1a1a; display: block; margin-bottom: 4px; }
    .card-location { font-size: 13px; color: #666; margin-bottom: 8px; }
    .badges { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
    .badge { font-size: 12px; font-weight: 500; padding: 3px 8px; border-radius: 6px; background: #f1efe8; color: #5f5e5a; }
    .tabs { display: flex; gap: 4px; border-bottom: 0.5px solid #e0e0e0; padding-bottom: 8px; margin-bottom: 10px; }
    .tab { font-size: 12px; padding: 4px 10px; border-radius: 6px; border: none; background: transparent; cursor: pointer; color: #666; }
    .tab.active { background: #f1efe8; color: #1a1a1a; font-weight: 500; }
    textarea { width: 100%; min-height: 90px; font-size: 13px; line-height: 1.6; resize: vertical; background: #f9f9f7; border: 0.5px solid #e0e0e0; border-radius: 8px; padding: 10px 12px; color: #1a1a1a; font-family: inherit; }
    .btn { font-size: 13px; padding: 6px 16px; border-radius: 8px; border: 0.5px solid #e0e0e0; cursor: pointer; background: #f1efe8; color: #1a1a1a; margin-top: 10px; margin-right: 8px; }
    .btn-send { background: #e6f1fb; color: #185fa5; }
    .btn-sent { background: #eaf3de; color: #3b6d11; }
    .draft-area { display: none; }
    .draft-area.active { display: block; }
  </style>
</head>
<body>
<div class="container">
  <h1>NYC sublet review</h1>
  <p class="subtitle">Manhattan · 2–3BR · June–August · ${listings.length} listings</p>
  ${listings.map(l => `
  <div class="card" id="card-${l.id}">
    <a class="card-title" href="${l.url}" target="_blank">${l.title}</a>
    <div class="card-location">${l.location} ${l.price ? `· ${l.price}/mo` : ""}</div>
    <div class="badges">
      <span class="badge">2BR</span>
      <span class="badge">Craigslist</span>
    </div>
    ${l.drafts ? `
    <div class="tabs">
      <button class="tab active" onclick="showTab('${l.id}','inApp',this)">In-app</button>
      <button class="tab" onclick="showTab('${l.id}','email',this)">Email</button>
      <button class="tab" onclick="showTab('${l.id}','sms',this)">SMS</button>
      <button class="tab" onclick="showTab('${l.id}','whatsapp',this)">WhatsApp</button>
    </div>
    <div id="${l.id}-inApp" class="draft-area active"><textarea>${l.drafts.inApp || ""}</textarea></div>
    <div id="${l.id}-email" class="draft-area"><textarea>Subject: ${l.drafts.email?.subject || ""}\n\n${l.drafts.email?.body || ""}</textarea></div>
    <div id="${l.id}-sms" class="draft-area"><textarea>${l.drafts.sms || ""}</textarea></div>
    <div id="${l.id}-whatsapp" class="draft-area"><textarea>${l.drafts.whatsapp || ""}</textarea></div>
    <button class="btn btn-sent" onclick="markSent('${l.id}')">Mark as sent</button>
    <button class="btn" onclick="markSkipped('${l.id}')">Skip</button>
    ` : `<p style="font-size:13px;color:#666">Drafts generating in background...</p>`}
  </div>`).join("")}
</div>
<script>
function showTab(id, tab, btn) {
  document.querySelectorAll('[id^="'+id+'-"]').forEach(el => el.classList.remove('active'));
  document.getElementById(id+'-'+tab).classList.add('active');
  btn.closest('.tabs').querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
}
function markSent(id) {
  const card = document.getElementById('card-'+id);
  card.style.opacity = '0.4';
  card.querySelector('.btn-sent').textContent = 'Sent ✓';
}
function markSkipped(id) {
  document.getElementById('card-'+id).style.opacity = '0.4';
}
</script>
</body>
</html>`);
});

app.get("/", (req, res) => res.redirect("/app"));
app.get("/listings", async (req, res) => { res.header("Access-Control-Allow-Origin", "*"); res.json(await loadListings()); });
app.get("/refresh", async (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  try { const count = await fetchAndProcess(); res.json({ success: true, newListings: count }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/refresh", async (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  try { const count = await fetchAndProcess(); res.json({ success: true, newListings: count }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, async () => {
  console.log(`Sublet agent running on port ${PORT}`);
  await initDb();
  fetchAndProcess().catch(console.error);
  setInterval(() => fetchAndProcess().catch(console.error), 30 * 60 * 1000);
});
