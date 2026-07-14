

require("dotenv").config();

const express = require("express");
const { Stagehand } = require("@browserbasehq/stagehand");

const app = express();

app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => {
  res.send("Stagehand service is running");
});

const MESSAGE_REGEX =
  /message|comments?|inquiry|inquiries|questions?|details|notes|how can we help|tell us|your\s*message/i;

const HONEYPOT_REGEX = /honeypot|url2|trap|bot|website\b/i;

const HARD_TIMEOUT_MS = 4 * 60 * 1000;

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function cssEscape(value) {
  return String(value || "").replace(/["\\]/g, "\\$&");
}

/*
  Stagehand's returned page object is not always a raw Playwright Page.
  In particular, some versions do not provide page.$$eval().

  This helper uses locator(...).evaluateAll() only when available; otherwise,
  it returns an empty list and lets the agent fill the message itself.
*/
async function findTextareaCandidates(page) {
  const locator = page.locator("textarea");

  if (!locator || typeof locator.evaluateAll !== "function") {
    return [];
  }

  try {
    return await locator.evaluateAll(
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
            const label = document.querySelector(
              `label[for="${CSS.escape(id)}"]`,
            );

            if (label) {
              labelText = label.textContent || "";
            }
          }

          if (!labelText && el.parentElement) {
            const label = el.parentElement.querySelector("label");

            if (label) {
              labelText = label.textContent || "";
            }
          }

          const haystack =
            `${name} ${id} ${placeholder} ${aria} ${labelText}`.trim();

          let score = 0;

          if (messageRe.test(haystack)) score += 5;
          if (messageRe.test(labelText)) score += 3;

          const rows = parseInt(el.getAttribute("rows") || "0", 10) || 0;
          const cols = parseInt(el.getAttribute("cols") || "0", 10) || 0;

          score += Math.min(5, Math.floor((rows * cols) / 100));

          if (!visible) score -= 20;

          /*
            Do not penalize readonly fields. The harness intentionally marks a
            successfully prefilled message field readonly after filling it.
          */
          if (el.hasAttribute("disabled")) score -= 20;

          if (honeypotRe.test(haystack)) score -= 20;

          let selector = "";

          if (id) {
            selector = `textarea#${CSS.escape(id)}`;
          } else if (name) {
            selector = `textarea[name="${name}"]`;
          } else {
            selector = `textarea >> nth=${idx}`;
          }

          return {
            idx,
            selector,
            score,
            visible,
            name,
            id,
            placeholder,
            labelText,
          };
        });
      },
      {
        message: MESSAGE_REGEX.source,
        honeypot: HONEYPOT_REGEX.source,
      },
    );
  } catch (err) {
    console.warn("[stagehand] textarea candidate evaluation unavailable:", {
      error: err?.message || String(err),
    });

    return [];
  }
}

async function findTextareaCandidateByLocator(page) {
  const textareaLocator = page.locator("textarea");

  if (!textareaLocator || typeof textareaLocator.count !== "function") {
    return null;
  }

  let count = 0;

  try {
    count = await textareaLocator.count();
  } catch {
    return null;
  }

  if (!count) {
    return null;
  }

  /*
    Fallback when evaluateAll is not available:
    - inspect up to 20 visible textareas
    - score their accessible attributes if available
    - otherwise choose the first usable textarea
  */
  const maxToInspect = Math.min(count, 20);

  let best = null;

  for (let idx = 0; idx < maxToInspect; idx += 1) {
    const loc = textareaLocator.nth(idx);

    let visible = true;
    let disabled = false;
    let placeholder = "";
    let aria = "";
    let name = "";
    let id = "";

    try {
      if (typeof loc.isVisible === "function") {
        visible = await loc.isVisible().catch(() => false);
      }
    } catch {
      visible = false;
    }

    if (!visible) {
      continue;
    }

    try {
      if (typeof loc.isDisabled === "function") {
        disabled = await loc.isDisabled().catch(() => false);
      }
    } catch {
      disabled = false;
    }

    if (disabled) {
      continue;
    }

    try {
      if (typeof loc.getAttribute === "function") {
        placeholder = (await loc.getAttribute("placeholder")) || "";
        aria = (await loc.getAttribute("aria-label")) || "";
        name = (await loc.getAttribute("name")) || "";
        id = (await loc.getAttribute("id")) || "";
      }
    } catch {}

    const haystack = `${name} ${id} ${placeholder} ${aria}`;
    let score = 0;

    if (MESSAGE_REGEX.test(haystack)) score += 5;
    if (HONEYPOT_REGEX.test(haystack)) score -= 20;

    const candidate = {
      idx,
      selector: `textarea >> nth=${idx}`,
      score,
      visible,
      name,
      id,
      placeholder,
      labelText: "",
    };

    if (!best || candidate.score > best.score) {
      best = candidate;
    }
  }

  return best;
}

async function lockPrefilledTextarea(locator) {
  if (!locator || typeof locator.evaluate !== "function") {
    return false;
  }

  try {
    return await locator.evaluate((el) => {
      try {
        el.setAttribute("data-lovable-prefilled", "1");
        el.readOnly = true;

        if (typeof el.blur === "function") {
          el.blur();
        }

        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

async function prefillMessageTextarea(page, message, messageParagraphs) {
  if (!message) {
    return {
      filled: false,
      locked: false,
      selector: null,
      reason: "no_message",
      verifiedLength: 0,
      usedFallback: false,
      candidates: [],
    };
  }

  const waitForAnyTextarea = async (timeout) => {
    try {
      await page.waitForSelector("textarea", {
        timeout,
        state: "visible",
      });

      return true;
    } catch {
      return false;
    }
  };

  let found = await waitForAnyTextarea(8000);

  if (!found) {
    try {
      const contactLink = page
        .getByRole("link", {
          name: /contact|reach us|inquire|appointment|consultation|get in touch/i,
        })
        .first();

      if (contactLink && typeof contactLink.count === "function") {
        const count = await contactLink.count();

        if (count > 0) {
          await contactLink.click({ timeout: 5000 }).catch(() => {});
          await page.waitForLoadState("domcontentloaded").catch(() => {});
        }
      }
    } catch {}

    found = await waitForAnyTextarea(8000);
  }

  if (!found) {
    return {
      filled: false,
      locked: false,
      selector: null,
      reason: "no_textarea",
      verifiedLength: 0,
      usedFallback: false,
      candidates: [],
    };
  }

  let candidates = await findTextareaCandidates(page);

  let best = candidates
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)[0];

  /*
    If Stagehand does not support locator.evaluateAll(), use a safe locator
    fallback. This fixes the `page.$$eval is not a function` crash.
  */
  if (!best) {
    const fallbackCandidate = await findTextareaCandidateByLocator(page);

    if (fallbackCandidate) {
      best = fallbackCandidate;

      if (!candidates.length) {
        candidates = [fallbackCandidate];
      }
    }
  }

  if (!best) {
    return {
      filled: false,
      locked: false,
      selector: null,
      reason: "no_matching_textarea",
      verifiedLength: 0,
      usedFallback: false,
      candidates,
    };
  }

  const locator =
    best.selector && best.selector.startsWith("textarea")
      ? page.locator(best.selector).first()
      : page.locator("textarea").nth(best.idx || 0);

  let existingValue = "";

  try {
    if (locator && typeof locator.inputValue === "function") {
      existingValue = await locator.inputValue().catch(() => "");
    }
  } catch {}

  /*
    This protects a message that a prior harness step already filled.
    Never clear or overwrite a matching existing message.
  */
  if (
    existingValue &&
    normalizeText(existingValue).length >= Math.min(20, normalizeText(message).length)
  ) {
    const locked = await lockPrefilledTextarea(locator);

    return {
      filled: true,
      locked,
      selector: best.selector,
      reason: "already_prefilled",
      verifiedLength: existingValue.length,
      usedFallback: false,
      candidates,
    };
  }

  let filled = false;
  let usedFallback = false;
  let reason = "unknown";
  let verifiedLength = 0;

  try {
    await locator.scrollIntoViewIfNeeded?.({ timeout: 3000 }).catch(() => {});
    await locator.click?.({ timeout: 3000 }).catch(() => {});

    /*
      Normal locator.fill() is preferred because it preserves newlines in a
      textarea without relying on character-by-character typing.
    */
    if (typeof locator.fill !== "function") {
      throw new Error("locator.fill is not available on this Stagehand page");
    }

    await locator.fill("", { timeout: 3000 }).catch(() => {});
    await locator.fill(message, { timeout: 8000 });

    const got = await locator.inputValue?.().catch(() => "");
    verifiedLength = got?.length || 0;

    if (
      got &&
      normalizeText(got).length >= Math.min(20, normalizeText(message).length)
    ) {
      filled = true;
      reason = "fill_ok";
    } else {
      usedFallback = true;

      await locator.fill("").catch(() => {});
      await locator.click?.({ timeout: 3000 }).catch(() => {});

      const paragraphs =
        Array.isArray(messageParagraphs) && messageParagraphs.length
          ? messageParagraphs
          : String(message).split(/\n{2,}/g);

      for (
        let paragraphIndex = 0;
        paragraphIndex < paragraphs.length;
        paragraphIndex += 1
      ) {
        const lines = String(paragraphs[paragraphIndex]).split("\n");

        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          if (typeof locator.pressSequentially !== "function") {
            throw new Error(
              "locator.pressSequentially is not available for fallback message filling",
            );
          }

          await locator.pressSequentially(lines[lineIndex], { delay: 5 });

          if (lineIndex < lines.length - 1) {
            await page.keyboard.press("Shift+Enter");
          }
        }

        if (paragraphIndex < paragraphs.length - 1) {
          await page.keyboard.press("Enter");
          await page.keyboard.press("Enter");
        }
      }

      const gotAfterFallback = await locator.inputValue?.().catch(() => "");
      verifiedLength = gotAfterFallback?.length || 0;
      filled = Boolean(gotAfterFallback?.length);

      reason = filled
        ? "sequential_ok"
        : "fill_and_sequential_failed";
    }
  } catch (err) {
    return {
      filled: false,
      locked: false,
      selector: best.selector,
      reason: `fill_error: ${err?.message || String(err)}`,
      verifiedLength,
      usedFallback,
      candidates,
    };
  }

  const locked = filled ? await lockPrefilledTextarea(locator) : false;

  return {
    filled,
    locked,
    selector: best.selector,
    reason,
    verifiedLength,
    usedFallback,
    candidates,
  };
}

function agentResultToText(agentResult) {
  if (agentResult == null) {
    return "";
  }

  if (typeof agentResult === "string") {
    return agentResult;
  }

  if (typeof agentResult !== "object") {
    return String(agentResult);
  }

  /*
    Prefer concise result-style properties. We intentionally do not inspect
    transcript/history fields, because those often include the prompt itself.
  */
  const preferredKeys = [
    "final",
    "output",
    "text",
    "message",
    "completion",
    "content",
    "result",
  ];

  for (const key of preferredKeys) {
    const value = agentResult[key];

    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  try {
    return JSON.stringify(agentResult);
  } catch {
    return String(agentResult);
  }
}

/*
  Trust only a standalone OUTCOME line near the END of the direct agent result.

  This prevents a false success where the parser sees the literal sample
  `OUTCOME: CONFIRMED` inside the prompt/instructions/diagnostics.
*/
function parseTrustedOutcome(agentText) {
  const text = String(agentText || "").trim();

  if (!text) {
    return {
      outcome: undefined,
      excerpt: null,
      matchedLine: null,
    };
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const candidateLines = lines.slice(-10).reverse();

  for (const line of candidateLines) {
    const match = line.match(
      /^OUTCOME:\s*(CONFIRMED|CAPTCHA_BLOCKED|NO_CONFIRMATION|ERROR)\s*(?:—|--|:|-)?\s*(.*)$/i,
    );

    if (!match) {
      continue;
    }

    return {
      outcome: match[1].toLowerCase(),
      excerpt: (match[2] || "").trim().slice(0, 300) || null,
      matchedLine: line,
    };
  }

  return {
    outcome: undefined,
    excerpt: null,
    matchedLine: null,
  };
}

function buildExtraction(result) {
  const agentFinalText = agentResultToText(result?.result?.agentResult);

  const parts = [];

  if (agentFinalText) {
    parts.push(`[agent_final_result]\n${agentFinalText}`);
  }

  if (result?.result?.pageText) {
    parts.push(`[final_page_text]\n${result.result.pageText}`);
  }

  if (result?.result?.finalUrl) {
    parts.push(`[final_url]\n${result.result.finalUrl}`);
  }

  if (result?.result?.prefill) {
    parts.push(
      `[prefill]\n${safeStringify({
        filled: result.result.prefill.filled,
        locked: result.result.prefill.locked,
        selector: result.result.prefill.selector,
        reason: result.result.prefill.reason,
        verifiedLength: result.result.prefill.verifiedLength,
        usedFallback: result.result.prefill.usedFallback,
      })}`,
    );
  }

  if (result?.error) {
    parts.push(`[run_error]\n${result.error}`);
  }

  return parts.join("\n\n").trim();
}

async function runStagehand({
  url,
  instructions,
  message,
  message_paragraphs,
}) {
  let stagehand;

  try {
    stagehand = new Stagehand({
      env: "BROWSERBASE",
    });

    await stagehand.init();

    const page = stagehand.context.pages()[0];
    const targetUrl = url || "https://example.com";

    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
    });

    const prefill = await prefillMessageTextarea(
      page,
      message,
      message_paragraphs,
    );

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
        ? `The message/comments/inquiry textarea is ALREADY FILLED and LOCKED by the automation harness (selector: "${prefill.selector}"). Do NOT navigate to the current URL, refresh the page, click the message field, focus it, clear it, retype it, or edit it. The existing message must remain unchanged. Fill only the other fields and then submit.`
        : prefill.filled
          ? `The message textarea is ALREADY FILLED by the automation harness (selector: "${prefill.selector}"). Do NOT navigate to the current URL, refresh the page, click it, clear it, retype it, or edit it. Fill only the other fields and submit.`
          : `The message textarea could not be prefilled automatically (reason: ${prefill.reason}). Youu must locate the correct textarea and insert the entire message in a single operation (e.g. using fill/paste), NOT by typing character-by-character, unless a prior attempt to fill/paste fails, then complete and submit the form.`;
		  

    const wrappedInstruction = `
You are a browser automation agent controlling a real browser.

Your job is to fill out and SUBMIT the contact form on this page.

${messageNote}

HARD RULES:
- Do NOT call page.goto(), navigate to the current page URL, refresh the page, or reopen the current URL.
- Do not leave the page unless a genuine form workflow requires a different page after submission.
- Fill every required field before submitting.
- Click the actual submit/send/request-appointment button.
- After clicking submit, wait at least 5 seconds and observe the page.
- A click is NOT proof of successful submission.
- Report CONFIRMED only when visible evidence appears, such as a thank-you message, a success notice, a confirmation page, a confirmation block replacing the form, or a URL clearly indicating thank/success/sent/received/confirmed.
- If validation fails, the form remains visible, required data is missing, submission is blocked, or there is no visible success evidence, report NO_CONFIRMATION or ERROR.
- Your final non-empty line must be exactly one of:
  OUTCOME: CONFIRMED — <first 200 characters of visible confirmation>
  OUTCOME: CAPTCHA_BLOCKED — <captcha type>
  OUTCOME: NO_CONFIRMATION — <what the page showed after the submit attempt>
  OUTCOME: ERROR — <what went wrong>

Original task:
${instructions}
`.trim();

    const agent = stagehand.agent({
      model: "anthropic/claude-sonnet-4-6",
    });

    const agentResult = await agent.execute({
      instruction: wrappedInstruction,
      maxSteps: 40,
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
        prefill,
        liveSessionUrl: `https://browserbase.com/sessions/${stagehand.browserbaseSessionID}`,
      },
      error: null,
    };
  } catch (err) {
    console.error("[stagehand] Error in runStagehand:", err);

    return {
      success: false,
      result: null,
      error: err?.message || "Unknown error",
    };
  } finally {
    if (stagehand) {
      try {
        await stagehand.close();
      } catch (err) {
        console.error("[stagehand] failed to close browser session:", err);
      }
    }
  }
}

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
    return res.status(400).json({
      accepted: false,
      error: "Missing 'instructions'",
    });
  }

  /*
    Respond right away so the calling service can track the asynchronous job.
  */
  res.json({
    accepted: true,
    job_id,
  });

  let result;

  try {
    result = await Promise.race([
      runStagehand({
        url,
        instructions,
        message,
        message_paragraphs,
      }),
      new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            success: false,
            result: null,
            error: "render_hard_timeout_4min",
          });
        }, HARD_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    result = {
      success: false,
      result: null,
      error: err?.message || "unknown_error",
    };
  }

  if (!callback_url) {
    return;
  }

  /*
    IMPORTANT:
    Parse only the direct final agent result, NOT the combined extraction.
    The extraction includes prompts and diagnostics, which may contain the
    literal words `OUTCOME: CONFIRMED` without a real submission occurring.
  */
  const agentFinalText = agentResultToText(result?.result?.agentResult);

  const {
    outcome: trustedOutcome,
    excerpt,
    matchedLine,
  } = parseTrustedOutcome(agentFinalText);

  const extraction = buildExtraction(result);

  /*
    Fail closed:
    success is true only if a trusted final agent outcome explicitly confirms
    visible submission evidence.
  */
  const callbackSuccess = trustedOutcome === "confirmed";

  const outcome =
    trustedOutcome ||
    (result.success ? "no_confirmation" : "error");

  const confirmationExcerpt =
    excerpt ||
    (result.error
      ? String(result.error).slice(0, 300)
      : trustedOutcome
        ? null
        : "No trusted final agent outcome was found.");

  console.log("[stagehand] run finished", {
    job_id,
    stagehandRunSuccess: result.success,
    callbackSuccess,
    outcome,
    trustedOutcome,
    matchedLine,
    error: result.error,
    prefill_filled: result.result?.prefill?.filled,
    prefill_locked: result.result?.prefill?.locked,
  });

  try {
    const callbackResponse = await fetch(callback_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-stagehand-secret":
          shared_secret ||
          process.env.STAGEHAND_SHARED_SECRET ||
          "",
      },
      body: JSON.stringify({
        job_id,

        /*
          This is the important value for your application:
          true only after trusted CONFIRMED output.
        */
        success: callbackSuccess,

        outcome,
        confirmation_excerpt: confirmationExcerpt,

        /*
          Useful debugging fields. They help you identify whether the model
          generated a valid final result, without parsing a noisy transcript.
        */
        internal_outcome: trustedOutcome || null,
        trusted_outcome_line: matchedLine || null,
        agent_final_text: agentFinalText || null,

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

    console.log("[stagehand] callback POST", {
      job_id,
      status: callbackResponse.status,
      ok: callbackResponse.ok,
    });
  } catch (err) {
    console.error("[stagehand] callback POST failed:", err);
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Stagehand service listening on port ${PORT}`);
});
