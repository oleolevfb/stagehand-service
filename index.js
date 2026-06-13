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

// Helper: run Stagehand once and return the same shape as before
async function runStagehand({ url, instructions }) {
  let stagehand;
  try {
    stagehand = new Stagehand({
      env: "BROWSERBASE",
    });

    await stagehand.init();

    const page = stagehand.context.pages()[0];
    const targetUrl = url || "https://example.com";
    await page.goto(targetUrl);

    const extractResult = await stagehand.extract(instructions);

    return {
      success: true,
      result: {
        message: "Stagehand ran successfully",
        instructionsReceived: instructions,
        urlVisited: targetUrl,
        extractResult,
        liveSessionUrl: `https://browserbase.com/sessions/${stagehand.browserbaseSessionID}`,
      },
      error: null,
    };
  } catch (err) {
    console.error("Error in runStagehand:", err);
    return {
      success: false,
      result: null,
      error: err.message || "Unknown error",
    };
  } finally {
    if (stagehand) {
      try {
        await stagehand.close();
      } catch (e) {
        console.error("Error closing Stagehand:", e);
      }
    }
  }
}

/**
 * Main endpoint Lovable will call.
 * Lovable now sends: { url, instructions, callback_url, job_id, shared_secret }
 */
app.post("/run", async (req, res) => {
  const { url, instructions, callback_url, job_id, shared_secret } = req.body || {};
  console.log("Received /run request:", req.body);

  if (!instructions) {
    return res.status(400).json({
      accepted: false,
      error: "Missing 'instructions' in request body",
    });
  }

  // Respond immediately so Lovable's Worker returns quickly
  res.json({ accepted: true, job_id });

  // Run Stagehand asynchronously
  runStagehand({ url, instructions }).then(async (result) => {
    try {
      if (!callback_url) return;

      await fetch(callback_url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Stagehand-Secret": shared_secret,
        },
        body: JSON.stringify({
          job_id,
          success: result.success,
          extraction: result.result?.extractResult?.extraction ?? "",
          liveSessionUrl: result.result?.liveSessionUrl ?? null,
          error: result.error ?? null,
        }),
      });
    } catch (err) {
      console.error("Error POSTing back to callback_url:", err);
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Stagehand service listening on port ${PORT}`);
});

