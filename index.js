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
      "Accept-Language": "en-US,en;q=0.9",
    }
  });
  console.log("Craigslist fetch status:", res.status);
  const html = await res.text();

  const items = [];
  const linkPattern = /href="(https:\/\/newyork\.craigslist\.org\/mnh\/sub\/d\/[^"]+)"/g;
  let linkMatch;
  const links = [];
  while ((linkMatch = linkPattern.exec(html)) !== null) {
    if (!links.includes(linkMatch[1])) links.push(linkMatch[1]);
  }
  console.log(`Found ${links.length} listing links`);

  for (const link of links.slice(0, 50)) {
    const idMatch = link.match(/(\d+)\.html/);
    const id = idMatch ? idMatch[1] : Math.random().toString(36).slice(2);
    const titleFromUrl = link.split("/").pop().replace(".html", "").replace(/-/g, " ");
    const linkIndex = html.indexOf(link);
    const surrounding = html.slice(Math.max(0, linkIndex - 200), linkIndex + 200);
    const priceMatch = surrounding.match(/\$[\d,]+/);
    const price = priceMatch ? priceMatch[0] : "";

    items.push({
      id, title: titleFromUrl, url: link, post: "", price,
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
      messages: [{ role: "user", content: `Listing:\nTitle: ${listing.title}\nPrice: ${listing.price}\nLocation: ${listing.location}\nBedrooms: ${listing.bedrooms}\nAvailable: ${listing.availableFrom}\nDescription: ${(listing.post || "").slice(0, 500)}\n\nDraft all 4 message types.` }]
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
    body: new URLSearchParams({ To: ALERT_PHONE, From: TWILIO_FROM, Body: `${count} new NYC sublet${count > 1 ? "s" : ""} match your criteria. Review: ${process.env.APP_URL || "https://sublet-agent-production.up.railway.app"}` }).toString(),
  });
}

async function fetchAndProcess() {
  if (isFetching) return 0;
  isFetching = true;
  try {
    console.log("Fetching listings...");
    const items = await fetchListings();
    const eligible = items.filter(passes);
    const existing = await loadListings();
    const seen = new Set(existing.map(l => l.id));
    const newListings = eligible.filter(l => !seen.has(l.id));
    console.log(`${newListings.length} new listings out of ${eligible.length} eligible`);

    for (const listing of newListings) {
      try { listing.drafts = await generateDraft(listing); }
      catch (e) { console.error(`Draft failed for ${listing.id}:`, e.message); }
      await saveListing(listing);
    }

    if (newListings.length > 0) await sendSmsAlert(newListings.length);
    return newListings.length;
  } finally { isFetching = false; }
}

app.get("/", async (req, res) => {
  const listings = await loadListings();
  res.json({ status: "ok", count: listings.length, fetching: isFetching });
});

app.get("/listings", async (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.json(await loadListings());
});

app.get("/refresh", async (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  try {
    const count = await fetchAndProcess();
    const listings = await loadListings();
    res.json({ success: true, newListings: count, total: listings.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/refresh", async (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  try {
    const count = await fetchAndProcess();
    const listings = await loadListings();
    res.json({ success: true, newListings: count, total: listings.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.options("*", (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(200);
});

app.listen(PORT, async () => {
  console.log(`Sublet agent running on port ${PORT}`);
  await initDb();
  fetchAndProcess().catch(console.error);
  setInterval(() => fetchAndProcess().catch(console.error), 30 * 60 * 1000);
});
