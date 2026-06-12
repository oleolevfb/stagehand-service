// index.js

require("dotenv").config();
const express = require("express");
const { Stagehand } = require("@browserbasehq/stagehand");

const app = express();
app.use(express.json());

app.post("/run", async (req, res) => {
  const { instructions, url } = req.body || {};
  console.log("Received /run request:", req.body);

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

  let agent;

  try {
    // Create Stagehand agent
    agent = new Stagehand({
      apiKey: process.env.BROWSERBASE_API_KEY,
      env: "node", // tell Stagehand we're in a Node environment
    });


    // Initialize the agent
    await agent.init();

    // Go to the URL if provided, otherwise use example.com
    const targetUrl = url || "https://example.com";
    await agent.connectURL(targetUrl);

    // Run an extraction based on the instructions
    const extraction = await agent.extract({
      instructions,
    });

    // Build a simple response – we’ll include the raw extraction result
    const result = {
      message: "Stagehand ran successfully",
      instructionsReceived: instructions,
      urlVisited: targetUrl,
      extraction,
    };

    res.json({ success: true, result });
  } catch (err) {
    console.error("Error in /run:", err);
    res.status(500).json({
      success: false,
      error: err.message || "Unknown error",
    });
  } finally {
    if (agent) {
      try {
        await agent.close();
      } catch (closeErr) {
        console.error("Error closing Stagehand agent:", closeErr);
      }
    }
  }
});




/**
 * Main endpoint Lovable will call.
 * It expects JSON like:
 * {
 *   "instructions": "Get page title",
 *   "url": "https://example.com"
 * }
 */
app.post("/run", async (req, res) => {
  console.log("Received /run request:", req.body);

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

    // Launch a browser via Browserbase
    browser = await stagehand.launch();
    const page = await browser.newPage();

    if (url) {
      await page.goto(url, { waitUntil: "networkidle0" });
    }

    // Simple example behavior: return the page title and URL
    const pageTitle = await page.title();
    const pageUrl = page.url();

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
