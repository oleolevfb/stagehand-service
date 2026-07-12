require("dotenv").config();

const express = require("express");
const { Stagehand } = require("@browserbasehq/stagehand");

const app = express();

app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => {
  res.send("Stagehand service is running");
});

const PORT = process.env.PORT || 3000;
const HARD_TIMEOUT_MS = 4 * 60 * 1000;

const INITIAL_WAIT_MS = 8000;
const PREPARE_WAIT_MS = 6000;

const EDITABLE_SELECTOR = [
  "textarea",
  "[contenteditable='true']",
  "[role='textbox']",
  ".ProseMirror",
  ".ql-editor",
  ".public-DraftEditor-content",
  "[data-lexical-editor='true']",
].join(", ");

const MESSAGE_REGEX =
  /message|comments?|inquir(?:y|ies)|questions?|details|notes|tell us|how can we help|your\s*message|additional\s*(?:info|information)|describe|reason\s*(?:for|of)|anything\s*else|enquiry/i;

const HONEYPOT_REGEX =
  /honeypot|url2|trap|bot|website\b|company_website|confirm_email|email_confirm/i;

const CONTACT_LINK_REGEX =
  /contact|reach us|inquir|appointment|consultation|get in touch|request|book/i;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function trimText(value, max = 1600) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

async function waitForEditableControls(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const count = await page.locator(EDITABLE_SELECTOR).count();
      if (count > 0) return true;
    } catch {}

    try {
      const deepCount = await page.deepLocator(EDITABLE_SELECTOR).count();
      if (deepCount > 0) return true;
    } catch {}

    await sleep(400);
  }

  return false;
}

async function clickLikelyContactLink(page) {
  try {
    const contactLink = page
      .getByRole("link", { name: CONTACT_LINK_REGEX })
      .first();

    if (!(await contactLink.count())) return false;

    await contactLink.click({ timeout: 5000 }).catch(() => {});
    await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
    await sleep(1000);

    return true;
  } catch {
    return false;
  }
}

async function inspectMainDocumentFields(page) {
  try {
    const fields = await page.evaluate(
      ({ selector, messageRegexSource, honeypotRegexSource }) => {
        const messageRe = new RegExp(messageRegexSource, "i");
        const honeypotRe = new RegExp(honeypotRegexSource, "i");

        return [...document.querySelectorAll(selector)].map((el, index) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();

          const visible =
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.opacity !== "0" &&
            rect.width > 0 &&
            rect.height > 0;

          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute("role") || "";
          const id = el.getAttribute("id") || "";
          const name = el.getAttribute("name") || "";
          const placeholder = el.getAttribute("placeholder") || "";
          const ariaLabel = el.getAttribute("aria-label") || "";
          const ariaDescribedBy = el.getAttribute("aria-describedby") || "";

          const disabled =
            Boolean(el.disabled) ||
            el.getAttribute("aria-disabled") === "true";

          const readOnly =
            Boolean(el.readOnly) ||
            el.getAttribute("aria-readonly") === "true";

          let labelText = "";

          if (id) {
            const explicitLabel = document.querySelector(
              `label[for="${CSS.escape(id)}"]`,
            );
            if (explicitLabel) labelText = explicitLabel.textContent || "";
          }

          if (!labelText) {
            const wrappingLabel = el.closest("label");
            if (wrappingLabel) labelText = wrappingLabel.textContent || "";
          }

          let describedByText = "";
          for (const describedId of ariaDescribedBy.split(/\s+/).filter(Boolean)) {
            const description = document.getElementById(describedId);
            if (description) {
              describedByText += ` ${description.textContent || ""}`;
            }
          }

          const fieldContainer = el.closest(
            ".gfield, .form-group, .field, .field-wrap, .form-field, .hs-form-field, .wpcf7-form-control-wrap, li, p, fieldset, [data-field]",
          );

          const nearbyText =
            fieldContainer?.innerText ||
            el.parentElement?.innerText ||
            "";

          const context = [
            name,
            id,
            placeholder,
            ariaLabel,
            describedByText,
            labelText,
            nearbyText,
            role,
          ]
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();

          const rows =
            Number.parseInt(el.getAttribute("rows") || "0", 10) || 0;

          let score = 0;

          if (tag === "textarea") score += 12;
          if (el.isContentEditable || role === "textbox") score += 8;
          if (messageRe.test(context)) score += 18;
          if (messageRe.test(labelText)) score += 7;
          if (messageRe.test(placeholder)) score += 5;
          if (messageRe.test(name) || messageRe.test(id)) score += 5;
          if (rect.height >= 80) score += 8;
          if (rows >= 3) score += 5;

          if (!visible) score -= 50;
          if (disabled || readOnly) score -= 50;
          if (honeypotRe.test(context)) score -= 50;

          const eligible =
            visible &&
            !disabled &&
            !readOnly &&
            !honeypotRe.test(context) &&
            (score >= 10 || tag === "textarea" || el.isContentEditable);

          return {
            index,
            tag,
            id,
            name,
            placeholder,
            ariaLabel,
            role,
            labelText: labelText.trim().slice(0, 400),
            context: context.slice(0, 1200),
            visible,
            disabled,
            readOnly,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            rows,
            score,
            eligible,
          };
        });
      },
      {
        selector: EDITABLE_SELECTOR,
        messageRegexSource: MESSAGE_REGEX.source,
        honeypotRegexSource: HONEYPOT_REGEX.source,
      },
    );

    return Array.isArray(fields) ? fields : [];
  } catch (err) {
    console.error("[stagehand] main-document field inspection failed:", err.message || err);
    return [];
  }
}

function chooseBestMainDocumentField(fields) {
  const eligible = fields
    .filter((field) => field.eligible)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.height !== a.height) return b.height - a.height;
      return a.index - b.index;
    });

  if (!eligible.length) {
    return {
      field: null,
      reason: "no_eligible_main_document_field",
      eligible,
    };
  }

  return {
    field: eligible[0],
    reason: "highest_scoring_main_document_field",
    eligible,
  };
}

async function tryFillLocator(locator, message, source) {
  const minLength = Math.min(20, String(message).length);

  try {
    await locator.scrollTo({ timeout: 5000 }).catch(() => {});
    await locator.fill(message, { timeout: 12_000 });

    const value = await locator.inputValue().catch(() => "");

    if (value.length >= minLength) {
      return {
        filled: true,
        method: source,
        verifiedLength: value.length,
      };
    }

    return {
      filled: false,
      method: source,
      verifiedLength: value.length,
      reason: "value_verification_failed",
    };
  } catch (err) {
    return {
      filled: false,
      method: source,
      verifiedLength: 0,
      reason: `fill_error: ${err.message || err}`,
    };
  }
}

async function lockMainDocumentField(page, index) {
  try {
    return await page.evaluate(
      ({ selector, index }) => {
        const element = document.querySelectorAll(selector)[index];

        if (!element) return false;

        try {
          element.setAttribute("data-lovable-prefilled", "1");

          if ("readOnly" in element) {
            element.readOnly = true;
          } else {
            element.setAttribute("contenteditable", "false");
            element.setAttribute("aria-readonly", "true");
          }

          if (typeof element.blur === "function") element.blur();

          return true;
        } catch {
          return false;
        }
      },
      { selector: EDITABLE_SELECTOR, index },
    );
  } catch {
    return false;
  }
}

async function fillMainDocumentMessage(page, message) {
  const fields = await inspectMainDocumentFields(page);
  const { field, reason, eligible } = chooseBestMainDocumentField(fields);

  if (!field) {
    return {
      filled: false,
      locked: false,
      source: "main_document",
      reason,
      eligibleCount: eligible.length,
      inventory: fields,
    };
  }

  const locator = page.locator(EDITABLE_SELECTOR).nth(field.index);

  const fillResult = await tryFillLocator(
    locator,
    message,
    "main_document_locator_fill",
  );

  if (!fillResult.filled) {
    return {
      ...fillResult,
      locked: false,
      source: "main_document",
      reason: fillResult.reason || reason,
      field,
      eligibleCount: eligible.length,
      inventory: fields,
    };
  }

  const locked = await lockMainDocumentField(page, field.index);

  return {
    ...fillResult,
    locked,
    source: "main_document",
    selectionReason: reason,
    field,
    eligibleCount: eligible.length,
    inventory: fields,
  };
}

async function fillDeepMessage(page, message) {
  const deepCandidates = [
    "textarea",
    "[contenteditable='true']",
    "[role='textbox']",
    ".ProseMirror",
    ".ql-editor",
    ".public-DraftEditor-content",
    "[data-lexical-editor='true']",
  ];

  const attempts = [];

  for (const selector of deepCandidates) {
    try {
      const locator = page.deepLocator(selector);
      const count = await locator.count().catch(() => 0);

      for (let index = 0; index < count; index++) {
        const field = locator.nth(index);
        const isVisible = await field.isVisible().catch(() => false);

        if (!isVisible) continue;

        const attempt = await tryFillLocator(
          field,
          message,
          `deep_locator_fill:${selector}:${index}`,
        );

        attempts.push({
          selector,
          index,
          visible: isVisible,
          ...attempt,
        });

        if (attempt.filled) {
          return {
            ...attempt,
            locked: false,
            source: "deep_locator",
            selectionReason: "cross_frame_or_shadow_dom_fallback",
            attempts,
          };
        }
      }
    } catch (err) {
      attempts.push({
        selector,
        filled: false,
        reason: `deep_locator_error: ${err.message || err}`,
      });
    }
  }

  return {
    filled: false,
    locked: false,
    source: "deep_locator",
    reason: "no_deep_locator_candidate_could_be_filled",
    attempts,
  };
}

async function directFillMessage(page, message, waitMs) {
  if (!message) {
    return {
      filled: false,
      locked: false,
      reason: "no_message",
    };
  }

  await waitForEditableControls(page, waitMs);

  const mainResult = await fillMainDocumentMessage(page, message);

  if (mainResult.filled) {
    return mainResult;
  }

  const deepResult = await fillDeepMessage(page, message);

  if (deepResult.filled) {
    return {
      ...deepResult,
      mainDocumentFailure: {
        reason: mainResult.reason,
        inventory: mainResult.inventory?.slice(0, 30),
      },
    };
  }

  return {
    filled: false,
    locked: false,
    reason: "all_deterministic_message_fill_strategies_failed",
    mainDocumentFailure: {
      reason: mainResult.reason,
      inventory: mainResult.inventory?.slice(0, 30),
    },
    deepLocatorFailure: deepResult,
  };
}

function parseOutcome(text) {
  if (!text) return { outcome: undefined, excerpt: null };

  const match = String(text).match(
    /OUTCOME:\s*(CONFIRMED|CAPTCHA_BLOCKED|READY_FOR_MESSAGE|NO_CONFIRMATION|ERROR)\s*[—:-]?\s*(.{0,500})?/i,
  );

  if (!match) {
    return { outcome: undefined, excerpt: null };
  }

  return {
    outcome: match[1].toLowerCase(),
    excerpt: (match[2] || "").trim().slice(0, 300) || null,
  };
}

function agentResultToText(agentResult) {
  if (!agentResult) return "";
  if (typeof agentResult === "string") return agentResult;

  return [
    agentResult.message,
    agentResult.result,
    agentResult.output,
    agentResult.text,
    agentResult.summary,
    safeStringify(agentResult),
  ]
    .filter(Boolean)
    .join("\n");
}

async function getFinalPageDetails(page) {
  let finalUrl = "";
  let pageText = "";

  try {
    finalUrl = page.url();
  } catch {}

  try {
    pageText = (await page.locator("body").innerText()).slice(0, 2500);
  } catch {}

  return { finalUrl, pageText };
}

async function runStagehand({
  url,
  instructions,
  message,
  message_paragraphs,
  allow_agent_message_typing = true,
}) {
  let stagehand;

  try {
    stagehand = new Stagehand({ env: "BROWSERBASE" });
    await stagehand.init();

    const page = stagehand.context.pages()[0];
    const targetUrl = url || "https://example.com";

    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await sleep(800);

    /*
      PHASE 1:
      Attempt a fast deterministic fill before the agent does anything.
    */
    const initialPrefill = await directFillMessage(
      page,
      message,
      INITIAL_WAIT_MS,
    );

    console.log("[stagehand] initial message fill", {
      filled: initialPrefill.filled,
      method: initialPrefill.method,
      source: initialPrefill.source,
      reason: initialPrefill.reason,
    });

    if (!initialPrefill.filled) {
      await clickLikelyContactLink(page);
    }

    const agent = stagehand.agent({
      model: "anthropic/claude-sonnet-4-6",
    });

    let preparationResult = null;
    let secondPrefill = null;
    let finalAgentResult = null;

    /*
      PHASE 2:
      Only when the initial fill fails, prepare the form without submitting.
      This is temporary: later branches ALWAYS submit.
    */
    if (message && !initialPrefill.filled) {
      preparationResult = await agent.execute({
        instruction: `
You are preparing a contact form in a real browser.

Your task:
- Navigate to the relevant contact, appointment, consultation, or inquiry form.
- Open required modals, accordions, tabs, or multi-step form panels.
- Fill all required SHORT fields from the original task, including name, email, phone, dropdowns, checkboxes, and subject when applicable.
- Leave the long message/comments/details/inquiry field untouched.
- Do NOT submit yet. A second automation step will fill the long message.

Stop only once the message field is visible and the rest of the form is ready.

On your FINAL line, print exactly:
OUTCOME: READY_FOR_MESSAGE — <label, placeholder, or description of the message field>
or:
OUTCOME: CAPTCHA_BLOCKED — <captcha type>
or:
OUTCOME: ERROR — <what prevented preparation>

Original task:
${instructions}
`.trim(),
        maxSteps: 28,
      });

      /*
        PHASE 3:
        Now the form should be fully open. Try direct fill again.
      */
      secondPrefill = await directFillMessage(
        page,
        message,
        PREPARE_WAIT_MS,
      );

      console.log("[stagehand] second message fill", {
        filled: secondPrefill.filled,
        method: secondPrefill.method,
        source: secondPrefill.source,
        reason: secondPrefill.reason,
      });
    }

    const successfulPrefill = initialPrefill.filled
      ? initialPrefill
      : secondPrefill?.filled
        ? secondPrefill
        : null;

    /*
      PHASE 4:
      Every normal path now submits the form.

      If direct prefill worked, agent submits only.
      If direct prefill failed, agent receives the message and completes/submits.
    */
    if (successfulPrefill) {
      finalAgentResult = await agent.execute({
        instruction: `
Complete and SUBMIT the contact form in the real browser.

The long message field has already been filled by the automation harness.
${successfulPrefill.locked
  ? "It is intentionally locked. Do NOT click, focus, clear, edit, or retype it."
  : "Do NOT clear, edit, or retype the existing message."}

Your task:
1. Verify all other required fields are completed.
2. Click the actual submit/send/request/appointment button.
3. Wait for the form to finish processing.
4. Inspect the resulting page, success message, redirect, or inline confirmation.
5. If a CAPTCHA is shown, wait briefly for configured browser handling. If it remains unresolved, report it.

On your FINAL line, print exactly one of:
OUTCOME: CONFIRMED — <first 200 chars of confirmation>
OUTCOME: CAPTCHA_BLOCKED — <captcha type>
OUTCOME: NO_CONFIRMATION — <what the page showed after submit>
OUTCOME: ERROR — <what went wrong>
`.trim(),
        maxSteps: 20,
      });
    } else if (message && allow_agent_message_typing) {
      /*
        This is now the DEFAULT fallback.

        The agent receives the message only after both deterministic fill attempts
        fail. It is explicitly instructed to complete and submit the form.
      */
      finalAgentResult = await agent.execute({
        instruction: `
Complete and SUBMIT the contact form in the real browser.

The automation harness could not reliably identify or directly fill the long
message field. You must now finish the task yourself:

1. Locate the message/comments/details/inquiry field.
2. Enter the message below exactly, preserving paragraph breaks.
3. Fill any remaining required fields from the original task.
4. Click the actual submit/send/request/appointment button.
5. Wait for and inspect the confirmation, redirect, or inline success state.

Use a direct browser fill/set-value action for the message whenever available.
Do NOT use character-by-character typing unless the website rejects direct fill.

MESSAGE TO ENTER VERBATIM:
---BEGIN MESSAGE---
${message}
---END MESSAGE---

Original task:
${instructions}

On your FINAL line, print exactly one of:
OUTCOME: CONFIRMED — <first 200 chars of confirmation>
OUTCOME: CAPTCHA_BLOCKED — <captcha type>
OUTCOME: NO_CONFIRMATION — <what the page showed after submit>
OUTCOME: ERROR — <what went wrong>
`.trim(),
        maxSteps: 35,
      });
    } else {
      /*
        This can only happen when no message exists or agent fallback has been
        deliberately disabled in the request.
      */
      finalAgentResult = {
        outcome: "ERROR",
        message:
          "Message prefill failed and agent message fallback is disabled or no message was provided.",
      };
    }

    const { finalUrl, pageText } = await getFinalPageDetails(page);

    return {
      success: true,
      result: {
        message: "Stagehand workflow finished",
        instructionsReceived: instructions,
        urlVisited: targetUrl,
        finalUrl,
        pageText,
        agentResult: finalAgentResult,
        preparationResult,
        initialPrefill,
        secondPrefill,
        messagePrefill: successfulPrefill,
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
      } catch (err) {
        console.error("Stagehand close failed:", err);
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
    allow_agent_message_typing = true,
  } = req.body || {};

  if (!instructions) {
    return res.status(400).json({
      accepted: false,
      error: "Missing 'instructions'",
    });
  }

  res.json({ accepted: true, job_id });

  let result;

  try {
    result = await Promise.race([
      runStagehand({
        url,
        instructions,
        message,
        message_paragraphs,
        allow_agent_message_typing,
      }),
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              success: false,
              result: null,
              error: "render_hard_timeout_4min",
            }),
          HARD_TIMEOUT_MS,
        ),
      ),
    ]);
  } catch (err) {
    result = {
      success: false,
      result: null,
      error: err.message || "unknown_error",
    };
  }

  if (!callback_url) return;

  let extraction = "";

  if (result.result?.agentResult) {
    extraction += agentResultToText(result.result.agentResult);
  }

  if (result.result?.preparationResult) {
    extraction += `\n\n[preparation_result]\n${agentResultToText(
      result.result.preparationResult,
    )}`;
  }

  if (result.result?.pageText) {
    extraction += `\n\n[final_page_text]\n${result.result.pageText}`;
  }

  if (result.result?.finalUrl) {
    extraction += `\n\n[final_url] ${result.result.finalUrl}`;
  }

  for (const key of ["initialPrefill", "secondPrefill", "messagePrefill"]) {
    const prefill = result.result?.[key];
    if (!prefill) continue;

    extraction += `\n\n[${key}]\n${safeStringify({
      filled: prefill.filled,
      locked: prefill.locked,
      method: prefill.method,
      source: prefill.source,
      reason: prefill.reason,
      selectionReason: prefill.selectionReason,
      verifiedLength: prefill.verifiedLength,
      field: prefill.field,
      inventory: prefill.inventory?.slice(0, 30),
      attempts: prefill.attempts?.slice(0, 20),
    })}`;
  }

  const { outcome, excerpt } = parseOutcome(extraction);
  const messagePrefill = result.result?.messagePrefill || null;

  const success =
    outcome === "confirmed" ||
    (outcome === undefined && result.success);

  console.log("[stagehand] run finished", {
    job_id,
    success,
    outcome,
    error: result.error,
    messageFilled: messagePrefill?.filled || false,
    messageMethod: messagePrefill?.method || null,
  });

  try {
    const callbackResponse = await fetch(callback_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-stagehand-secret":
          shared_secret || process.env.STAGEHAND_SHARED_SECRET || "",
      },
      body: JSON.stringify({
        job_id,
        success,
        outcome,
        confirmation_excerpt: excerpt,
        extraction,
        messagePrefill,
        initialPrefill: result.result?.initialPrefill || null,
        secondPrefill: result.result?.secondPrefill || null,
        liveSessionUrl: result.result?.liveSessionUrl || null,
        result: result.result,
        error: result.error || null,
      }),
    });

    console.log("[stagehand] callback POST", {
      job_id,
      status: callbackResponse.status,
      ok: callbackResponse.ok,
    });
  } catch (err) {
    console.error("Callback POST failed:", err);
  }
});

app.listen(PORT, () => {
  console.log(`Stagehand service listening on port ${PORT}`);
});
