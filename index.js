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

// Helper: run Stagehand once and return a result
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

    // Wrap the original instructions to strongly preserve line breaks
    const wrappedInstruction = `
You are a browser automation agent controlling a real browser.

Your main task is described below. Follow it carefully to fill and submit forms.

IMPORTANT RULES (DO NOT IGNORE):
- When filling any message or textarea field, you MUST preserve all line breaks exactly as provided.
- Do not rephrase, rewrite, or normalize whitespace.
- Do not collapse multiple newlines into one.
- Use direct typing or filling so that the value in the field matches the provided text exactly.

Original task:
${instructions}
`.trim();

    // Use a cheaper/faster model suitable for UI automation
    const agent = stagehand.agent({
      model: "google/gemini-2.5-flash",
    });

    const agentResult = await agent.execute({
      instruction: wrappedInstruction,
      maxSteps: 15, // you can tune this up/down
    });

    return {
      success: true,
      result: {
        message: "Stagehand agent ran successfully",
        instructionsReceived: instructions,
        urlVisited: targetUrl,
        agentResult,
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
 * Lovable sends: { url, instructions, callback_url, job_id, shared_secret }
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

      // Prepare a simple string "extraction" for Lovable
      let extraction = "";
      if (result.result && result.result.agentResult) {
        if (typeof result.result.agentResult === "string") {
          extraction = result.result.agentResult;
        } else {
          // If it's an object, send a JSON string so Lovable can inspect it
          try {
            extraction = JSON.stringify(result.result.agentResult);
          } catch {
            extraction = "";
          }
        }
      }

      await fetch(callback_url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Stagehand-Secret": shared_secret,
        },
        body: JSON.stringify({
          job_id,
          success: result.success,
          extraction,
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
