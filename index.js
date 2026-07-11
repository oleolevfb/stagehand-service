require("dotenv").config();
const express = require("express");
const { Stagehand } = require("@browserbasehq/stagehand");

// Node 18+ has global fetch; if you're on older Node, uncomment next line:
// const fetch = require("node-fetch");

const app = express();
app.use(express.json());

app.get("/", (_req, res) => res.send("Stagehand service is running"));

function parseOutcome(text) {
  if (!text) return { outcome: undefined, excerpt: null };
  const m = String(text).match(
    /OUTCOME:\s*(CONFIRMED|CAPTCHA_BLOCKED|NO_CONFIRMATION|ERROR)\s*[—:-]?\s*(.{0,400})?/i,
  );
  if (!m) return { outcome: undefined, excerpt: null };
  return {
    outcome: m[1].toLowerCase(), // confirmed | captcha_blocked | no_confirmation | error
    excerpt: (m[2] || "").trim().slice(0, 300) || null,
  };
}

function safeStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

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
- FIRST, paste or fill the entire message into the textarea in one operation (do NOT type it out character by character).
- AFTER pasting, only make SMALL adjustments if absolutely necessary (e.g. inserting or deleting a line break), but do NOT clear the field and retype the whole message.
- Never erase the entire message to start over; fix it in-place instead.
- You MUST fill every required field before submitting.
- You MUST click the submit/send button at the end.
- After submitting, WAIT for and OBSERVE the confirmation: a thank-you message, success banner, redirect, or any visible change confirming the form was sent.
- Only stop once submission is confirmed (or it is clearly impossible, e.g. a captcha you cannot solve).
- When multiple buttons are visible, you MUST choose the one that belongs to the contact form you just filled. Prefer buttons near the form with labels like "Send", "Submit", "Contact", or "Send message". Do NOT click newsletter signup, cookie, or unrelated buttons.

FINAL OUTPUT CONTRACT (MANDATORY):
On the very last line of your final message, print EXACTLY ONE of:
  OUTCOME: CONFIRMED — <first 200 chars of the confirmation text or URL you saw>
  OUTCOME: CAPTCHA_BLOCKED — <describe the captcha>
  OUTCOME: NO_CONFIRMATION — <what the page showed after clicking submit>
  OUTCOME: ERROR — <what went wrong>
Do not omit this line. Do not use any other keyword. This line is how the calling system decides whether the submission succeeded.

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

const HARD_TIMEOUT_MS = 5 * 60 * 1000;

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

  const { outcome, excerpt } = parseOutcome(extraction);

  console.log("[stagehand] run finished", {
    job_id,
    success: result.success,
    outcome,
    error: result.error,
    extraction_preview: (extraction || "").slice(0, 200),
  });

  try {
    const cbRes = await fetch(callback_url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Stagehand-Secret": shared_secret },
      body: JSON.stringify({
        job_id,
        success: outcome ? outcome === "confirmed" : result.success,
        outcome,
        confirmation_excerpt: excerpt,
        extraction,
        liveSessionUrl: result.result?.liveSessionUrl ?? null,
        error: result.error ?? null,
      }),
    });
    console.log("[stagehand] callback POST", { job_id, status: cbRes.status, ok: cbRes.ok });
  } catch (e) {
    console.error("Callback POST failed:", e);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Stagehand service listening on port ${PORT}`));
