require("dotenv").config();
const express = require("express");
const { Stagehand } = require("@browserbasehq/stagehand");

// Node 18+ has global fetch; if you’re on older Node, uncomment next line:
// const fetch = require("node-fetch");

const app = express();
app.use(express.json());

app.get("/", (_req, res) => res.send("Stagehand service is running"));

async function runStagehand({ url, instructions }) {
  let stagehand;
  try {
    stagehand = new Stagehand({ env: "BROWSERBASE" });
    await stagehand.init();

    const page = stagehand.context.pages()[0];
    const targetUrl = url || "https://example.com";
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });

    const wrappedInstruction = `
You are a browser automation agent controlling a real browser.

Your job is to fill out and SUBMIT the contact form on this page.

HARD RULES (DO NOT IGNORE):
- Preserve all line breaks in any message/textarea field exactly as provided. Do not rephrase, rewrite, or collapse whitespace.
- If the text you are given contains \\n or \\n\\n, type it exactly as-is into the textarea so the on-page text matches character-for-character.
- Do NOT "tidy up" or normalize the message; treat it as literal text that must be copied exactly.
- You MUST fill every required field before submitting.
- You MUST click the submit/send button at the end.
- After submitting, WAIT for and OBSERVE the confirmation: a thank-you message, success banner, redirect, or any visible change confirming the form was sent.
- Only stop once submission is confirmed (or it is clearly impossible, e.g. a captcha you cannot solve).
- In your final message, state clearly whether the form was submitted successfully and quote any confirmation text you saw.
- When multiple buttons are visible, you MUST choose the one that belongs to the contact form you just filled. Prefer buttons near the form with labels like "Send", "Submit", "Contact", or "Send message". Do NOT click newsletter signup, cookie, or unrelated buttons.


Original task:
${instructions}
`.trim();

    const agent = stagehand.agent({ model: "anthropic/claude-sonnet-4-5" });

    const agentResult = await agent.execute({
      instruction: wrappedInstruction,
      maxSteps: 35,
    });

    let finalUrl = "";
    let pageText = "";
    try {
      finalUrl = page.url();
    } catch {}
    try {
      pageText = (await page.locator("body").innerText()).slice(0, 2000);
    } catch {}

    return {
      success: true,
      result: {
        message: "Stagehand agent finished",
        instructionsReceived: instructions,
        urlVisited: targetUrl,
        finalUrl,
        pageText,
        agentResult,
        liveSessionUrl: `https://browserbase.com/sessions/${stagehand.browserbaseSessionID}`,
      },
      error: null,
    };
  } catch (err) {
    console.error("Error in runStagehand:", err);
    return { success: false, result: null, error: err.message || "Unknown error" };
  } finally {
    if (stagehand) {
      try {
        await stagehand.close();
      } catch (e) {
        console.error(e);
      }
    }
  }
}

const HARD_TIMEOUT_MS = 4 * 60 * 1000;

app.post("/run", async (req, res) => {
  const { url, instructions, callback_url, job_id, shared_secret } = req.body || {};
  if (!instructions) {
    return res.status(400).json({ accepted: false, error: "Missing 'instructions'" });
  }

  // Acknowledge immediately so Lovable's Worker can return
  res.json({ accepted: true, job_id });

  let result;
  try {
    result = await Promise.race([
      runStagehand({ url, instructions }),
      new Promise((resolve) =>
        setTimeout(
          () => resolve({ success: false, result: null, error: "render_hard_timeout_4min" }),
          HARD_TIMEOUT_MS,
        ),
      ),
    ]);
  } catch (err) {
    result = { success: false, result: null, error: err.message || "unknown_error" };
  }

  if (!callback_url) return;

  let extraction = "";
  const ar = result.result?.agentResult;
  if (ar) extraction = typeof ar === "string" ? ar : safeStringify(ar);
  if (result.result?.pageText) extraction += `\n\n[final_page_text]\n${result.result.pageText}`;
  if (result.result?.finalUrl) extraction += `\n\n[final_url] ${result.result.finalUrl}`;

  try {
    await fetch(callback_url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Stagehand-Secret": shared_secret },
      body: JSON.stringify({
        job_id,
        success: result.success,
        extraction,
        liveSessionUrl: result.result?.liveSessionUrl ?? null,
        error: result.error ?? null,
      }),
    });
  } catch (e) {
    console.error("Callback POST failed:", e);
  }
});

function safeStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Stagehand service listening on port ${PORT}`));
