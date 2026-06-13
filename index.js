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
 * Main endpoint Lovable (or any client) will call.
 * Expects JSON like:
 * {
 *   "instructions": "Extract the page title",
 *   "url": "https://example.com"
 * }
 */
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

  let stagehand;

  try {
    // Create Stagehand instance, using Browserbase
    stagehand = new Stagehand({
      env: "BROWSERBASE",
      apiKey: process.env.BROWSERBASE_API_KEY,
    });

    // Initialize Stagehand (starts session)
    await stagehand.init();

    console.log(`Stagehand session started`);
    console.log(
      `Watch live: https://browserbase.com/sessions/${stagehand.browserbaseSessionID}`
    );

    // Get the first page in the context
    const page = stagehand.context.pages()[0];

    // Go to the requested URL, or a default
    const targetUrl = url || "https://example.com";
    await page.goto(targetUrl, { waitUntil: "networkidle0" });

    // Run an extraction using the provided instructions
    const extractResult = await stagehand.extract(instructions);

    const result = {
      message: "Stagehand ran successfully",
      instructionsReceived: instructions,
      urlVisited: targetUrl,
      extractResult,
      liveSessionUrl: `https://browserbase.com/sessions/${stagehand.browserbaseSessionID}`,
    };

    res.json({ success: true, result });
  } catch (err) {
    console.error("Error in /run:", err);
    res.status(500).json({
      success: false,
      error: err.message || "Unknown error",
    });
  } finally {
    if (stagehand) {
      try {
        await stagehand.close();
      } catch (closeErr) {
        console.error("Error closing Stagehand:", closeErr);
      }
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Stagehand service listening on port ${PORT}`);
});
