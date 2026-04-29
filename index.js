const express = require("express");
const app = express();
app.use(express.json());

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const TWILIO_SID = process.env.TWILIO_SID;
const TWILIO_TOKEN = process.env.TWILIO_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM;
const ALERT_PHONE = process.env.ALERT_PHONE;
const PORT = process.env.PORT || 3000;

let cachedListings = [];
let lastFetch = null;

function passes(listing) {
  if ((listing.bedrooms || 0) < 2) return false;
  const nonManhattan = ["Brooklyn", "Queens", "Bronx", "Jersey City", "Ridgewood", "Woodside", "Long Island City"];
  const loc = (listing.location || "") + (listing.address?.city || "");
  if (nonManhattan.some(b => loc.includes(b))) return false;
  const avail = (listing.availableFrom || "").toLowerCase();
  if (avail.includes("jul") || avail.includes("aug") || avail.includes("sep")) return false;
  return true;
}

async function fetchRssListings() {
  const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent("https://newyork.craigslist.org/search/sub?format=rss")}`;
  const res = await fetch(proxyUrl);
  const xml = await res.text();
  console.log("RSS fetch status:", res.status);
  console.log("First 500 chars:", xml.slice(0, 500));

  const items = [];
  const entries = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
  for (const entry of entries) {
    const get = (tag) => {
      const m = entry.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>|<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return m ? (m[1] || m[2] || "").trim() : "";
    };
    const title = get("title");
    const url = (entry.match(/<link>(.*?)<\/link>/) || [])[1] || "";
    const description = get("description");
    const pubDate = get("pubDate");

    const brMatch = title.match(/(\d)\s*b(r|ed)/i);
    const bedrooms = brMatch ? parseInt(brMatch[1]) : 0;
    const priceMatch = description.match(/\$[\d,]+/);
    const price = priceMatch ? priceMatch[0] : "";

    items.push({
      id: url.match(/(\d+)\.html/)?.[1] || Math.random().toString(36).slice(2),
      title,
      url,
      post: description.replace(/<[^>]+>/g, "").trim(),
      price,
      bedrooms,
      location: "Manhattan, NY",
      availableFrom: "",
      datetime: pubDate,
      phoneNumbers: [],
      platform: "Craigslist",
      address: { city: "New York" },
    });
  }
  console.log(`RSS returned ${items.length} items`);
  return items;
}

async function generateDraft(listing) {
  const system = `You draft sublet outreach messages for three HBS students: Alex, Julian, and Nora (from Germany and Austria). They need a 2-3 bedroom apartment in Manhattan (south of 105th St) from June to August 2026 for internships. Sign as Alex. Keep messages warm, genuine, and brief. Mention HBS and the summer internship. Always ask if it's still available and mention June–August dates. Return ONLY valid JSON, no markdown: {"inApp":"...","email":{"subject":"...","body":"..."},"sms":"...","whatsapp":"..."}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system,
      messages: [{
        role: "user",
        content: `Listing:\nTitle: ${listing.title}\nPrice: ${listing.price}\nLocation: ${listing.location}\nBedrooms: ${listing.bedrooms}\nAvailable: ${listing.availableFrom}\nDescription: ${(listing.post || "").slice(0, 500)}\n\nDraft all 4 message types.`
      }]
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
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64"),
    },
    body: new URLSearchParams({
      To: ALERT_PHONE,
      From: TWILIO_FROM,
      Body: `${count} new NYC sublet${count > 1 ? "s" : ""} match your criteria. Review them now: ${process.env.APP_URL || "your app"}`,
    }).toString(),
  });
}

async function fetchAndProcess() {
  console.log("Fetching listings from Craigslist RSS...");
  const items = await fetchRssListings();
  const eligible = items.filter(passes);
  console.log(`Found ${eligible.length} matching listings out of ${items.length}`);

  const seen = new Set(cachedListings.map(l => l.id));
  const newListings = eligible.filter(l => !seen.has(l.id));
  console.log(`${newListings.length} are new`);

  for (const listing of newListings) {
    try {
      listing.drafts = await generateDraft(listing);
    } catch (e) {
      console.error(`Draft failed for ${listing.id}:`, e.message);
    }
  }

  if (newListings.length > 0) {
    cachedListings = [...newListings, ...cachedListings].slice(0, 200);
    await sendSmsAlert(newListings.length);
  }

  lastFetch = new Date().toISOString();
  return newListings.length;
}

app.get("/", (req, res) => res.json({ status: "ok", lastFetch, count: cachedListings.length }));

app.get("/listings", (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.json(cachedListings);
});

app.post("/refresh", async (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  try {
    const count = await fetchAndProcess();
    res.json({ success: true, newListings: count, total: cachedListings.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.options("*", (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Sublet agent running on port ${PORT}`);
  fetchAndProcess().catch(console.error);
});
