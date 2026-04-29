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

  // Craigslist embeds listing data in a script tag as JSON
  const match = html.match(/window\.__NEXT_DATA__\s*=\s*({[\s\S]*?})<\/script>/) ||
                html.match(/cl\.search\.data\s*=\s*({[\s\S]*?});\s*\n/) ||
                html.match(/"listings"\s*:\s*(\[[\s\S]*?\])\s*[,}]/);

  if (match) {
    console.log("Found embedded JSON data");
    try {
      const data = JSON.parse(match[1]);
      const listings = data?.props?.pageProps?.searchResults?.data?.results ||
                       data?.listings || data || [];
      console.log(`Parsed ${listings.length} listings from JSON`);
      return listings.map(item => ({
        id: String(item.id || item.pid || Math.random()),
        title: item.title || item.name || "",
        url: item.url || `https://newyork.craigslist.org${item.path || ""}`,
        post: item.body || item.description || item.snippet || "",
        price: item.price ? `$${item.price}` : "",
        bedrooms: item.bedrooms || item.br || 0,
        location: item.neighborhood || item.location || "Manhattan, NY",
        availableFrom: item.availableFrom || "",
        datetime: item.date || item.postedAt || "",
        phoneNumbers: [],
        platform: "Craigslist",
        address: { city: "New York" },
      }));
    } catch (e) {
      console.log("JSON parse failed:", e.message);
    }
  }

  // Fallback: parse listing links directly from HTML
  console.log("Falling back to HTML link parsing...");
  const items = [];
  const linkPattern = /href="(https:\/\/newyork\.craigslist\.org\/mnh\/sub\/d\/[^"]+)"/g;
  const titlePattern = /class="posting-title"[^>]*>\s*<span[^>]*>([^<]+)<\/span>/g;
  const pricePattern = /class="price">(\$[\d,]+)<\/span>/g;

  let linkMatch;
  const links = [];
  while ((linkMatch = linkPattern.exec(html)) !== null) {
    links.push(linkMatch[1]);
  }

  console.log(`Found ${links.length} listing links in HTML`);

  for (const link of links.slice(0, 50)) {
    const idMatch = link.match(/(\d+)\.html/);
    const id = idMatch ? idMatch[1] : Math.random().toString(36).slice(2);
    const titleFromUrl = link.split("/").pop().replace(".html", "").replace(/-/g, " ");
    items.push({
      id,
      title: titleFromUrl,
      url: link,
      post: "",
      price: "",
      bedrooms: 2,
      location: "Manhattan, NY",
      availableFrom: "",
      datetime: new Date().toISOString(),
      phoneNumbers: [],
      platform: "Craigslist",
      address: { city: "New York" },
    });
  }

  console.log(`Returning ${items.length} items from HTML fallback`);
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
  console.log("Fetching listings from Craigslist...");
  const items = await fetchListings();
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
