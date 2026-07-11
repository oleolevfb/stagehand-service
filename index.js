require("dotenv").config();
const express = require("express");
const { Stagehand } = require("@browserbasehq/stagehand");

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => res.send("Stagehand service is running"));

const MESSAGE_REGEX =
  /message|comments?|inquiry|inquiries|questions?|details|notes|how can we help|tell us|your\s*message/i;
const HONEYPOT_REGEX = /honeypot|url2|trap|bot|website\b/i;

async function prefillMessageTextarea(page, message, messageParagraphs) {
  if (!message) return { filled: false, selector: null, reason: "no_message" };

  const waitForAny = async (ms) => {
    try {
      await page.waitForSelector("textarea", { timeout: ms, state: "visible" });
      return true;
    } catch {
      return false;
    }
  };
  let found = await waitForAny(8000);
  if (!found) {
    try {
      const contactLink = page
        .getByRole("link", {
          name: /contact|reach us|inquire|appointment|consultation|get in touch/i,
        })
        .first();
      if (await contactLink.count()) {
        await contactLink.click({ timeout: 5000 }).catch(() => {});
        await page.waitForLoadState("domcontentloaded").catch(() => {});
      }
    } catch {}
    found = await waitForAny(8000);
  }
  if (!found) return { filled: false, selector: null, reason: "no_textarea" };

  const candidates = await page.$$eval(
    "textarea",
    (nodes, rx) => {
      const messageRe = new RegExp(rx.message, "i");
      const honeypotRe = new RegExp(rx.honeypot, "i");
      return nodes.map((el, idx) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const visible =
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0;
        const name = el.getAttribute("name") || "";
        const id = el.getAttribute("id") || "";
        const placeholder = el.getAttribute("placeholder") || "";
        const aria = el.getAttribute("aria-label") || "";
        let labelText = "";
        if (id) {
          const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (lab) labelText = lab.textContent || "";
        }
        if (!labelText && el.parentElement) {
          const lab = el.parentElement.querySelector("label");
          if (lab) labelText = lab.textContent || "";
        }
        const hay = `${name} ${id} ${placeholder} ${aria} ${labelText}`;
        let score = 0;
        if (messageRe.test(hay)) score += 5;
        if (messageRe.test(labelText)) score += 3;
        const rows = parseInt(el.getAttribute("rows") || "0", 10) || 0;
        const cols = parseInt(el.getAttribute("cols") || "0", 10) || 0;
        score += Math.min(5, Math.floor((rows * cols) / 100));
        if (!visible) score -= 20;
        if (el.hasAttribute("readonly") || el.hasAttribute("disabled")) score -= 20;
        if (honeypotRe.test(hay)) score -= 20;
        let selector = "";
        if (id) selector = `textarea#${CSS.escape(id)}`;
        else if (name) selector = `textarea[name="${name}"]`;
        else selector = `textarea >> nth=${idx}`;
        return { selector, score, visible, name, id, placeholder, labelText, idx };
      });
    },
    { message: MESSAGE_REGEX.source, honeypot: HONEYPOT_REGEX.source },
  );

  const best = candidates
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)[0];
  if (!best) {
    return { filled: false, selector: null, reason: "no_matching_textarea", candidates };
  }

  const loc = page.locator(best.selector).first();
  let filled = false;
  let usedFallback = false;
  let reason = "unknown";
  let verifiedLength = 0;
  try {
    await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await loc.click({ timeout: 3000 }).catch(() => {});
    await loc.fill("", { timeout: 3000 }).catch(() => {});
    await loc.fill(message, { timeout: 8000 });
    const got = await loc.inputValue().catch(() => "");
    verifiedLength = got.length;
    if (got && got.length >= Math.min(20, message.length)) {
      filled = true;
      reason = "fill_ok";
    } else {
      usedFallback = true;
      await loc.fill("").catch(() => {});
      await loc.click({ timeout: 3000 }).catch(() => {});
      const paragraphs =
        Array.isArray(messageParagraphs) && messageParagraphs.length
          ? messageParagraphs
          : message.split(/\n{2,}/g);
      for (let p = 0; p < paragraphs.length; p++) {
        const lines = String(paragraphs[p]).split("\n");
        for (let i = 0; i < lines.length; i++) {
          await loc.pressSequentially(lines[i], { delay: 5 });
          if (i < lines.length - 1) await page.keyboard.press("Shift+Enter");
        }
        if (p < paragraphs.length - 1) {
          await page.keyboard.press("Enter");
          await page.keyboard.press("Enter");
        }
      }
      const got2 = await loc.inputValue().catch(() => "");
      verifiedLength = got2.length;
      filled = got2.length > 0;
      reason = filled ? "sequential_ok" : "fill_and_sequential_failed";
    }
  } catch (err) {
    return {
      filled: false,
      selector: best.selector,
      reason: `fill_error: ${err.message || err}`,
      candidates,
      verifiedLength,
      usedFallback,
    };
  }

  let locked = false;
  if (filled) {
    try {
      locked = await loc.evaluate((el) => {
        try {
          el.setAttribute("data-lovable-prefilled", "1");
          el.readOnly = true;
          if (typeof el.blur === "function") el.blur();
          return true;
        } catch {
          return false;
        }
      });
    } catch {
      locked = false;
    }
  }

  return {
    filled,
    selector: best.selector,
    reason,
    verifiedLength,
    usedFallback,
    locked,
    candidates,
  };
}

async function runStagehand({ url, instructions, message, message_paragraphs }) {
  let stagehand;
  try {
    stagehand = new Stagehand({ env: "BROWSERBASE" });
    await stagehand.init();

    const page = stagehand.context.pages()[0];
    const targetUrl = url || "https://example.com";
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });

    const prefill = await prefillMessageTextarea(page, message, message_paragraphs);
    console.log("[stagehand] prefill result", {
      filled: prefill.filled,
      locked: prefill.locked,
      selector: prefill.selector,
      reason: prefill.reason,
      verifiedLength: prefill.verifiedLength,
      usedFallback: prefill.usedFallback,
    });

    const messageNote =
      prefill.filled && prefill.locked
        ? `The message/comments/inquiry textarea has ALREADY BEEN FILLED and LOCKED for you by the automation harness (Playwright locator.fill on selector "${prefill.selector}"; the element is now readOnly and tagged data-lovable-prefilled="1"). DO NOT click it, focus it, clear it, retype it, or edit it in any way — it is intentionally readOnly and the value will submit correctly as-is. Your job is to fill the OTHER fields (name, email, phone, subject, dropdowns, checkboxes) and click the submit button.`
        : prefill.filled
          ? `The message textarea has been filled by the harness but could not be locked. Please do NOT retype or edit it; only fill the other fields and submit.`
          : `The message textarea could NOT be pre-filled automatically (reason: ${prefill.reason}). You must locate the message/comments field yourself and paste the message verbatim.`;

    const wrappedInstruction = `
You are a browser automation agent controlling a real browser.

Your job is to fill out and SUBMIT the contact form on this page.

${messageNote}

HARD RULES:
- Fill every required field (except the message field described above) before submitting.
- Click the submit/send button at the end.
- After submitting, WAIT and OBSERVE the confirmation.
- On your FINAL line, print exactly one of:
  OUTCOME: CONFIRMED — <first 200 chars of confirmation>
  OUTCOME: CAPTCHA_BLOCKED — <captcha type>
  OUTCOME: NO_CONFIRMATION — <what the page showed>
  OUTCOME: ERROR — <what went wrong>

Original task:
${instructions}
`.trim();

    const agent = stagehand.agent({ model: "anthropic/claude-sonnet-4-6" });

    const agentResult = await agent.execute({
      instruction: wrappedInstruction,
      maxSteps: 35,
    });

    let finalUrl = "";
    let pageText = "";
    try { finalUrl = page.url(); } catch {}
    try { pageText = (await page.locator("body").innerText()).slice(0, 2000); } catch {}

    return {
      success: true,
      result: {
        message: "Stagehand agent finished",
        instructionsReceived: instructions,
        urlVisited: targetUrl,
        finalUrl,
        pageText,
        agentResult,
        prefill,
        liveSessionUrl: `https://browserbase.com/sessions/${stagehand.browserbaseSessionID}`,
      },
      error: null,
    };
  } catch (err) {
    console.error("Error in runStagehand:", err);
    return { success: false, result: null, error: err.message || "Unknown error" };
  } finally {
    if (stagehand) {
      try { await stagehand.close(); } catch (e) { console.error(e); }
    }
  }
}

function safeStringify(v) { try { return JSON.stringify(v); } catch { return ""; } }

function parseOutcome(text) {
  if (!text) return { outcome: undefined, excerpt: null };
  const m = String(text).match(
    /OUTCOME:\s*(CONFIRMED|CAPTCHA_BLOCKED|NO_CONFIRMATION|ERROR)\s*[—:-]?\s*(.{0,400})?/i,
  );
  if (!m) return { outcome: undefined, excerpt: null };
  return {
    outcome: m[1].toLowerCase(),
    excerpt: (m[2] || "").trim().slice(0, 300) || null,
  };
}

const HARD_TIMEOUT_MS = 4 * 60 * 1000;

app.post("/run", async (req, res) => {
  const {
    url,
    instructions,
    message,
    message_paragraphs,
    callback_url,
    job_id,
    shared_secret,
  } = req.body || {};
  if (!instructions) {
    return res.status(400).json({ accepted: false, error: "Missing 'instructions'" });
  }

  res.json({ accepted: true, job_id });

  let result;
  try {
    result = await Promise.race([
      runStagehand({ url, instructions, message, message_paragraphs }),
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
  if (result.result?.prefill) {
    extraction += `\n\n[prefill] ${safeStringify({
      filled: result.result.prefill.filled,
      locked: result.result.prefill.locked,
      selector: result.result.prefill.selector,
      reason: result.result.prefill.reason,
      verifiedLength: result.result.prefill.verifiedLength,
      usedFallback: result.result.prefill.usedFallback,
    })}`;
  }

  const { outcome, excerpt } = parseOutcome(extraction);

  console.log("[stagehand] run finished", {
    job_id,
    success: result.success,
    outcome,
    error: result.error,
    prefill_filled: result.result?.prefill?.filled,
    prefill_locked: result.result?.prefill?.locked,
  });

  try {
    const cbRes = await fetch(callback_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-stagehand-secret": shared_secret || process.env.STAGEHAND_SHARED_SECRET || "",
      },
      body: JSON.stringify({
        job_id,
        success: outcome === "confirmed" || (outcome === undefined && result.success),
        outcome,
        confirmation_excerpt: excerpt,
        extraction,
        prefill: result.result?.prefill
          ? {
              filled: result.result.prefill.filled,
              locked: result.result.prefill.locked,
              selector: result.result.prefill.selector,
              reason: result.result.prefill.reason,
              verifiedLength: result.result.prefill.verifiedLength,
              usedFallback: result.result.prefill.usedFallback,
            }
          : null,
        liveSessionUrl: result.result?.liveSessionUrl ?? null,
        result: result.result,
        error: result.error ?? null,
      }),
    });
    console.log("[stagehand] callback POST", { job_id, status: cbRes.status, ok: cbRes.ok });
  } catch (err) {
    console.error("callback POST failed:", err);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Stagehand service listening on port ${PORT}`));
