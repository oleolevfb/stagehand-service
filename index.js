// index.js

require("dotenv").config();
const express = require("express");
const { Stagehand } = require("@browserbasehq/stagehand");

const app = express();
app.use(express.json());

// Simple health check endpoint
app.get("/", (req, res) => {
  res.send("Stagehand service is running");
});

/**
 * Main endpoint Lovable will call.
 * It expects JSON like:
 * {
 *   "instructions": "Click the login button and take a screenshot.",
 *   "url": "https://example.com"
 * }
 */
app.post("/run", async (req, res) => {
  const { instructions, url } = req.body || {};

  if (!instructions) {
    return res.status(400).json({
      success: false,
      error: "Missing 'instructions' in request body",
    });
  }

  if (!process.env.BROWSERBASE_API_KEY) {
    return res.status(500).json({
      success: false,
      error: "BROWSERBASE_API_KEY not set on server",
    });
  }

  let browser;

  try {
    const stagehand = new Stagehand({
      apiKey: process.env.BROWSERBASE_API_KEY,
      // You can add other Stagehand options here if needed
    });

    browser = await stagehand.launch();
    const page = await browser.newPage();

    if (url) {
      await page.goto(url, { waitUntil: "networkidle0" });
    }

    // This is where you'd define what "instructions" does.
    // For now, we’ll just return the current page title and URL as an example.
    const pageTitle = await page.title();
    const pageUrl = page.url();

    // You can expand this to do more complex automation later.
    const result = {
      message: "Stagehand ran successfully",
      instructionsReceived: instructions,
      pageTitle,
      pageUrl,
    };

    res.json({ success: true, result });
  } catch (err) {
    console.error("Error in /run:", err);
    res.status(500).json({
      success: false,
      error: err.message || "Unknown error",
    });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeErr) {
        console.error("Error closing browser:", closeErr);
      }
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Stagehand service listening on port ${PORT}`);
});
