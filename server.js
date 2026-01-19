import express from "express";
import puppeteer from "puppeteer-core";

const app = express();
app.use(express.json({ limit: "5mb" }));

// ===============================
// GLOBAL SAFETY
// ===============================
process.on("unhandledRejection", (err) => console.error("Unhandled:", err));
process.on("uncaughtException", (err) => console.error("Fatal:", err));

// ===============================
// ENV
// ===============================
const BROWSER_WS = process.env.BROWSER_WS;

// ===============================
// HEALTH
// ===============================
app.get("/health", (_, res) => {
  res.json({ status: "ok" });
});

// ===============================
// UTILS
// ===============================
async function connectBrowser() {
  if (!BROWSER_WS) throw new Error("BROWSER_WS env missing in Render");

  return puppeteer.connect({
    browserWSEndpoint: BROWSER_WS,
    defaultViewport: { width: 1366, height: 768 },
    ignoreHTTPSErrors: true,
  });
}

async function safeGoto(page, url) {
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
}

async function blockCloudflare(page) {
  const title = await page.title();
  if (
    title.includes("Just a moment") ||
    title.includes("Cloudflare") ||
    title.includes("Verify")
  ) {
    throw new Error("Blocked by Cloudflare");
  }
}

// ===============================
// SCRAPE
// ===============================
app.post("/scrape", async (req, res) => {
  const { startUrl, category } = req.body;

  if (!startUrl || !category) {
    return res
      .status(400)
      .json({ success: false, error: "startUrl or category missing" });
  }

  let browser, page;

  try {
    browser = await connectBrowser();
    page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
    );

    // open category page
    await safeGoto(page, startUrl);
    await blockCloudflare(page);

    // -------------------------------
    // GET LISTING LINKS
    // -------------------------------
    const links = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("a"))
        .map((a) => a.href)
        .filter(
          (h) =>
            h &&
            h.startsWith("https://www.jamesedition.com") &&
            /\d+$/.test(h)
        );
    });

    const unique = [...new Set(links)];
    if (!unique.length) throw new Error("No listings found");

    const chosen = unique[Math.floor(Math.random() * unique.length)];

    // -------------------------------
    // OPEN LISTING
    // -------------------------------
    await safeGoto(page, chosen);
    await blockCloudflare(page);

    // -------------------------------
    // EXTRACT DATA
    // -------------------------------
    const data = await page.evaluate(() => {
      const text = (sel) =>
        document.querySelector(sel)?.innerText?.trim() || null;

      const meta = (name) =>
        document.querySelector(`meta[property="${name}"]`)?.content ||
        document.querySelector(`meta[name="${name}"]`)?.content ||
        null;

      const price =
        text(".je2-listing-info__price span") ||
        text(".ListingCard__price") ||
        meta("product:price:amount") ||
        meta("og:price:amount");

      return {
        title: meta("og:title") || text("h1"),
        description: meta("og:description"),
        image: meta("og:image"),
        url: meta("og:url"),
        price,
      };
    });

    if (!data.title || !data.price) throw new Error("Invalid listing data");

    return res.json({
      success: true,
      category,
      website_link: data.url || chosen,
      caption: data.title,
      description: data.description,
      price: String(data.price).replace(/[^\d]/g, ""),
      images: data.image ? [data.image] : [],
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  } finally {
    try {
      if (page) await page.close();
    } catch {}
    try {
      if (browser) await browser.disconnect();
    } catch {}
  }
});

// ===============================
const PORT = process.env.PORT || 4000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Puppeteer Scrape API running on port " + PORT);
});
