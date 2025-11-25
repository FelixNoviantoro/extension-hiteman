let isRecording = false;
let recordedData = [];
let inputBuffer = {}; // Untuk menyimpan input sementara
let observer = null; // Untuk mutation observer
let isTargetPage = false; // Flag untuk menandai halaman target
let currentOverlay = null;
let currentTooltip = null;
let lastClickedElement = null;

// Helper: convert a recorded absolute URL into a simple pattern Playwright can wait for.
// Prefer the last path/fragment segment so patterns look like '**/retribusi'.
function urlToPattern(u) {
  try {
    const parsed = new URL(u);
    let route = '';
    if (parsed.hash && parsed.hash.length > 1) {
      route = parsed.hash.slice(1); // remove leading '#'
    } else {
      route = parsed.pathname || '';
    }
    const parts = route.split('/').filter(Boolean);
    if (parts.length > 0) {
      return `**/${parts[parts.length - 1]}`;
    }
    return u;
  } catch (err) {
    return u;
  }
}

// Helper: Sisipkan langkah wait ketika pageUrl berubah antar langkah 
// DAN tambahkan wait setelah goto untuk memastikan elemen siap
function transformStepsForExport(rawSteps) {
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) return [];

  const out = [];
  const actionsWithFallback = new Set(['click', 'fill', 'check', 'selectOption']);

  for (let i = 0; i < rawSteps.length; i++) {
    const step = rawSteps[i];
    const nextStep = rawSteps[i + 1];

    // Add the original step
    out.push(step);

    // 🚨 KEY FIX: Auto-add waitForSelector after goto if next step needs an element
    if (step.action === 'goto' && nextStep && nextStep.selector &&
      ['click', 'fill', 'check', 'selectOption'].includes(nextStep.action)) {

      console.log(`[Extension] Auto-inserting wait after goto: ${nextStep.selector}`);

      // Short wait for framework initialization (Angular/React)
      out.push({
        action: 'waitForTimeout',
        timeout: 500,
        _metadata: {
          inserted: true,
          purpose: 'framework-initialization'
        }
      });

      // Wait for the specific element
      out.push({
        action: 'waitForSelector',
        selector: nextStep.selector,
        _metadata: {
          inserted: true,
          purpose: 'auto-wait-after-navigation'
        }
      });
    }

    // 🚨 FIX: DON'T add evaluate fallback for every action immediately
    // The execution engine should handle fallbacks conditionally

    try {
      const curUrl = step && step._metadata && step._metadata.pageUrl;
      const nextUrl = nextStep && nextStep._metadata && nextStep._metadata.pageUrl;

      if (nextStep && curUrl && nextUrl && curUrl !== nextUrl) {
        // Insert an explicit goto to ensure exported scripts navigate to the correct URL when the recorded page changes.
        out.push({
          action: 'goto',
          url: nextUrl,
          _metadata: {
            inserted: true,
            pageUrl: nextUrl
          }
        });

        // navigation: do not insert automatic waitForLoadState; rely on selector-based waits or explicit navigation
        if (nextStep.selector) {
          out.push({
            action: 'waitForSelector',
            selector: nextStep.selector,
            _metadata: {
              inserted: true
            }
          });

          out.push({
            action: 'expectVisible',
            selector: nextStep.selector,
            _metadata: {
              inserted: true
            }
          });

          // 🚨 FIX: DON'T add evaluate fallback here either
          // The execution engine should handle fallbacks conditionally
        } else {
          // no selector for next step — do not insert waitForLoadState automatically
        }
      }
    } catch (err) {
      // ignore errors and continue
    }
  }

  // Remove consecutive identical actions to avoid duplicate steps
  const deduped = [];
  for (let i = 0; i < out.length; i++) {
    const cur = out[i];
    const prev = deduped.length ? deduped[deduped.length - 1] : null;
    if (!isSameAction(prev, cur)) {
      deduped.push(cur);
    } else {
      // merge metadata if available to preserve additional flags
      try {
        if (prev && cur && cur._metadata) {
          prev._metadata = Object.assign({}, prev._metadata || {}, cur._metadata || {});
        }
      } catch (err) {
        // ignore merge errors
      }
    }
  }

  return deduped;
}

// Helper to compare two actions for identity (used to remove duplicates)
function isSameAction(a, b) {
  if (!a || !b) return false;
  if (a.action !== b.action) return false;
  // compare selector/url/value/state fields which commonly define the action
  const aSel = a.selector || '';
  const bSel = b.selector || '';
  if (aSel !== bSel) return false;

  const aVal = (a.value !== undefined) ? String(a.value) : '';
  const bVal = (b.value !== undefined) ? String(b.value) : '';
  if (aVal !== bVal) return false;

  const aUrl = a.url || '';
  const bUrl = b.url || '';
  if (aUrl !== bUrl) return false;

  const aState = a.state || '';
  const bState = b.state || '';
  if (aState !== bState) return false;

  return true;
}

// Helper: Buat evaluate fallback untuk berbagai jenis action (using value field)
function createEvaluateFallback(step) {
  const selector = step.selector;
  let expression = '';

  switch (step.action) {
    case 'click':
      expression = `document.querySelector('${selector}')?.click();`;
      break;

    case 'fill':
      const escapedValue = (step.value || '').replace(/'/g, "\\'");
      expression = `const el=document.querySelector('${selector}');if(el){el.value='${escapedValue}';el.dispatchEvent(new Event('input',{bubbles:true}));}`;
      break;

    case 'check':
      expression = `const el=document.querySelector('${selector}');if(el){el.checked=true;el.dispatchEvent(new Event('change',{bubbles:true}));}`;
      break;

    case 'selectOption':
      const escapedOptionValue = (step.value || '').replace(/'/g, "\\'");
      expression = `const el=document.querySelector('${selector}');if(el){el.value='${escapedOptionValue}';el.dispatchEvent(new Event('change',{bubbles:true}));}`;
      break;

    default:
      expression = `console.log('Fallback for ${step.action}');`;
  }

  // Return evaluate step with expression stored in VALUE field
  return {
    action: 'evaluate',
    selector: step.selector,
    value: expression, // Store expression in the existing 'value' field
    _metadata: {
      ...step._metadata,
      inserted: true,
      isFallback: true,
      originalAction: step.action,
      originalSelector: step.selector,
      purpose: 'fallback'
    }
  };
}

// Modifikasi bagian check recording state
chrome.storage.local.get(["isRecording", "recordedData"], (result) => {
  if (result.isRecording) {
    isRecording = true;
    recordedData = result.recordedData || [];
    isTargetPage = true;

    // Restore the control panel
    addControlPanel();
    startRecording();
  }
});

// Terima pesan dari popup/background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "startRecording") {
    isTargetPage = true;
    isRecording = true;
    recordedData = [];

    // Save recording state
    chrome.storage.local.set({
      isRecording: true,
      recordedData: recordedData,
    });

    // Tambahkan step "Open" sebagai langkah pertama
    recordAction("open", document.body, {
      command: "open",
      value: window.location.href,
    });

    // Kirim status recording dimulai ke background
    chrome.runtime.sendMessage(
      {
        action: "startRecording",
      },
      (response) => {
        if (chrome.runtime.lastError) {
          console.log("Background script error:", chrome.runtime.lastError);
        }
        addControlPanel();
        startRecording();
        sendResponse({ status: "Recording started" });
      }
    );
    return true; // Indicate async response
  } else if (message.action === "resetStorage") {
    sessionStorage.clear();
    sendResponse({ status: "Storage cleared" });
  } else if (message.action === "stopAndDownload") {
    isRecording = false;

    // Clear recording state
    chrome.storage.local.set({
      isRecording: false,
      recordedData: [],
    });

    stopRecording();
    // Kirim data rekaman
    sendResponse({
      status: "Recording stopped",
      data: recordedData,
    });
  } else if (message.action === "RESTORE_RECORDING") {
    // Handle restore recording from background script
    const status = message.data;
    if (status && status.type === "RECORDING_STARTED") {
      isRecording = true;
      isTargetPage = true;
      addControlPanel();
      startRecording();
    }
    sendResponse({ status: "Restored" });
  }

  // Don't return true unless we're actually doing async work
});

// Fungsi untuk menambahkan control panel
function addControlPanel() {
  // Hapus control panel yang mungkin sudah ada sebelumnya
  removeControlPanel();

  // Hanya tambahkan control panel jika ini adalah halaman target
  if (!isTargetPage) return;

  const controls = document.createElement("div");
  controls.className = "recorder-controls";
  controls.innerHTML = `
    <div class="recorder-handle"></div>
    <button class="stop-btn" id="stopBtn">Stop Recording</button>
    <button class="download-btn" id="downloadBtn" style="display: none;">Download JSON</button>
    <button class="download-script-btn" id="downloadScriptBtn" style="display: none;">Download Script</button>
    <button class="exit-btn" id="exitBtn" style="display: none;">Exit</button>
    <div id="recorder-status" class="recorder-status recording">Recording...</div>
  `;
  document.body.appendChild(controls);
  // Ensure the control container accepts pointer events
  controls.style.pointerEvents = 'auto';

  // Tambah fungsi drag
  let isDragging = false;
  let currentX;
  let currentY;
  let initialX;
  let initialY;
  let xOffset = 0;
  let yOffset = 0;

  const dragStart = (e) => {
    if (e.target.closest(".stop-btn")) return; // Jangan mulai drag jika klik button

    initialX =
      e.type === "mousedown"
        ? e.clientX - xOffset
        : e.touches[0].clientX - xOffset;
    initialY =
      e.type === "mousedown"
        ? e.clientY - yOffset
        : e.touches[0].clientY - yOffset;

    if (e.target === controls || e.target.closest(".recorder-handle")) {
      isDragging = true;
    }
  };

  const dragEnd = () => {
    isDragging = false;
  };

  const drag = (e) => {
    if (isDragging) {
      e.preventDefault();

      currentX =
        e.type === "mousemove"
          ? e.clientX - initialX
          : e.touches[0].clientX - initialX;
      currentY =
        e.type === "mousemove"
          ? e.clientY - initialY
          : e.touches[0].clientY - initialY;

      xOffset = currentX;
      yOffset = currentY;

      setTranslate(currentX, currentY, controls);
    }
  };

  const setTranslate = (xPos, yPos, el) => {
    // Pastikan panel tidak keluar dari viewport
    const rect = el.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width;
    const maxY = window.innerHeight - rect.height;

    xPos = Math.min(Math.max(0, xPos), maxX);
    yPos = Math.min(Math.max(0, yPos), maxY);

    el.style.transform = `translate3d(${xPos}px, ${yPos}px, 0)`;
  };

  // Event listeners untuk mouse
  controls.addEventListener("mousedown", dragStart);
  document.addEventListener("mousemove", drag);
  document.addEventListener("mouseup", dragEnd);

  // Event listeners untuk touch (mobile)
  controls.addEventListener("touchstart", dragStart);
  document.addEventListener("touchmove", drag);
  document.addEventListener("touchend", dragEnd);

  // Attach control buttons (use local references and defensive checks)
  const stopBtnEl = controls.querySelector('#stopBtn');
  const downloadBtnEl = controls.querySelector('#downloadBtn');
  const downloadScriptBtnEl = controls.querySelector('#downloadScriptBtn');
  const exitBtnEl = controls.querySelector('#exitBtn');

  // Diagnostics: log control panel and button presence
  try {
    console.log('[Recorder] control panel created', {
      top: controls.style.top,
      left: controls.style.left,
      zIndex: controls.style.zIndex,
    });
    console.log('[Recorder] control buttons presence', {
      stop: !!stopBtnEl,
      download: !!downloadBtnEl,
      downloadScript: !!downloadScriptBtnEl,
      exit: !!exitBtnEl,
    });
  } catch (err) {
    console.warn('[Recorder] diagnostics log failed', err);
  }

  if (stopBtnEl) {
    stopBtnEl.addEventListener('click', async () => {
      try {
        isRecording = false;
        stopRecording();

        // Transform recorded steps to include inserted waits before sending

        console.log('[Recorder] stopBtn clicked - recorded data before transform: ', recordedData);

        const stepsWithWaits = transformStepsForExport(recordedData || []);

        console.log('[Recorder] stopBtn clicked - transformed steps with waits: ', stepsWithWaits);

        const recordingData = {
          timestamp: new Date().toISOString(),
          data: stepsWithWaits,
          type: 'RECORDING_COMPLETED'
        };

        // Prepare playwright data with inserted waits (clean metadata)
        const playwrightData = {
          steps: stepsWithWaits.map(action => {
            const { _metadata, ...cleanAction } = action;
            return cleanAction;
          }),
          metadata: {
            timestamp: recordingData.timestamp,
            type: 'PLAYWRIGHT_RECORDING',
            generator: 'hiTeman Chrome Extension'
          }
        };

        // Simpan ke storage dan kirim ke background
        chrome.runtime.sendMessage({ action: 'RECORDING_COMPLETED', data: recordingData });

        // Kirim ke Angular app jika window.opener tersedia
        if (window.opener) {
          window.opener.postMessage({ type: 'RECORDING_COMPLETED', data: recordingData, playwrightData }, 'http://localhost:4200');
        }

        // Update UI
        stopBtnEl.style.display = 'none';
        if (downloadBtnEl) downloadBtnEl.style.display = 'block';
        if (downloadScriptBtnEl) downloadScriptBtnEl.style.display = 'block';
        if (exitBtnEl) exitBtnEl.style.display = 'block';
        const statusEl = document.querySelector('.recorder-status');
        if (statusEl) {
          statusEl.textContent = 'Recording completed';
          statusEl.classList.remove('recording');
        }
      } catch (err) {
        console.error('[Recorder] stopBtn handler error:', err);
      }
    });
  } else {
    console.warn('[Recorder] stopBtn element not found when adding listener');
  }

  // Diagnostics: log when listeners are attached
  try {
    if (stopBtnEl) console.log('[Recorder] attached stopBtn listener');
    if (downloadBtnEl) console.log('[Recorder] attached downloadBtn listener');
    if (downloadScriptBtnEl) console.log('[Recorder] attached downloadScriptBtn listener');
    if (exitBtnEl) console.log('[Recorder] found exitBtn element - will attach listeners');
  } catch (err) {
    console.warn('[Recorder] attach-log failed', err);
  }

  // Event listener untuk tombol download
  if (downloadBtnEl) {
    downloadBtnEl.addEventListener('click', () => {
      try {
        // Ensure button is interactable
        downloadBtnEl.style.pointerEvents = 'auto';
        const exported = transformStepsForExport(recordedData || []);
        console.log('[Recorder] downloadBtn clicked - sending DOWNLOAD_JSON with steps : ', exported);
        chrome.runtime.sendMessage({ action: 'DOWNLOAD_JSON', data: exported });
      } catch (err) {
        console.error('[Recorder] downloadBtn handler error:', err);
      }
    });
  }

  // Add lightweight pointer/mousedown listeners to capture early events and log them
  if (exitBtnEl) {
    try {
      exitBtnEl.addEventListener('pointerdown', (e) => {
        try { console.log('[Recorder] exitBtn pointerdown', { target: e.target, time: Date.now() }); } catch (err) { }
      }, true);
      exitBtnEl.addEventListener('mousedown', (e) => {
        try { console.log('[Recorder] exitBtn mousedown', { target: e.target, time: Date.now() }); } catch (err) { }
      }, true);
      console.log('[Recorder] attached pointer/mousedown diagnostics to exitBtn');
    } catch (err) {
      console.warn('[Recorder] failed to attach low-level diagnostics to exitBtn', err);
    }
  }

  // Event listener untuk tombol Download Script
  if (downloadScriptBtnEl) {
    downloadScriptBtnEl.addEventListener("click", async () => {
      // Ambil data rekaman terbaru dari chrome.storage.local
      chrome.storage.local.get(["recordedData"], (result) => {
        const rawSteps = result.recordedData || recordedData || [];
        const steps = transformStepsForExport(rawSteps);
        try {
          console.log('[Recorder] downloadScript: rawSteps length', rawSteps.length);
          console.log('[Recorder] downloadScript: transformed steps pageUrls', steps.map(s => (s && s._metadata && s._metadata.pageUrl) || null));
        } catch (err) {
          console.warn('[Recorder] downloadScript: failed to log steps', err);
        }
        const script = generatePlaywrightScriptFromSteps(steps);
        const blob = new Blob([script], { type: "text/javascript" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `playwright-script-${new Date().toISOString().replace(/[:.]/g, "-")}.js`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 100);
      });
    });
  }

  // Event listener untuk tombol exit
  if (exitBtnEl) {
    exitBtnEl.addEventListener('click', () => {
      try {
        console.log('[Recorder] exitBtn click handler - sending only EXIT_RECORDING');
        chrome.runtime.sendMessage({ action: 'EXIT_RECORDING' }, (resp) => {
          if (chrome.runtime.lastError) {
            console.error('[Recorder] EXIT_RECORDING sendMessage error:', chrome.runtime.lastError);
          } else {
            console.log('[Recorder] EXIT_RECORDING response from background:', resp);
          }
        });
      } catch (err) {
        console.error('[Recorder] exitBtn handler error when sending EXIT_RECORDING:', err);
      }
    });
  }

  // Helper: Konversi steps ke Playwright script
  function generatePlaywrightScriptFromSteps(steps) {
    // Helper to escape single quotes and backslashes for JS string literals
    function esc(s) {
      if (s === undefined || s === null) return "";
      return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '');
    }

    let script = `// Generated by hiTeman Chrome Extension\n`;
    script += `const { test, expect } = require('@playwright/test');\n\n`;
    script += `test('Recorded test', async ({ page }) => {\n`;
    script += `  try {\n`;

    try {
      console.log('[Recorder] generatePlaywrightScriptFromSteps: steps length', (steps && steps.length) || 0);
      console.log('[Recorder] generatePlaywrightScriptFromSteps: pageUrl sequence', (steps || []).map(s => (s && s._metadata && s._metadata.pageUrl) || null));
    } catch (err) {
      console.warn('[Recorder] generatePlaywrightScriptFromSteps: failed to log step metadata', err);
    }

    // Track current known page URL to detect implicit page changes.
    let currentUrl = (steps && steps.length > 0 && steps[0]._metadata && steps[0]._metadata.pageUrl) ? steps[0]._metadata.pageUrl : '';

    // 🚨 KEY FIX: Process steps with evaluate fallback detection
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const nextStep = steps[i + 1];
      const act = step.action || step.command;

      const stepUrl = step._metadata && step._metadata.pageUrl;

      // 🚨 KEY FIX: Skip evaluate steps that are processed as fallbacks
      if (act === 'evaluate' && step._metadata && step._metadata.isFallback) {
        console.log(`[Recorder] Skipping evaluate fallback step: ${step.selector}`);
        continue;
      }

      // If the recorded step's pageUrl changed compared to our currentUrl and
      // the navigation was NOT already caused by the previous step's click, then
      // emit an explicit goto to ensure the script is on the correct page.
      try {
        const prev = steps[i - 1];
        const prevCausedNav = prev && prev.action === 'click' && prev._metadata && prev._metadata.pageUrl && stepUrl && prev._metadata.pageUrl !== stepUrl;

        if (stepUrl && currentUrl && stepUrl !== currentUrl && !prevCausedNav && act !== 'goto' && act !== 'open') {
          // Navigation is handled explicitly by inserted `goto` steps in the
          // transformed recording. Skip implicit waits here.
          currentUrl = stepUrl;
        }
      } catch (err) {
        // ignore errors in URL handling
      }

      // Navigation / open explicit
      if (act === 'goto' || act === 'open') {
        const url = step.url || step.value || '';
        script += `    await page.goto('${esc(url)}');\n`;
        if (nextStep && nextStep.selector) {
          script += `    await page.waitForSelector('${esc(nextStep.selector)}');\n`;
        } else {
          // no automatic waitForLoadState emitted here
        }
        currentUrl = step._metadata && step._metadata.pageUrl ? step._metadata.pageUrl : currentUrl;
        continue;
      }

      // 🚨 KEY FIX: Handle click with conditional evaluate fallback
      if (act === 'click' && step.selector) {
        // Check if next step is an evaluate fallback for this click
        const hasEvaluateFallback = nextStep &&
          nextStep.action === 'evaluate' &&
          nextStep.selector === step.selector &&
          nextStep._metadata &&
          nextStep._metadata.isFallback;

        if (hasEvaluateFallback) {
          console.log(`[Recorder] Generating click with evaluate fallback: ${step.selector}`);

          script += `    // Click with evaluate fallback\n`;
          script += `    await page.waitForSelector('${esc(step.selector)}');\n`;
          script += `    try {\n`;

          if (step.force) {
            script += `      await page.click('${esc(step.selector)}', { force: true });\n`;
          } else {
            script += `      await page.click('${esc(step.selector)}');\n`;
          }

          script += `    } catch (error) {\n`;
          script += `      // Click failed, using evaluate fallback\n`;

          // Generate evaluate fallback
          const expression = nextStep.value || nextStep.expression || '';
          if (expression) {
            const escapedExpression = expression.replace(/`/g, '\\`').replace(/\${/g, '\\${');
            script += `      await page.evaluate(() => {\n`;
            script += `        ${escapedExpression}\n`;
            script += `      });\n`;
          }

          script += `    }\n`;

          // Skip the evaluate step since we've handled it
          i++;
          continue;
        } else {
          // Normal click without evaluate fallback
          script += `    await page.waitForSelector('${esc(step.selector)}');\n`;
          if (step.force) {
            script += `    await page.click('${esc(step.selector)}', { force: true });\n`;
          } else {
            script += `    await page.click('${esc(step.selector)}');\n`;
          }
          continue;
        }
      }

      // 🚨 KEY FIX: Handle fill with conditional evaluate fallback
      if ((act === 'fill' || act === 'type') && step.selector) {
        // Check if next step is an evaluate fallback for this fill
        const hasEvaluateFallback = nextStep &&
          nextStep.action === 'evaluate' &&
          nextStep.selector === step.selector &&
          nextStep._metadata &&
          nextStep._metadata.isFallback;

        if (hasEvaluateFallback) {
          console.log(`[Recorder] Generating fill with evaluate fallback: ${step.selector}`);

          script += `    // Fill with evaluate fallback\n`;
          script += `    await page.waitForSelector('${esc(step.selector)}');\n`;
          script += `    await expect(page.locator('${esc(step.selector)}')).toBeEditable();\n`;
          script += `    try {\n`;
          script += `      await page.fill('${esc(step.selector)}', '${esc(step.value || '')}');\n`;
          script += `    } catch (error) {\n`;
          script += `      // Fill failed, using evaluate fallback\n`;

          // Generate evaluate fallback
          const expression = nextStep.value || nextStep.expression || '';
          if (expression) {
            const escapedExpression = expression.replace(/`/g, '\\`').replace(/\${/g, '\\${');
            script += `      await page.evaluate(() => {\n`;
            script += `        ${escapedExpression}\n`;
            script += `      });\n`;
          }

          script += `    }\n`;

          // Skip the evaluate step since we've handled it
          i++;
          continue;
        } else {
          // Normal fill without evaluate fallback
          script += `    await page.waitForSelector('${esc(step.selector)}');\n`;
          script += `    await expect(page.locator('${esc(step.selector)}')).toBeEditable();\n`;
          script += `    await page.fill('${esc(step.selector)}', '${esc(step.value || '')}');\n`;
          continue;
        }
      }

      // Select option
      if ((act === 'selectOption') && step.selector) {
        // Always wait for selector before selecting an option.
        script += `    await page.waitForSelector('${esc(step.selector)}');\n`;
        script += `    await page.selectOption('${esc(step.selector)}', '${esc(step.value || '')}');\n`;
        continue;
      }

      // Check (for radio buttons/checkboxes)
      if (act === 'check' && step.selector) {
        script += `    await page.waitForSelector('${esc(step.selector)}');\n`;
        script += `    await page.check('${esc(step.selector)}');\n`;
        continue;
      }

      // Wait for timeout
      if (act === 'waitForTimeout' || act === 'waitFor') {
        const timeout = step.timeout || step.value || 1000;
        script += `    await page.waitForTimeout(${timeout});\n`;
        continue;
      }

      // Wait for URL
      if (act === 'waitForURL') {
        if (step.url) {
          script += `    await page.waitForURL('${esc(step.url)}');\n`;
        } else {
          script += `    await page.waitForURL('**');\n`;
        }
        continue;
      }

      // Wait for load state
      // intentionally skip any explicit waitForLoadState actions; prefer selector-based waits

      // Evaluate JavaScript (standalone evaluate, not fallbacks)
      if (act === 'evaluate' && step.expression) {
        // Only process standalone evaluate steps (not fallbacks)
        if (!step._metadata || !step._metadata.isFallback) {
          const escapedExpression = step.expression.replace(/`/g, '\\`').replace(/\${/g, '\\${');
          script += `    await page.evaluate(() => {\n`;
          script += `      ${escapedExpression}\n`;
          script += `    });\n`;
        }
        continue;
      }

      // Dispatch event
      if (act === 'dispatchEvent' && step.selector) {
        script += `    await page.dispatchEvent('${esc(step.selector)}', '${step.eventType || 'click'}');\n`;
        continue;
      }

      // Expect visible
      if (act === 'expectVisible' && step.selector) {
        // Ensure element exists before asserting visibility
        script += `    await page.waitForSelector('${esc(step.selector)}');\n`;
        script += `    await expect(page.locator('${esc(step.selector)}')).toBeVisible();\n`;
        continue;
      }

      // Assert
      if (act === 'assert' && step.selector) {
        if (step.assertionType === "url") {
          script += `    await expect(page).toHaveURL('${esc(step.expected)}');\n`;
        } else if (step.assertionType === "urlContains") {
          script += `    const currentUrl = await page.url();\n`;
          script += `    expect(currentUrl).toContain('${esc(step.expected)}');\n`;
        } else if (step.assertionType === "elementText") {
          script += `    await expect(page.locator('${esc(step.selector)}')).toHaveText('${esc(step.expected)}');\n`;
        } else if (step.assertionType === "elementExists" || step.assertionType === "elementVisible") {
          script += `    await expect(page.locator('${esc(step.selector)}')).toBeVisible();\n`;
        } else if (step.assertionType === "elementChecked") {
          script += `    await expect(page.locator('${esc(step.selector)}')).toBeChecked();\n`;
        }
        continue;
      }

      // Wait for selector / assert visible
      if ((act === 'waitForSelector' || act === 'assertVisible') && step.selector) {
        script += `    await page.waitForSelector('${esc(step.selector)}');\n`;
        continue;
      }

      // Generic: if the next recorded step has a different pageUrl, insert a wait to let navigation complete
      try {
        if (nextStep && step._metadata && nextStep._metadata && step._metadata.pageUrl && nextStep._metadata.pageUrl && step._metadata.pageUrl !== nextStep._metadata.pageUrl) {
          if (nextStep.selector) {
            script += `    await page.waitForSelector('${esc(nextStep.selector)}');\n`;
          } else {
            // no automatic waitForLoadState emitted here; prefer explicit selector or navigation steps
          }
          currentUrl = nextStep._metadata.pageUrl;
        }
      } catch (err) {
        // ignore
      }
    }

    script += `  } catch (err) {\n`;
    script += `    console.error('Test failed', err);\n`;
    script += `    process.exit(1);\n`;
    script += `  }\n`;
    script += `});\n`;
    return script;
  }
}

// Fungsi untuk menghapus control panel
function removeControlPanel() {
  const existingPanel = document.querySelector(".recorder-controls");
  if (existingPanel) {
    existingPanel.remove();
  }
}

// Fungsi untuk membersihkan saat navigasi
function cleanup() {
  if (!isRecording) {
    chrome.storage.local.set({
      isRecording: false,
      recordedData: [],
    });
  }

  inputBuffer = {};
  if (observer) {
    observer.disconnect();
  }
  removeControlPanel();
  removeOverlay();
}

// Tambahkan event listener untuk unload
window.addEventListener("unload", cleanup);

function startRecording() {
  document.addEventListener("click", handleClick, true);
  document.addEventListener("contextmenu", handleRightClick, true);
  document.addEventListener("change", handleChange, true);
  document.addEventListener("input", handleInput, true);
  document.addEventListener("keyup", handleInput, true);
  document.addEventListener("blur", handleBlur, true);
  // document.addEventListener("submit", handleSubmit, true);

  // Mulai observasi perubahan DOM
  startObserver();

  // Tambahkan event listener untuk hover
  document.addEventListener("mouseover", handleHover, true);
  document.addEventListener("mouseout", handleMouseOut, true);
}

function stopRecording() {
  document.removeEventListener("click", handleClick, true);
  document.removeEventListener("contextmenu", handleRightClick, true);
  document.removeEventListener("change", handleChange, true);
  document.removeEventListener("input", handleInput, true);
  document.removeEventListener("keyup", handleInput, true);
  document.removeEventListener("blur", handleBlur, true);
  // document.removeEventListener("submit", handleSubmit, true);
  inputBuffer = {};

  // Hentikan observasi
  if (observer) {
    observer.disconnect();
  }

  document.removeEventListener("mouseover", handleHover, true);
  document.removeEventListener("mouseout", handleMouseOut, true);
  removeOverlay();
}

// Modifikasi fungsi handleClick untuk memastikan click pada image terekam
function handleClick(e) {
  console.log('[Recorder] handleClick fired:', e.target);
  if (!isRecording) return;

  const element = e.target;

  // Abaikan klik pada control panel dan overlay
  if (
    element.closest(".recorder-controls") ||
    element.classList.contains("recorder-hover-overlay") ||
    element.classList.contains("recorder-tooltip")
  )
    return;

  // Tampilkan overlay klik sebentar
  showOverlay(element, "click");
  setTimeout(() => {
    if (
      currentOverlay &&
      currentOverlay.classList.contains("recorder-click-overlay")
    ) {
      removeOverlay();
    }
  }, 500);

  // Tambahkan penanganan khusus untuk image
  if (element.tagName === "IMG") {
    console.log('[Recorder] handleClick: akan recordAction IMG', element);
    recordAction("click", element, {
      command: "click",
      value: ""
    });
    return;
  }


  if (element.tagName === "A") {
    console.log('[Recorder] handleClick: akan recordAction A', element);
    recordAction("click", element, {
      command: "click",
      value: ""
    });
  } else if (
    element.tagName === "BUTTON" ||
    (element.tagName === "INPUT" &&
      ["button", "submit", "reset"].includes(element.type))
  ) {
    console.log('[Recorder] handleClick: akan recordAction BUTTON/INPUT', element);
    recordAction("click", element, {
      command: "click",
      value: ""
    });
  } else if (
    element.tagName === "INPUT" &&
    ["checkbox", "radio"].includes(element.type)
  ) {
    console.log('[Recorder] handleClick: akan recordAction INPUT checkbox/radio', element);
    recordAction("click", element, {
      command: "click",
      value: ""
    });
  } else {
    console.log('[Recorder] handleClick: fallback recordAction', element);
    // Fallback: record click for any other element
    recordAction("click", element, {
      command: "click",
      value: ""
    });
  }
}

function handleChange(e) {
  if (!isRecording) return;

  const element = e.target;

  if (element.tagName === "SELECT") {
    recordAction("select", element, {
      command: "selectOption",
      value: element.value,
    });
  } else if (
    element.tagName === "INPUT" &&
    (element.type === "checkbox" || element.type === "radio")
  ) {
    recordAction("click", element, {
      command: "click",
      value: ""
    });
  }
}

function handleInput(e) {
  if (!isRecording) return;

  const element = e.target;

  // Only track inputs
  if (element.tagName !== "INPUT" && element.tagName !== "TEXTAREA") return;

  const type = (element.type || "").toLowerCase();
  const textLikeInputTypes = new Set([
    "text", "search", "email", "password",
    "tel", "url", "number"
  ]);

  // Only text-like inputs
  if (element.tagName === "TEXTAREA" || textLikeInputTypes.has(type)) {
    const key = getUniqueElementKey(element);

    inputBuffer[key] = {
      element,
      value: element.value,
      timestamp: new Date(),
    };

    console.log("[Recorder] handleInput captured via", e.type, {
      key,
      valuePreview: String(element.value).slice(0, 100),
    });
  }
}



// Tambahkan event untuk blur (ketika input selesai)
function handleBlur(e) {
  if (!isRecording) return;

  const element = e.target;
  const bufferKey = getUniqueElementKey(element);

  // Only emit fill actions for text-like inputs / textareas to avoid generating fills for radios/checkboxes
  const tag = element.tagName;
  const textLikeInputTypes = new Set(['text', 'search', 'email', 'password', 'tel', 'url', 'number']);

  if (inputBuffer[bufferKey] && (tag === 'TEXTAREA' || (tag === 'INPUT' && textLikeInputTypes.has((element.type || '').toLowerCase())))) {
    // Attempt to reuse selector from the most recent click action on this element.
    // This ensures fill selector matches click selector despite class changes during typing.
    let selectorToUse = null;
    try {
      const lastAction = recordedData.length > 0 ? recordedData[recordedData.length - 1] : null;
      if (lastAction && lastAction.action === 'click' && lastAction.selector) {
        // Verify it targets the same element by checking if the selector matches this element
        const matches = element.matches(lastAction.selector);
        if (matches) {
          selectorToUse = lastAction.selector;
          try { console.log('[Recorder] handleBlur: reusing click selector', { selector: selectorToUse }); } catch (err) {}
        }
      }
    } catch (err) {
      // If selector reuse fails (e.g., :nth-child doesn't match after DOM change), fall through
      try { console.warn('[Recorder] handleBlur: failed to reuse selector, will compute new one', err); } catch (e) {}
    }

    // If we couldn't reuse the click selector, compute a fresh one
    if (!selectorToUse) {
      selectorToUse = getBestPlaywrightSelector(element);
      try { console.log('[Recorder] handleBlur: computed new selector', { selector: selectorToUse }); } catch (err) {}
    }

    // Manually construct action to use the reused selector
    const selector = selectorToUse;
    let action = {
      action: 'fill',
      selector: selector,
      value: element.value,
    };

    action._metadata = {
      timestamp: new Date().toISOString(),
      pageUrl: window.location.href,
      originalCommand: 'fill',
      elementInfo: {
        tagName: element.tagName,
        id: element.id,
        className: element.className,
        text: element.textContent?.trim()
      }
    };

    recordedData.push(action);
    try { console.log('[Recorder] fill recorded with selector:', { selector }); } catch (err) {}

    if (isRecording) {
      chrome.storage.local.set({ recordedData: recordedData }, () => {
        try { console.log('[Recorder] chrome.storage.local.set done'); } catch (err) {}
      });
    }

    // Hapus dari buffer
    delete inputBuffer[bufferKey];
  }
}

function handleSubmit(e) {
  if (!isRecording) return;

  const form = e.target;
  const submitButton = form.querySelector(
    'button[type="submit"], input[type="submit"]'
  );

  recordAction("submit", submitButton || form, {
    command: "click",
    value: ""
  });

  // Tunggu sebentar untuk melihat apakah ada response message
  setTimeout(() => {
    const messages = document.querySelectorAll(
      '[role="alert"], .alert, .message, .notification'
    );
    messages.forEach((msg) => {
      checkVisibilityAndContent(msg);
    });
  }, 3000);
}

function recordAction(type, element, data) {
  console.log('[Recorder] recordAction called:', { type, element, data });
  const selector = getBestPlaywrightSelector(element);

  // Assertion format for custom assertion types
  if (type === "assert" && data.type && ["elementText", "elementVisible", "elementClass", "elementValue"].includes(data.type)) {
    recordedData.push(data);
    console.log('[Recorder] recordedData after push (assertion):', recordedData);
    if (isRecording) {
      chrome.storage.local.set({ recordedData: recordedData }, () => {
        console.log('[Recorder] chrome.storage.local.set done:', recordedData);
      });
    }
    console.log("Action recorded (assertion):", data);
    return;
  }

  // Convert to Playwright format (default)
  let action = {
    action: mapToPlaywrightAction(data.command, type),
    selector: selector
  };

  // Add value for actions that need it
  if (data.value && shouldIncludeValue(data.command)) {
    action.value = data.value;
  }

  // Special handling for navigation
  if (data.command === "open") {
    action = {
      action: "goto",
      url: data.value
    };
  }

  // Add metadata for debugging (optional)
  action._metadata = {
    timestamp: new Date().toISOString(),
    pageUrl: window.location.href,
    originalCommand: data.command,
    elementInfo: data.command !== "open" ? {
      tagName: element.tagName,
      id: element.id,
      className: element.className,
      text: element.textContent?.trim()
    } : undefined
  };

  recordedData.push(action);
  console.log('[Recorder] recordedData after push:', recordedData);

  // Save updated recordedData
  if (isRecording) {
    chrome.storage.local.set({ recordedData: recordedData }, () => {
      console.log('[Recorder] chrome.storage.local.set done:', recordedData);
    });
  }

  console.log("Action recorded:", action);
}

// Helper function to map commands to Playwright actions
function mapToPlaywrightAction(command, type) {
  const actionMap = {
    'click': 'click',
    'fill': 'fill',
    'type': 'fill',
    'select': 'selectOption',
    'selectOption': 'selectOption',
    'submit': 'click',
    'assertVisible': 'waitForSelector'
  };

  return actionMap[command] || 'click';
}

// Helper function to determine if value should be included
function shouldIncludeValue(command) {
  const commandsWithValue = ['fill', 'type', 'select', 'selectOption'];
  return commandsWithValue.includes(command);
}

// Helper: Strip Angular framework classes (ng-untouched, ng-pristine, ng-valid, ng-dirty, etc.) from selector
function stripAngularClasses(selector) {
  if (!selector || typeof selector !== 'string') return selector;
  // Remove ng-* classes and -inserted artifacts from the selector string
  let cleaned = selector.replace(/\.ng-\w+/g, '');  // Remove .ng-* classes
  cleaned = cleaned.replace(/-inserted(?=\.|:|$)/g, '');  // Remove -inserted suffix (before . : or end)
  // Also clean up any leftover empty classes (e.g., 'a.' -> 'a')
  cleaned = cleaned.replace(/\.$/, '');  // Remove trailing dot
  cleaned = cleaned.replace(/\.(?=\.)/g, '');  // Remove duplicate dots
  return cleaned;
}

// Fungsi untuk mendapatkan selector terbaik untuk Playwright
function getBestPlaywrightSelector(element) {
  // 1. Data-testid atau data-cy (prioritaskan ini)
  if (element.dataset) {
    const testId = element.dataset.testid || element.dataset.cy;
    if (testId) {
      return stripAngularClasses(`[data-testid="${testId}"]`);
    }
  }

  // 2. ID yang unik
  if (element.id && document.querySelectorAll(`#${element.id}`).length === 1) {
    return stripAngularClasses(`#${element.id}`);
  }

  // 3. Untuk input elements, prioritaskan aria-label
  if (element.tagName === "INPUT" && element.getAttribute("aria-label")) {
    return stripAngularClasses(`input[aria-label="${element.getAttribute("aria-label")}"]`);
  }

  // 4. Name attribute yang unik
  if (element.name && document.getElementsByName(element.name).length === 1) {
    return stripAngularClasses(`[name="${element.name}"]`);
  }

  // 5. Placeholder yang unik untuk input
  if (element.placeholder) {
    const samePlaceholder = document.querySelectorAll(
      `[placeholder="${element.placeholder}"]`
    );
    if (samePlaceholder.length === 1) {
      return stripAngularClasses(`[placeholder="${element.placeholder}"]`);
    }
  }

  // 6. Role attribute
  if (element.getAttribute("role")) {
    const role = element.getAttribute("role");
    const sameRole = document.querySelectorAll(`[role="${role}"]`);
    if (sameRole.length === 1) {
      return stripAngularClasses(`[role="${role}"]`);
    }
  }

  // 7. Button/Link dengan text content
  if (
    (element.tagName === "BUTTON" || element.tagName === "A") &&
    element.textContent.trim()
  ) {
    const text = element.textContent.trim();
    const sameTextElements = Array.from(
      document.querySelectorAll(element.tagName)
    ).filter((el) => el.textContent.trim() === text);

    if (sameTextElements.length === 1) {
      return stripAngularClasses(element.tagName === "A"
        ? `text=${text}`
        : `button:has-text("${text}")`);
    }
  }

  // 8. Untuk image elements
  if (element.tagName === "IMG" && element.alt) {
    return stripAngularClasses(`img[alt="${element.alt}"]`);
  }

  // 9. CSS selector yang unik
  const cssSelector = buildPlaywrightCssSelector(element);
  if (cssSelector) {
    return stripAngularClasses(cssSelector);
  }

  // 10. XPath sebagai fallback
  return stripAngularClasses(getPlaywrightXPath(element));
}

function buildPlaywrightCssSelector(element) {
  console.log('[Recorder] buildPlaywrightCssSelector called for element:', element);

  if (!element || !element.tagName) {
    console.warn('[Recorder] Invalid element provided');
    return 'body'; // Fallback
  }

  // Strategy 1: Try ID first (most reliable)
  if (element.id && !element.id.match(/^[0-9]/)) {
    const idSelector = `#${CSS.escape(element.id)}`;
    if (isSelectorUnique(idSelector)) {
      console.log('[Recorder] Using ID selector:', idSelector);
      return stripAngularClasses(idSelector);
    }
  }

  // Strategy 2: Try data-testid or other data attributes
  const dataAttributes = ['data-testid', 'data-id', 'data-qa', 'data-cy', 'data-test'];
  for (const attr of dataAttributes) {
    if (element.hasAttribute(attr)) {
      const value = element.getAttribute(attr);
      if (value && value.trim()) {
        const dataSelector = `[${attr}="${CSS.escape(value)}"]`;
        if (isSelectorUnique(dataSelector)) {
          console.log('[Recorder] Using data attribute selector:', dataSelector);
          return stripAngularClasses(dataSelector);
        }
      }
    }
  }

  // Strategy 3: Build comprehensive selector with multiple attributes
  let selector = element.tagName.toLowerCase();

  // Add type attribute for form elements
  if (element.hasAttribute('type') && ["INPUT", "BUTTON", "SELECT"].includes(element.tagName)) {
    const typeValue = element.getAttribute('type');
    if (typeValue) {
      selector += `[type="${CSS.escape(typeValue)}"]`;
    }
  }

  // Add name attribute if present
  if (element.hasAttribute('name')) {
    const nameValue = element.getAttribute('name');
    if (nameValue) {
      selector += `[name="${CSS.escape(nameValue)}"]`;
    }
  }

  // Add placeholder for input elements
  if (element.hasAttribute('placeholder') && element.tagName === 'INPUT') {
    const placeholderValue = element.getAttribute('placeholder');
    if (placeholderValue) {
      selector += `[placeholder="${CSS.escape(placeholderValue)}"]`;
    }
  }

  // Add meaningful classes (more selective)
  const meaningfulClasses = getMeaningfulClasses(element);
  if (meaningfulClasses.length > 0) {
    const classSelector = selector + '.' + meaningfulClasses.join('.');
    if (isSelectorUnique(classSelector)) {
      console.log('[Recorder] Using class-based selector:', classSelector);
      return stripAngularClasses(classSelector);
    }
  }

  // Strategy 4: Text content for buttons and links
  if (['BUTTON', 'A', 'SPAN', 'DIV'].includes(element.tagName)) {
    const text = element.textContent?.trim();
    if (text && text.length > 0 && text.length < 50) {
      const textSelector = `${selector}:has-text("${CSS.escape(text)}")`;
      if (isSelectorUnique(textSelector)) {
        console.log('[Recorder] Using text-based selector:', textSelector);
        return stripAngularClasses(textSelector);
      }
    }
  }

  // Strategy 5: Parent context with precise indexing
  const parentContextSelector = buildParentContextSelector(element);
  if (parentContextSelector && isSelectorUnique(parentContextSelector)) {
    console.log('[Recorder] Using parent context selector:', parentContextSelector);
    return stripAngularClasses(parentContextSelector);
  }

  // Strategy 6: Table-specific context (common in applications)
  const tableContextSelector = buildTableContextSelector(element);
  if (tableContextSelector && isSelectorUnique(tableContextSelector)) {
    console.log('[Recorder] Using table context selector:', tableContextSelector);
    return stripAngularClasses(tableContextSelector);
  }

  // Strategy 7: Full path with precise indexing
  const fullPathSelector = buildFullPathSelector(element);
  if (fullPathSelector && isSelectorUnique(fullPathSelector)) {
    console.log('[Recorder] Using full path selector:', fullPathSelector);
    return stripAngularClasses(fullPathSelector);
  }

  // Final fallback
  console.warn('[Recorder] Using fallback selector');
  // Build a full DOM path as a precise fallback (includes parent IDs, classes, and nth-child)
  try {
    const fullPath = buildFullPathSelector(element);
    if (fullPath) {
      console.log('[Recorder] Using full-path fallback selector:', fullPath);
      return stripAngularClasses(fullPath);
    }
  } catch (err) {
    console.warn('[Recorder] buildFullPathSelector failed, falling back to simple selector', err);
  }

  return stripAngularClasses(selector);
}

// Helper function to check selector uniqueness
function isSelectorUnique(selector) {
  try {
    return document.querySelectorAll(selector).length === 1;
  } catch (error) {
    console.warn('[Recorder] Invalid selector:', selector, error);
    return false;
  }
}

// Helper function to get meaningful classes
function getMeaningfulClasses(element) {
  let classStr = '';

  if (typeof element.className === 'string') {
    classStr = element.className;
  } else if (typeof element.className?.baseVal === 'string') {
    classStr = element.className.baseVal; // SVG elements
  }

  if (!classStr) return [];

  return classStr
    .split(' ')
    .filter(className => {
      // Filter out meaningless classes
      if (!className || className.length < 2) return false;
      if (className.match(/^[0-9]/)) return false;
      
      // Exclude Angular/framework classes
      if (className.match(/^ng-/)) return false;  // ng-* prefix
      if (className.match(/-inserted$/)) return false;  // -inserted suffix
      if (className.match(/^_ng/)) return false;  // _ng* prefix
      
      // Exclude state/theme classes (these change during interaction)
      if (className.match(/^(active|inactive|selected|disabled|enabled|hidden|visible|focus|hover|visited)$/)) return false;
      if (className.match(/^(nav-|btn-|text-|alert-|toast-)/)) return false;  // Theme/utility classes
      
      // Keep only structural/semantic classes
      if (className.match(/^(js-|is-|has-)/)) return true;  // Keep JS state classes
      if (className.length > 3 && !className.match(/^[a-z]+-[0-9]/)) return true;  // Keep meaningful names
      return false;
    })
    .slice(0, 3); // Limit to 3 most meaningful classes
}

// Helper function to build parent context selector
function buildParentContextSelector(element, maxDepth = 4) {
  let currentElement = element;
  let depth = 0;
  let pathParts = [buildElementSelector(currentElement)];

  while (currentElement.parentElement && depth < maxDepth) {
    currentElement = currentElement.parentElement;

    // Stop if we reach body or html
    if (currentElement.tagName === 'BODY' || currentElement.tagName === 'HTML') {
      break;
    }

    const parentSelector = buildElementSelector(currentElement);
    pathParts.unshift(parentSelector);

    // Check if current path is unique
    const currentPath = pathParts.join(' > ');
    if (isSelectorUnique(currentPath)) {
      return currentPath;
    }

    depth++;
  }

  return null;
}

// Helper function to build element selector with precise indexing
function buildElementSelector(element) {
  let selector = element.tagName.toLowerCase();

  // Add ID if available
  if (element.id && !element.id.match(/^[0-9]/)) {
    return `#${CSS.escape(element.id)}`;
  }

  // Add meaningful classes
  const meaningfulClasses = getMeaningfulClasses(element);
  if (meaningfulClasses.length > 0) {
    selector += '.' + meaningfulClasses.join('.');
  }

  // Add precise nth-child if needed
  if (element.parentElement) {
    const siblings = Array.from(element.parentElement.children);
    const sameTagSiblings = siblings.filter(sib => sib.tagName === element.tagName);

    if (sameTagSiblings.length > 1) {
      const index = sameTagSiblings.indexOf(element);
      if (index !== -1) {
        // Try :nth-of-type first (more reliable)
        const nthOfTypeSelector = `${selector}:nth-of-type(${index + 1})`;
        if (isSelectorUnique(nthOfTypeSelector)) {
          return nthOfTypeSelector;
        }

        // Fallback to :nth-child
        const allSiblingsIndex = siblings.indexOf(element);
        if (allSiblingsIndex !== -1) {
          return `${selector}:nth-child(${allSiblingsIndex + 1})`;
        }
      }
    }
  }

  return selector;
}

// Helper function for table contexts (very common in web apps)
// NOTE: This assumes you have access to a function named buildElementSelector(element)
// which should create a simplified selector for the target element (e.g., 'i.icon-hamburger')

function buildTableContextSelector(element) {
  const row = element.closest('tr');
  if (!row) return null;

  // --- 1. Identify Unique Row Text ---
  let uniqueRowText = '';
  const cells = Array.from(row.querySelectorAll('td, th'));

  // Look for unique text in cells that is descriptive (not just numbers or symbols)
  for (const cell of cells) {
    const text = cell.textContent?.trim();
    // Criteria: Text exists, is long enough, and doesn't look like just a number/currency.
    if (text && text.length > 5 && !/^[0-9.,\sR]+$/.test(text)) {
      // For stability, use the first good descriptive text found
      uniqueRowText = text;
      break;
    }
  }

  // If no unique text is found, we can't build a stable text-based row selector
  if (!uniqueRowText) {
    // Fallback: If no text, return null and let the general full-path logic take over, 
    // OR optionally, keep your old positional logic here as a last resort fallback.
    // For now, we prefer a stable selector, so we return null.
    return null;
  }

  // --- 2. Build Root Selector (The Row) ---
  // Use Playwright's :has-text() selector for guaranteed stability
  const rowRootSelector = `tr:has-text("${CSS.escape(uniqueRowText)}")`;

  // --- 3. Build Path from Row Down to Element ---
  let pathSegment = '';
  let current = element;

  // Traverse UP from the element until the row is reached
  while (current && current !== row) {
    const tagName = current.tagName.toLowerCase();

    // Build the selector for the current element: Tag + Meaningful Classes
    let currentSelector = tagName;
    const meaningfulClasses = getMeaningfulClasses(current);
    if (meaningfulClasses.length > 0) {
      currentSelector += '.' + meaningfulClasses.join('.');
    }

    // Prepend the segment to the path (e.g., 'td > button > i')
    pathSegment = currentSelector + (pathSegment ? ' > ' + pathSegment : '');

    current = current.parentElement;
  }

  // --- 4. Final Selector Assembly ---
  // Combine the stable row root with the simplified path to the target element.
  // Use ' ' (descendant selector) instead of ' > ' for more robustness.
  return `${rowRootSelector} ${pathSegment}`;
}

// Helper function to build full CSS path
function buildFullPathSelector(element) {
  const path = [];
  let currentElement = element;

  while (currentElement && currentElement.tagName !== 'HTML') {
    let selector = currentElement.tagName.toLowerCase();

    // Add ID if available
    if (currentElement.id && !currentElement.id.match(/^[0-9]/)) {
      selector = `#${CSS.escape(currentElement.id)}`;
      path.unshift(selector);
      break;
    }

    // Add classes
    const meaningfulClasses = getMeaningfulClasses(currentElement);
    if (meaningfulClasses.length > 0) {
      selector += '.' + meaningfulClasses.join('.');
    }

    // Add nth-child for precision
    if (currentElement.parentElement) {
      const siblings = Array.from(currentElement.parentElement.children);
      const index = siblings.indexOf(currentElement);
      if (index !== -1 && siblings.length > 1) {
        selector += `:nth-child(${index + 1})`;
      }
    }

    path.unshift(selector);
    currentElement = currentElement.parentElement;

    // Stop if we have enough context
    if (path.length >= 6) break;
  }

  return path.join(' > ');
}

function getPlaywrightXPath(element) {
  const parts = [];
  let current = element;

  while (current && current.nodeType === Node.ELEMENT_NODE) {
    let selector = current.tagName.toLowerCase();

    // Tambahkan ID jika ada
    if (current.id) {
      return `xpath=//*[@id="${current.id}"]`;
    }

    // Tambahkan atribut penting
    const attributes = [];
    ["name", "class", "role", "type", "aria-label"].forEach((attr) => {
      const value = current.getAttribute(attr);
      if (value) {
        attributes.push(`@${attr}="${value}"`);
      }
    });

    if (attributes.length > 0) {
      selector += `[${attributes.join(" and ")}]`;
    }

    // Tambahkan index jika perlu
    const siblings = current.parentNode
      ? Array.from(current.parentNode.children)
      : [];
    const similarSiblings = siblings.filter(
      (sibling) => sibling.tagName === current.tagName
    );

    if (similarSiblings.length > 1) {
      const index = similarSiblings.indexOf(current) + 1;
      selector += `[${index}]`;
    }

    parts.unshift(selector);
    current = current.parentNode;

    // Batasi kedalaman untuk menghindari XPath yang terlalu panjang
    if (parts.length >= 3) break;
  }

  return `xpath=//${parts.join("/")}`;
}

// Helper function untuk mendapatkan unique key untuk element
function getUniqueElementKey(element) {
  return element.id || element.name || getXPath(element);
}

function getXPath(element) {
  if (!element) return "";

  // Coba dapatkan XPath yang unik dan pendek
  let paths = [];
  let current = element;

  while (current && current.nodeType === Node.ELEMENT_NODE) {
    let index = 1;
    let hasId = false;

    // Cek ID
    if (current.id) {
      paths.unshift(`//*[@id="${current.id}"]`);
      break;
    }

    // Cek siblings
    for (
      let sibling = current.previousSibling;
      sibling;
      sibling = sibling.previousSibling
    ) {
      if (
        sibling.nodeType === Node.ELEMENT_NODE &&
        sibling.tagName === current.tagName
      ) {
        index++;
      }
    }

    // Tambahkan atribut untuk spesifisitas
    let attributes = "";
    if (current.className) {
      attributes += `[@class="${current.className}"]`;
    }
    if (current.name) {
      attributes += `[@name="${current.name}"]`;
    }

    paths.unshift(`/${current.tagName.toLowerCase()}${attributes}[${index}]`);
    current = current.parentNode;
  }

  return paths.join("");
}

// Exposed helper: Fix weak selectors in a recording JSON by resolving elements in the current page
// Usage (in page console where the extension runs on the same app page):
//   const fixed = window.__hiteman_fixSelectors(myRecordingJson);
//   // fixed is the modified JSON (same structure) with improved selectors where resolvable
window.__hiteman_fixSelectors = function(recording) {
  try {
    if (!recording) return recording;

    // Accept either array of actions or object with 'steps' or 'actions'
    const cloned = JSON.parse(JSON.stringify(recording));
    const list = Array.isArray(cloned) ? cloned : (cloned.steps || cloned.actions || []);

    function findElementByOuterHTML(outerHTML) {
      if (!outerHTML) return null;
      const all = document.querySelectorAll('*');
      for (const el of all) {
        if (el.outerHTML && el.outerHTML.indexOf(outerHTML.trim().slice(0, 60)) !== -1) {
          return el;
        }
      }
      return null;
    }

    for (const action of list) {
      try {
        if (!action || !action.selector) continue;

        const selector = action.selector;

        // Heuristic: treat selectors like 'button[type="button"]' or simple tag selectors as weak
        const weakSelectorPattern = /^\w+(\[.*\])?$|^\w+\.[\w\-]+$/;
        const isWeak = weakSelectorPattern.test(selector) || (document.querySelectorAll(selector || '').length > 1);

        if (!isWeak) continue; // already specific

        // Try to resolve element: prefer exact query if it yields one element
        let el = null;
        try {
          const nodes = document.querySelectorAll(selector);
          if (nodes.length === 1) el = nodes[0];
          else if (nodes.length > 1 && action._metadata && action._metadata.outerHTML) {
            // try to match outerHTML snippet among candidates
            for (const n of nodes) {
              if (n.outerHTML && n.outerHTML.indexOf(action._metadata.outerHTML.trim().slice(0,60)) !== -1) {
                el = n; break;
              }
            }
          }
        } catch (err) {
          // ignore invalid selectors
        }

        // If not found, try matching outerHTML globally
        if (!el && action._metadata && action._metadata.outerHTML) {
          el = findElementByOuterHTML(action._metadata.outerHTML);
        }

        // If still not found, and action has value/text, try to find by text
        if (!el && (action.value || action.text)) {
          const text = (action.value || action.text).toString().trim();
          if (text) {
            const candidates = Array.from(document.querySelectorAll('*')).filter(n => n.textContent && n.textContent.indexOf(text) !== -1);
            if (candidates.length === 1) el = candidates[0];
          }
        }

        if (!el) continue; // can't resolve on this page

        // Build full path selector and replace
        const full = buildFullPathSelector(el);
        if (full) {
          const cleaned = stripAngularClasses(full);
          action.selector = cleaned;
          console.log('[Recorder] Fixed selector for action', action.action || action.type, '->', cleaned);
        }
      } catch (err) {
        console.warn('[Recorder] __hiteman_fixSelectors per-action error', err);
      }
    }

    // Put back into cloned structure
    if (Array.isArray(cloned)) return cloned;
    if (cloned.steps) cloned.steps = list;
    else if (cloned.actions) cloned.actions = list;

    // Trigger a download of the fixed recording for convenience
    try {
      const blob = new Blob([JSON.stringify(cloned, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'recording-fixed.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      // ignore download failures
    }

    return cloned;
  } catch (err) {
    console.error('[Recorder] __hiteman_fixSelectors error', err);
    return recording;
  }
};

function getCssSelector(element) {
  if (!element) return "";

  if (element.id) {
    return `#${element.id}`;
  }

  let path = [];
  while (element) {
    let selector = element.tagName.toLowerCase();

    if (element.id) {
      selector += `#${element.id}`;
      path.unshift(selector);
      break;
    }

    if (element.className) {
      selector += `.${element.className.trim().replace(/\s+/g, ".")}`;
    }

    let index = 1;
    let sibling = element;
    while ((sibling = sibling.previousElementSibling)) {
      if (sibling.tagName === element.tagName) {
        index++;
      }
    }

    if (index > 1) {
      selector += `:nth-of-type(${index})`;
    }

    path.unshift(selector);
    element = element.parentNode;

    if (path.length > 2) break; // Batasi kedalaman selector
  }

  return path.join(" > ");
}

// Fungsi untuk memulai mutation observer
function startObserver() {
  observer = new MutationObserver((mutations) => {
    if (!isRecording) return;

    mutations.forEach((mutation) => {
      // Cek perubahan yang menambahkan node baru
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          checkVisibilityAndContent(node);
        }
      });

      // Cek perubahan atribut yang mempengaruhi visibility
      if (
        mutation.type === "attributes" &&
        (mutation.attributeName === "style" ||
          mutation.attributeName === "class" ||
          mutation.attributeName === "hidden")
      ) {
        checkVisibilityAndContent(mutation.target);
      }

      // Cek perubahan teks
      if (mutation.type === "characterData" && mutation.target.parentElement) {
        checkVisibilityAndContent(mutation.target.parentElement);
      }
    });
  });

  // Mulai observasi dengan konfigurasi
  observer.observe(document.body, {
    childList: true,
    attributes: true,
    characterData: true,
    subtree: true,
    attributeFilter: ["style", "class", "hidden"],
  });
}

// Modifikasi fungsi checkVisibilityAndContent untuk lebih selektif
function checkVisibilityAndContent(element) {
  // Abaikan elemen control panel dan elemen yang tidak visible
  if (
    element.closest(".recorder-controls") ||
    !isElementVisible(element) ||
    element.closest(".recorder-hover-overlay") ||
    element.closest(".recorder-tooltip")
  )
    return;

  const text = element.textContent?.trim();
  if (!text || text.length < 3 || text.length > 200) return; // Abaikan teks terlalu pendek atau panjang

  // Cek apakah ini dialog/modal yang baru muncul
  if (isDialog(element)) {
    recordAction("assert", element, {
      command: "assertVisible",
      value: text,
      type: "dialog",
    });
    return;
  }

  // Hanya rekam pesan yang benar-benar penting
  if (isImportantMessage(element)) {
    // Tunggu sebentar untuk memastikan pesan stabil dan bukan flash message
    setTimeout(() => {
      if (
        isElementVisible(element) &&
        element.textContent?.trim() === text &&
        shouldRecordMessage(element, text)
      ) {
        recordAction("assert", element, {
          command: "assertVisible",
          value: "",
          type: getMessageType(text),
        });
      }
    }, 500);
  }
}

// Tambahkan fungsi baru untuk menentukan apakah pesan perlu direkam
function shouldRecordMessage(element, text) {
  // Abaikan elemen yang terlalu generic
  if (
    element.tagName === "DIV" &&
    (!element.className || element.className.length < 3)
  )
    return false;

  // Abaikan pesan yang terlalu umum
  const commonMessages = [
    "loading",
    "please wait",
    "mohon tunggu",
    "welcome",
    "selamat datang",
  ];
  if (commonMessages.some((msg) => text.toLowerCase().includes(msg)))
    return false;

  // Pastikan elemen memiliki karakteristik pesan
  const hasMessageCharacteristics =
    element.getAttribute("role") === "alert" ||
    element.getAttribute("aria-live") === "polite" ||
    element.classList.contains("alert") ||
    element.classList.contains("message") ||
    element.classList.contains("notification") ||
    element.classList.contains("toast") ||
    element.closest('[role="alert"]') ||
    element.closest(".alert") ||
    element.closest(".message") ||
    element.closest(".notification");

  return hasMessageCharacteristics;
}

// Fungsi untuk menentukan tipe pesan
function getMessageType(text) {
  if (isErrorMessage(text)) return "error";
  if (isWarningMessage(text)) return "warning";
  if (isSuccessMessage(text)) return "success";
  return "info";
}

// Update fungsi isImportantMessage untuk lebih ketat
function isImportantMessage(element) {
  // Cek role yang benar-benar penting
  const importantRoles = ["alert", "status"];
  if (importantRoles.includes(element.getAttribute("role"))) {
    return true;
  }

  // Cek class yang spesifik untuk pesan penting
  const importantClasses = [
    "alert-danger",
    "alert-warning",
    "alert-success",
    "alert-info",
    "toast-error",
    "toast-warning",
    "toast-success",
    "toast-info",
    "notification--error",
    "notification--warning",
    "notification--success",
  ];

  const hasImportantClass = importantClasses.some(
    (className) =>
      element.classList.contains(className) || element.closest(`.${className}`)
  );

  if (hasImportantClass) return true;

  // Cek aria attributes yang penting
  const hasImportantAria = ["aria-invalid", "aria-errormessage"].some((attr) =>
    element.hasAttribute(attr)
  );

  if (hasImportantAria) return true;

  // Cek teks konten untuk pesan penting
  const text = element.textContent?.trim().toLowerCase();
  if (!text) return false;

  // Hanya kembalikan true jika memiliki karakteristik pesan DAN mengandung kata kunci penting
  return (
    shouldRecordMessage(element, text) &&
    (isErrorMessage(text) || isWarningMessage(text) || isSuccessMessage(text))
  );
}

// Fungsi untuk mengecek apakah elemen adalah dialog/modal
function isDialog(element) {
  // Cek role dialog/alertdialog
  if (
    element.getAttribute("role") === "dialog" ||
    element.getAttribute("role") === "alertdialog"
  ) {
    return true;
  }

  // Cek class yang umum untuk modal/dialog
  const dialogClasses = [
    "modal",
    "dialog",
    "popup",
    "overlay",
    "lightbox",
    "drawer",
    "popover",
  ];

  const hasDialogClass = dialogClasses.some((className) => {
    const elementClasses = element.className.toLowerCase();
    return (
      elementClasses.includes(className) &&
      !elementClasses.includes("wrapper") &&
      !elementClasses.includes("container")
    );
  });

  if (hasDialogClass) return true;

  // Cek aria attributes
  if (element.getAttribute("aria-modal") === "true") return true;

  return false;
}

// Fungsi untuk memeriksa apakah elemen visible
function isElementVisible(element) {
  const style = window.getComputedStyle(element);
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.opacity !== "0" &&
    element.offsetParent !== null
  );
}

// Fungsi untuk memeriksa apakah teks berisi pesan error
function isErrorMessage(text) {
  const errorKeywords = [
    "error",
    "invalid",
    "failed",
    "incorrect",
    "wrong",
    "gagal",
    "salah",
    "tidak valid",
    "tidak benar",
    "required",
    "wajib diisi",
    "tidak ditemukan",
    "tidak tersedia",
    "tidak sesuai",
    "tidak boleh kosong",
    "invalid",
    "error",
    "failed",
    "failure",
    "denied",
    "rejected",
    "unauthorized",
    "forbidden",
  ];

  return errorKeywords.some((keyword) =>
    text.toLowerCase().includes(keyword.toLowerCase())
  );
}

// Tambah fungsi untuk mengecek success message
function isSuccessMessage(text) {
  const successKeywords = [
    "success",
    "successful",
    "succeeded",
    "berhasil",
    "saved",
    "tersimpan",
    "completed",
    "selesai",
    "updated",
    "diperbarui",
    "created",
    "dibuat",
  ];

  return successKeywords.some((keyword) =>
    text.toLowerCase().includes(keyword.toLowerCase())
  );
}

// Update fungsi isMessageElement untuk lebih selektif
function isMessageElement(element) {
  // Cek apakah elemen memiliki role yang relevan
  const messageRoles = ["alert", "status", "log"];
  if (messageRoles.includes(element.getAttribute("role"))) {
    return true;
  }

  // Cek class yang spesifik untuk pesan
  const messageClasses = [
    "alert",
    "message",
    "notification",
    "toast",
    "error",
    "success",
    "warning",
    "info",
  ];

  const hasMessageClass = messageClasses.some((className) => {
    const elementClasses = element.className.toLowerCase();
    return (
      elementClasses.includes(className.toLowerCase()) &&
      !elementClasses.includes("wrapper") && // Hindari wrapper elements
      !elementClasses.includes("container")
    );
  });

  if (hasMessageClass) {
    return true;
  }

  // Cek aria attributes
  if (element.hasAttribute("aria-live")) {
    return true;
  }

  // Cek parent elements (maksimal 2 level)
  let parent = element.parentElement;
  let level = 0;
  while (parent && level < 2) {
    if (
      messageRoles.includes(parent.getAttribute("role")) ||
      messageClasses.some((c) =>
        parent.className.toLowerCase().includes(c.toLowerCase())
      )
    ) {
      return true;
    }
    parent = parent.parentElement;
    level++;
  }

  return false;
}

function handleHover(e) {
  if (!isRecording) return;

  const element = e.target;

  // Abaikan hover pada control panel dan overlay
  if (
    element.closest(".recorder-controls") ||
    element.classList.contains("recorder-hover-overlay") ||
    element.classList.contains("recorder-tooltip")
  )
    return;

  showOverlay(element, "hover");
}

function handleMouseOut(e) {
  if (!isRecording) return;
  removeOverlay();
}

function showOverlay(element, type) {
  removeOverlay();

  const rect = element.getBoundingClientRect();
  const overlay = document.createElement("div");
  const tooltip = document.createElement("div");

  // Buat overlay
  overlay.className =
    type === "hover" ? "recorder-hover-overlay" : "recorder-click-overlay";
  overlay.style.top = `${rect.top + window.scrollY}px`;
  overlay.style.left = `${rect.left + window.scrollX}px`;
  overlay.style.width = `${rect.width}px`;
  overlay.style.height = `${rect.height}px`;

  // Buat tooltip
  tooltip.className = "recorder-tooltip";
  const selector = getBestPlaywrightSelector(element);
  tooltip.textContent = `Selector: ${selector}`;

  // Posisikan tooltip
  const tooltipX = rect.left + window.scrollX;
  const tooltipY = rect.top + window.scrollY - 25; // 25px di atas elemen
  tooltip.style.left = `${tooltipX}px`;
  tooltip.style.top = `${tooltipY}px`;

  document.body.appendChild(overlay);
  document.body.appendChild(tooltip);

  currentOverlay = overlay;
  currentTooltip = tooltip;
}

function removeOverlay() {
  if (currentOverlay) {
    currentOverlay.remove();
    currentOverlay = null;
  }
  if (currentTooltip) {
    currentTooltip.remove();
    currentTooltip = null;
  }
}

// Tambah fungsi baru untuk menampilkan overlay pesan
function showMessageOverlay(element, options) {
  const rect = element.getBoundingClientRect();
  const overlay = document.createElement("div");
  const tooltip = document.createElement("div");

  // Buat overlay dengan warna berbeda untuk error dan sukses
  overlay.className = "recorder-hover-overlay";
  if (options.isError) {
    overlay.style.backgroundColor = "rgba(255, 0, 0, 0.1)";
    overlay.style.borderColor = "#ff0000";
  } else {
    overlay.style.backgroundColor = "rgba(0, 255, 0, 0.1)";
    overlay.style.borderColor = "#00ff00";
  }

  overlay.style.top = `${rect.top + window.scrollY}px`;
  overlay.style.left = `${rect.left + window.scrollX}px`;
  overlay.style.width = `${rect.width}px`;
  overlay.style.height = `${rect.height}px`;

  // Buat tooltip
  tooltip.className = "recorder-tooltip";
  tooltip.innerHTML = `
    <div style="font-weight: bold; margin-bottom: 4px;">
      ${options.isError ? "🚫 Error Message" : "✅ Success Message"}
    </div>
    <div>${options.text}</div>
  `;

  // Posisikan tooltip
  const tooltipX = rect.left + window.scrollX;
  const tooltipY = rect.top + window.scrollY - 25;
  tooltip.style.left = `${tooltipX}px`;
  tooltip.style.top = `${tooltipY}px`;

  // Tambahkan event click untuk merekam assertVisible
  overlay.addEventListener("click", () => {
    if (!isRecording) return;

    recordAction("assert", element, {
      command: "assertVisible",
      value: "",
      isError: options.isError,
    });

    // Animasi klik
    overlay.classList.remove("recorder-hover-overlay");
    overlay.classList.add("recorder-click-overlay");
    setTimeout(() => {
      removeOverlay();
    }, 500);
  });

  document.body.appendChild(overlay);
  document.body.appendChild(tooltip);

  currentOverlay = overlay;
  currentTooltip = tooltip;
}

// Tambah handler untuk right click
function handleRightClick(e) {
  console.log('[Recorder] handleRightClick event:', e);
  if (!isRecording) return;

  e.preventDefault(); // Prevent default context menu
  const element = e.target;

  // Abaikan klik pada control panel dan overlay
  if (
    element.closest(".recorder-controls") ||
    element.classList.contains("recorder-hover-overlay") ||
    element.classList.contains("recorder-tooltip")
  )
    return;

  // Tampilkan menu assertion
  showAssertionMenu(e.clientX, e.clientY, element);
}

// Fungsi untuk menampilkan menu assertion
function showAssertionMenu(x, y, element) {
  console.log('[Recorder] showAssertionMenu called', { x, y, element });
  // Hapus menu yang mungkin sudah ada
  removeAssertionMenu();

  const menu = document.createElement("div");
  menu.className = "recorder-assertion-menu";
  menu.innerHTML = `
    <div class="menu-item" data-mode="chain">Chain Assertion to Previous Action</div>
    <div class="menu-item" data-mode="standalone">Standalone Assertion</div>
  `;

  // Posisikan menu di posisi klik kanan
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.style.background = 'white';
  menu.style.zIndex = 999999;
  menu.style.position = 'fixed';
  menu.style.display = 'block';
  menu.style.opacity = 1;
  menu.style.pointerEvents = 'auto';
  console.log('[Recorder] showAssertionMenu: menu element created', menu);

  document.body.appendChild(menu);
  console.log('[Recorder] showAssertionMenu: menu appended to body', menu);

  // Event listeners untuk menu items
  menu.addEventListener("click", (e) => {
    const menuItem = e.target;
    if (menuItem.classList.contains("menu-item")) {
      const mode = menuItem.dataset.mode;
      if (mode === "chain" || mode === "standalone") {
        // Tampilkan submenu assertion type
        showAssertionTypeSubmenu(x + 180, y, element, mode);
        removeAssertionMenu();
      }
    }
  });
}

function showAssertionTypeSubmenu(x, y, element, mode) {
  removeAssertionMenu();
  const submenu = document.createElement("div");
  submenu.className = "recorder-assertion-menu";
  submenu.innerHTML = `
    <div class="menu-item" data-type="elementText">Assert: Element Text</div>
    <div class="menu-item" data-type="elementVisible">Assert: Element Visible</div>
    <div class="menu-item" data-type="elementClass">Assert: Element Class</div>
    <div class="menu-item" data-type="elementValue">Assert: Element Value</div>
  `;
  submenu.style.left = `${x}px`;
  submenu.style.top = `${y}px`;
  submenu.addEventListener("click", (e) => {
    const menuItem = e.target;
    if (menuItem.classList.contains("menu-item")) {
      const type = menuItem.dataset.type;
      if (type) {
        // Buat assertion data lengkap
        let assertion = {
          command: "assertVisible",
          action: "assert",
          value: type === "elementText" ? element.textContent?.trim() : (type === "elementClass" ? element.className : (type === "elementValue" ? (element.value ?? "") : "")),
          type: type
        };
        if (type === "elementText" || type === "elementValue") {
          assertion.match = "equals";
          assertion.condition = "visible";
          assertion.selector = element.className;
        } else if (type === "elementClass") {
          assertion.match = "contains";
          assertion.condition = "visible";
          assertion.selector = element.className;
        }
        if (type === "elementVisible") {
          assertion.condition = "visible";
          assertion.selector = element.className;
        }
        if (mode === "chain") {
          // Chain ke action terakhir
          const last = recordedData[recordedData.length - 1];
          if (last && !last.assertAfter) {
            last.assertAfter = [];
          }
          if (last) {
            last.assertAfter.push(assertion);
          } else {
            recordAction("assert", element, assertion);
          }
          if (isRecording) {
            chrome.storage.local.set({ recordedData: recordedData }, () => {
              console.log('[Recorder] chrome.storage.local.set done:', recordedData);
            });
          }
          console.log("Assertion chained to last action:", assertion);
        } else {
          recordAction("assert", element, assertion);
        }
        removeAssertionMenu();
      }
    }
  });
  document.body.appendChild(submenu);
  document.body.appendChild(menu);
}

function removeAssertionMenu() {
  const menu = document.querySelector(".recorder-assertion-menu");
  if (menu) menu.remove();
}

document.addEventListener("contextmenu", handleRightClick, true);
