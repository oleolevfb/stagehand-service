require("dotenv").config();
const express = require("express");
const { Stagehand } = require("@browserbasehq/stagehand");

// Node 18+ has global fetch; if you’re on older Node, uncomment next line:
// const fetch = require("node-fetch");

const app = express();
app.use(express.json());

app.get("/", (_req, res) => res.send("Stagehand service is running"));

/**
 * Helper: wait N milliseconds
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Helper: solve reCAPTCHA v2 using 2Captcha.
 * It sends the sitekey + page URL to 2Captcha, waits for the solution,
 * and returns the token string.
 */
async function solveRecaptchaWith2Captcha({ sitekey, url }) {
  const apiKey = process.env.TWO_CAPTCHA_API_KEY;
  if (!apiKey) {
    console.warn("TWO_CAPTCHA_API_KEY is not set; skipping 2Captcha solving.");
    return null;
  }

  console.log("Sending CAPTCHA to 2Captcha:", { sitekey, url });

  // 1) Ask 2Captcha to start solving
  const inUrl = `https://2captcha.com/in.php?key=${encodeURIComponent(
    apiKey,
  )}&method=userrecaptcha&googlekey=${encodeURIComponent(
    sitekey,
  )}&pageurl=${encodeURIComponent(url)}&json=1`;

  const inResp = await fetch(inUrl);
  const inData = await inResp.json();
  if (inData.status !== 1) {
    console.error("2Captcha /in.php error:", inData);
    return null;
  }

  const requestId = inData.request;
  console.log("2Captcha request id:", requestId);

  // 2) Poll for result
  const resBaseUrl = `https://2captcha.com/res.php?key=${encodeURIComponent(
    apiKey,
  )}&action=get&id=${encodeURIComponent(requestId)}&json=1`;

  // 2Captcha recommends 15–20 seconds initial wait, then poll
  await sleep(15000);

  for (let i = 0; i < 24; i++) {
    const resResp = await fetch(resBaseUrl);
    const resData = await resResp.json();

    if (resData.status === 1) {
      console.log("2Captcha solved!");
      return resData.request; // this is the recaptcha token
    }

    if (resData.request !== "CAPCHA_NOT_READY") {
      console.error("2Captcha /res.php error:", resData);
      return null;
    }

    console.log("2Captcha not ready yet, waiting 5s...");
    await sleep(5000);
  }

  console.error("2Captcha timed out waiting for solution.");
  return null;
}

/**
 * Try to detect a reCAPTCHA sitekey on the page.
 * This is a simple heuristic that works for many v2 sites.
 */
async function detectRecaptchaSitekey(page) {
  try {
    // Look for e.g. <div class="g-recaptcha" data-sitekey="...">
    const locator = page.locator('[data-sitekey]');
    if (await locator.count()) {
      const sitekey = await locator.first().getAttribute("data-sitekey");
      if (sitekey) {
        console.log("Detected reCAPTCHA sitekey on page:", sitekey);
        return sitekey;
      }
    }
  } catch (e) {
    console.error("Error while trying to detect reCAPTCHA sitekey:", e);
  }
  return null;
}

/**
 * Inject the 2Captcha token into the page so that reCAPTCHA is satisfied.
 * This usually means filling the hidden g-recaptcha-response textarea.
 */
async function injectRecaptchaToken(page, token) {
  if (!token) return;

  console.log("Injecting reCAPTCHA token into page");

  await page.evaluate((token) => {
    // Try to find the existing hidden textarea
    let textarea =
      document.querySelector("#g-recaptcha-response") ||
      document.querySelector("textarea[name='g-recaptcha-response']");

    if (!textarea) {
      // If not found, create one and append it
      textarea = document.createElement("textarea");
      textarea.id = "g-recaptcha-response";
      textarea.name = "g-recaptcha-response";
      textarea.style.display = "none";
      document.body.appendChild(textarea);
    }

    textarea.value = token;

    // Trigger events in case the site listens to them
    const events = ["change", "input"];
    events.forEach((eventName) => {
      const evt = new Event(eventName, { bubbles: true });
      textarea.dispatchEvent(evt);
    });
  }, token);
}

async function runStagehand({ url, instructions }) {
  let stagehand;
  try {
    stagehand = new Stagehand({ env: "BROWSERBASE" });
    await stagehand.init();

    const page = stagehand.context.pages()[0];
    const targetUrl = url || "https://example.com";
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });

    // === NEW: reCAPTCHA handling with 2Captcha ===
    try {
      const sitekey = await detectRecaptchaSitekey(page);

      if (sitekey && process.env.TWO_CAPTCHA_API_KEY) {
        console.log("Attempting to solve reCAPTCHA via 2Captcha…");
        const token = await solveRecaptchaWith2Captcha({ sitekey, url: targetUrl });
        if (token) {
          await injectRecaptchaToken(page, token);
          console.log("reCAPTCHA token injected successfully.");
        } else {
          console.warn("Could not get token from 2Captcha.");
        }
      } else if (sitekey && !process.env.TWO_CAPTCHA_API_KEY) {
        console.warn(
          "reCAPTCHA detected but TWO_CAPTCHA_API_KEY is not set. 2Captcha will not be used.",
        );
      } else {
        console.log("No reCAPTCHA sitekey detected on this page.");
      }
    } catch (e) {
      console.error("Error during reCAPTCHA detection/solving:", e);
    }
    // === END reCAPTCHA handling ===

    const wrappedInstruction = `
You are a browser automation agent controlling a real browser.

Your job is to fill out and SUBMIT the contact form on this page.

HARD RULES:
- Preserve all line breaks in any message/textarea field exactly as provided. Do not rephrase, rewrite, or collapse whitespace. If the text contains \\n or \\n\\n, type it exactly as-is.
- You MUST fill every required field before submitting.
- You MUST click the submit/send button at the end.
- After submitting, WAIT for and OBSERVE the confirmation: a thank-you message, success banner, redirect, or any visible change confirming the form was sent.
- Only stop once submission is confirmed (or it is clearly impossible, e.g. captcha you cannot solve).
- Report in your final message whether the form was submitted successfully and quote any confirmation text you saw.

Original task:
${instructions}
`.trim();

    const agent = stagehand.agent({ model: "google/gemini-2.5-flash" });

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
