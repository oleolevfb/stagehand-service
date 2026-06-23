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

    // Wrap the instructions to strongly preserve line breaks
    const wrappedInstruction = `
You are a browser automation agent controlling a real browser.

Your main task is described below. Follow it carefully to fill and submit forms.

IMPORTANT RULES (DO NOT IGNORE):
- When filling any message or textarea field, you MUST preserve all line breaks exactly as provided.
- Do not rephrase, rewrite, or normalize whitespace.
- Do not collapse multiple newlines into one.
- If the text you are given contains \\n or \\n\\n, enter it exactly as-is into the form field.
- Prefer direct filling/typing so the field value matches the provided text exactly.

Original task:
${instructions}
`.trim();

    // Cheaper/faster model suited for UI automation
    const agent = stagehand.agent({
      model: "google/gemini-2.5-flash",
    });

    const agentResult = await agent.execute({
      instruction: wrappedInstruction,
      maxSteps: 25, // give it enough steps; Lovable expects 25–35
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
 * Main endpoint Lovable calls.
 * Lovable sends: { url, instructions, callback_url, job_id, shared_secret }
 *
 * Pattern:
 *  - Respond immediately with { accepted: true, job_id }.
 *  - Then await runStagehand(...) in the same handler.
 *  - Always POST a final callback with job_id, success, extraction, liveSessionUrl, error.
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

  // Acknowledge immediately so Lovable's Worker returns quickly
  res.json({ accepted: true, job_id });

  // Now, still inside the same request handler, run Stagehand and send the callback
  try {
    const result = await runStagehand({ url, instructions });

    if (!callback_url) {
      console.warn("No callback_url provided; not sending callback.");
      return;
    }

    // Build a simple "extraction" string from agentResult for Lovable
    let extraction = "";
    if (result.result && result.result.agentResult) {
      if (typeof result.result.agentResult === "string") {
        extraction = result.result.agentResult;
      } else {
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
    console.error("Error during Stagehand run or callback:", err);

    // Even if runStagehand or fetch throws, try to notify Lovable once
    if (callback_url) {
      try {
        await fetch(callback_url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Stagehand-Secret": shared_secret,
          },
          body: JSON.stringify({
            job_id,
            success: false,
            extraction: "",
            liveSessionUrl: null,
            error: err.message || "Unknown error in Render Stagehand service",
          }),
        });
      } catch (e) {
        console.error("Failed to POST error callback to Lovable:", e);
      }
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Stagehand service listening on port ${PORT}`);
});
