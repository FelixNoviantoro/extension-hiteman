let isRecording = false;
let recordedData = [];
let inputBuffer = {}; // Untuk menyimpan input sementara
let observer = null; // Untuk mutation observer
let isTargetPage = false; // Flag untuk menandai halaman target
let currentOverlay = null;
let currentTooltip = null;

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
function transformStepsForExport(rawSteps) {
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) return [];

  const out = [];
  for (let i = 0; i < rawSteps.length; i++) {
    const step = rawSteps[i];
    out.push(step);

    const next = rawSteps[i + 1];
    try {
      const curUrl = step && step._metadata && step._metadata.pageUrl;
      const nextUrl = next && next._metadata && next._metadata.pageUrl;

      if (next && curUrl && nextUrl && curUrl !== nextUrl) {
        // Insert a waitForURL step so exported Playwright scripts wait for
        // the app's URL to change (SPA-friendly). Also insert a selector
        // wait and a visibility expectation when we have a stable selector
        // on the next step.
        out.push({ action: 'waitForURL', url: nextUrl, _metadata: { inserted: true, pageUrl: nextUrl } });

        if (next.selector) {
          out.push({ action: 'waitForSelector', selector: next.selector, _metadata: { inserted: true } });
          out.push({ action: 'expectVisible', selector: next.selector, _metadata: { inserted: true } });
        } else {
          out.push({ action: 'waitForLoadState', state: 'networkidle', _metadata: { inserted: true } });
        }
      }
    } catch (err) {
      // ignore errors and continue
    }
  }

  return out;
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
        try { console.log('[Recorder] exitBtn pointerdown', { target: e.target, time: Date.now() }); } catch(err){}
      }, true);
      exitBtnEl.addEventListener('mousedown', (e) => {
        try { console.log('[Recorder] exitBtn mousedown', { target: e.target, time: Date.now() }); } catch(err){}
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

    try {
      console.log('[Recorder] generatePlaywrightScriptFromSteps: steps length', (steps && steps.length) || 0);
      console.log('[Recorder] generatePlaywrightScriptFromSteps: pageUrl sequence', (steps || []).map(s => (s && s._metadata && s._metadata.pageUrl) || null));
    } catch (err) {
      console.warn('[Recorder] generatePlaywrightScriptFromSteps: failed to log step metadata', err);
    }

    // Track current known page URL to detect implicit page changes.
    let currentUrl = (steps && steps.length > 0 && steps[0]._metadata && steps[0]._metadata.pageUrl) ? steps[0]._metadata.pageUrl : '';

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

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const next = steps[i + 1];
      const act = step.action || step.command;

      const stepUrl = step._metadata && step._metadata.pageUrl;

      // If the recorded step's pageUrl changed compared to our currentUrl and
      // the navigation was NOT already caused by the previous step's click, then
      // emit an explicit goto to ensure the script is on the correct page.
      try {
        const prev = steps[i - 1];
        const prevCausedNav = prev && prev.action === 'click' && prev._metadata && prev._metadata.pageUrl && stepUrl && prev._metadata.pageUrl !== stepUrl;

        if (stepUrl && currentUrl && stepUrl !== currentUrl && !prevCausedNav && act !== 'goto' && act !== 'open') {
          // Prefer waiting for the URL to reach a known pattern instead of forcing a goto.
          const pattern = urlToPattern(stepUrl);
          script += `  await page.waitForURL('${esc(pattern)}');\n`;
          if (step.selector) {
            script += `  await page.waitForSelector('${esc(step.selector)}');\n`;
            script += `  await expect(page.locator('${esc(step.selector)}')).toBeVisible();\n`;
          } else if (next && next.selector) {
            script += `  await page.waitForSelector('${esc(next.selector)}');\n`;
            script += `  await expect(page.locator('${esc(next.selector)}')).toBeVisible();\n`;
          } else {
            script += `  await page.waitForLoadState('networkidle');\n`;
          }
          currentUrl = stepUrl;
        }
      } catch (err) {
        // ignore errors in URL handling
      }

      // Navigation / open explicit
      if (act === 'goto' || act === 'open') {
        const url = step.url || step.value || '';
        script += `  await page.goto('${esc(url)}');\n`;
        if (next && next.selector) {
          script += `  await page.waitForSelector('${esc(next.selector)}');\n`;
        } else {
          script += `  await page.waitForLoadState('networkidle');\n`;
        }
        currentUrl = step._metadata && step._metadata.pageUrl ? step._metadata.pageUrl : currentUrl;
        continue;
      }

      // Click
      if (act === 'click' && step.selector) {
        // If this click causes navigation (detected by pageUrl change in recording), use the
        // Playwright navigation pattern to avoid races: await Promise.all([page.waitForNavigation(), page.click()])
        try {
          const curUrl = step._metadata && step._metadata.pageUrl;
          const nextUrl = next && next._metadata && next._metadata.pageUrl;

          if (next && curUrl && nextUrl && curUrl !== nextUrl) {
            // Use waitForURL pattern to detect SPA route change caused by click
            const pattern = urlToPattern(nextUrl);
            script += `  await Promise.all([page.click('${esc(step.selector)}'), page.waitForURL('${esc(pattern)}')]);\n`;
            if (next.selector) {
              script += `  await page.waitForSelector('${esc(next.selector)}');\n`;
              script += `  await expect(page.locator('${esc(next.selector)}')).toBeVisible();\n`;
            }
            currentUrl = nextUrl;
            continue;
          }

          // Fallback: treat anchors as navigation triggers
          const tag = step._metadata && step._metadata.elementInfo && step._metadata.elementInfo.tagName;
          if (tag === 'A') {
            // Anchor link: wait for URL change pattern rather than a navigation event
            try {
              if (next && next.selector) {
                const pattern = urlToPattern(next._metadata && next._metadata.pageUrl ? next._metadata.pageUrl : nextUrl);
                script += `  await Promise.all([page.click('${esc(step.selector)}'), page.waitForURL('${esc(pattern)}')]);\n`;
                script += `  await page.waitForSelector('${esc(next.selector)}');\n`;
                script += `  await expect(page.locator('${esc(next.selector)}')).toBeVisible();\n`;
                currentUrl = next && next._metadata && next._metadata.pageUrl ? next._metadata.pageUrl : currentUrl;
                continue;
              }
            } catch (err) {
              // fallback to previous behaviour if pattern generation fails
              script += `  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('${esc(step.selector)}')]);\n`;
              if (next && next.selector) script += `  await page.waitForSelector('${esc(next.selector)}');\n`;
              currentUrl = next && next._metadata && next._metadata.pageUrl ? next._metadata.pageUrl : currentUrl;
              continue;
            }
          }
        } catch (err) {
          // ignore and fall back to simple click
        }

        // Generic click when no navigation detected
        script += `  await page.click('${esc(step.selector)}');\n`;
        continue;
      }

      // Fill / type
      if ((act === 'fill' || act === 'type') && step.selector) {
        script += `  await page.fill('${esc(step.selector)}', '${esc(step.value || '')}');\n`;
        continue;
      }

      // Select option
      if ((act === 'selectOption') && step.selector) {
        script += `  await page.selectOption('${esc(step.selector)}', '${esc(step.value || '')}');\n`;
        continue;
      }

      // waitForURL (inserted by transform), expectVisible, or waitForSelector (assertVisible)
      if (act === 'waitForURL') {
        // Prefer explicit url field from the transformed step, but convert it
        // into a Playwright pattern using urlToPattern so the emitted code
        // uses '**/segment' style matching.
        const pattern = step.url ? urlToPattern(step.url) : (step._metadata && step._metadata.pageUrl ? urlToPattern(step._metadata.pageUrl) : '');
        script += `  await page.waitForURL('${esc(pattern)}');\n`;
        // If a selector is attached to this synthetic step, wait for and assert visibility
        if (step.selector) {
          script += `  await page.waitForSelector('${esc(step.selector)}');\n`;
          script += `  await expect(page.locator('${esc(step.selector)}')).toBeVisible();\n`;
        }
        continue;
      }

      if (act === 'expectVisible') {
        if (step.selector) {
          script += `  await expect(page.locator('${esc(step.selector)}')).toBeVisible();\n`;
        }
        continue;
      }

      if ((act === 'waitForSelector' || act === 'assert' || act === 'assertVisible') && step.selector) {
        script += `  await page.waitForSelector('${esc(step.selector)}');\n`;
        continue;
      }

      // Generic: if the next recorded step has a different pageUrl, insert a wait to let navigation complete
      try {
        if (next && step._metadata && next._metadata && step._metadata.pageUrl && next._metadata.pageUrl && step._metadata.pageUrl !== next._metadata.pageUrl) {
          if (next.selector) {
            script += `  await page.waitForSelector('${esc(next.selector)}');\n`;
          } else {
            script += `  await page.waitForLoadState('networkidle');\n`;
          }
          currentUrl = next._metadata.pageUrl;
        }
      } catch (err) {
        // ignore
      }
    }

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
  document.addEventListener("blur", handleBlur, true);
  document.addEventListener("submit", handleSubmit, true);

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
  document.removeEventListener("blur", handleBlur, true);
  document.removeEventListener("submit", handleSubmit, true);
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

  if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
    // Simpan value ke buffer
    inputBuffer[getUniqueElementKey(element)] = {
      element: element,
      value: element.value,
      timestamp: new Date(),
    };
  }
}

// Tambahkan event untuk blur (ketika input selesai)
function handleBlur(e) {
  if (!isRecording) return;

  const element = e.target;
  const bufferKey = getUniqueElementKey(element);

  if (inputBuffer[bufferKey]) {
    recordAction("type", element, {
      command: "fill",
      value: element.value,
    });

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
  }, 1000);
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

// Fungsi untuk mendapatkan selector terbaik untuk Playwright
function getBestPlaywrightSelector(element) {
  // 1. Data-testid atau data-cy (prioritaskan ini)
  if (element.dataset) {
    const testId = element.dataset.testid || element.dataset.cy;
    if (testId) {
      return `[data-testid="${testId}"]`;
    }
  }

  // 2. ID yang unik
  if (element.id && document.querySelectorAll(`#${element.id}`).length === 1) {
    return `#${element.id}`;
  }

  // 3. Untuk input elements, prioritaskan aria-label
  if (element.tagName === "INPUT" && element.getAttribute("aria-label")) {
    return `input[aria-label="${element.getAttribute("aria-label")}"]`;
  }

  // 4. Name attribute yang unik
  if (element.name && document.getElementsByName(element.name).length === 1) {
    return `[name="${element.name}"]`;
  }

  // 5. Placeholder yang unik untuk input
  if (element.placeholder) {
    const samePlaceholder = document.querySelectorAll(
      `[placeholder="${element.placeholder}"]`
    );
    if (samePlaceholder.length === 1) {
      return `[placeholder="${element.placeholder}"]`;
    }
  }

  // 6. Role attribute
  if (element.getAttribute("role")) {
    const role = element.getAttribute("role");
    const sameRole = document.querySelectorAll(`[role="${role}"]`);
    if (sameRole.length === 1) {
      return `[role="${role}"]`;
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
      return element.tagName === "A" 
        ? `text=${text}` 
        : `button:has-text("${text}")`;
    }
  }

  // 8. Untuk image elements
  if (element.tagName === "IMG" && element.alt) {
    return `img[alt="${element.alt}"]`;
  }

  // 9. CSS selector yang unik
  const cssSelector = buildPlaywrightCssSelector(element);
  if (cssSelector) {
    return cssSelector;
  }

  // 10. XPath sebagai fallback
  return getPlaywrightXPath(element);
}

function buildPlaywrightCssSelector(element) {
  console.log('[Recorder] buildPlaywrightCssSelector called for element:', element);
  // Coba selector sederhana terlebih dahulu
  let selector = element.tagName.toLowerCase();

  // Tambahkan type untuk input, button, dan select
  // Hanya gunakan attribute `type` jika atribut tersebut secara eksplisit ada di DOM.
  // Jangan andalkan `element.type` saja karena browser bisa memberikan default (mis. button -> "submit").
  if (element.hasAttribute && element.hasAttribute('type') && ["INPUT", "BUTTON", "SELECT"].includes(element.tagName)) {
    selector += `[type="${element.getAttribute('type')}"]`;
  }

  // Tambahkan class yang meaningful
  if (element.className) {
    let classStr = '';
    if (typeof element.className === 'string') {
      classStr = element.className;
    } else if (typeof element.className.baseVal === 'string') {
      // For SVG elements (SVGAnimatedString)
      classStr = element.className.baseVal;
    }
    if (classStr) {
      const classes = classStr
        .split(" ")
        .filter((c) => c && !c.match(/^[0-9]/) && c.length > 2)
        .slice(0, 2); // Ambil maksimal 2 class

      if (classes.length > 0) {
        selector += "." + classes.join(".");
      }
    }
  }

  // Cek apakah selector sudah unik
  if (document.querySelectorAll(selector).length === 1) {
    return selector;
  }

  // Jika tidak unik, coba tambahkan :nth-of-type berdasarkan posisi relatif elemen
  try {
    const candidates = Array.from(document.querySelectorAll(selector));
    const index = candidates.indexOf(element);
    if (index > -1) {
      const nthSelector = `${selector}:nth-of-type(${index + 1})`;
      if (document.querySelectorAll(nthSelector).length === 1) {
        return nthSelector;
      }
    }
  } catch (err) {
    // Jika querySelectorAll gagal karena selector invalid, lanjutkan ke parent-scoped strategy
  }

  // Jika masih belum unik, buat selector dengan parent context
  let parent = element.parentElement;
  if (parent) {
    let parentSelector = parent.tagName.toLowerCase();
    
    // Tambahkan parent class jika ada
    if (parent.className) {
      const parentClass = parent.className
        .split(" ")
        .filter((c) => c && !c.match(/^[0-9]/) && c.length > 2)[0];
      
      if (parentClass) {
        parentSelector += "." + parentClass;
      }
    }
    
    const combinedSelector = `${parentSelector} ${selector}`;
    if (document.querySelectorAll(combinedSelector).length === 1) {
      return combinedSelector;
    }

    // Jika masih tidak unik, coba tambahkan :nth-of-type pada elemen dalam konteks parent
    try {
      const actualParent = element.parentElement;
      if (actualParent) {
        const siblings = Array.from(actualParent.children).filter(c => c.tagName === element.tagName);
        const idx = siblings.indexOf(element);
        if (idx > -1) {
          const parentScoped = `${parentSelector} > ${element.tagName.toLowerCase()}:nth-of-type(${idx + 1})`;
          if (document.querySelectorAll(parentScoped).length === 1) {
            return parentScoped;
          }
        }
      }
    } catch (err) {
      // ignore and fallback
    }
  }

  // Jika masih tidak unik, coba naik level ancestor dan gunakan ancestor-scoped selector
  // Contoh: `table tbody tr:nth-of-type(3) button.btn`
  try {
    let ancestor = element.parentElement;
    let depth = 0;
    while (ancestor && depth < 6) {
      const ancTag = ancestor.tagName.toLowerCase();

      // Jika ancestor punya id yang unik, gunakan itu langsung
      if (ancestor.id && document.querySelectorAll(`#${ancestor.id}`).length === 1) {
        const ancSel = `#${ancestor.id}`;
        const cand = `${ancSel} ${selector}`;
        if (document.querySelectorAll(cand).length === 1) return cand;
        // coba nth-of-type di dalam parent of ancestor
        const parentOfAnc = ancestor.parentElement;
        if (parentOfAnc) {
          const sameTagSiblings = Array.from(parentOfAnc.children).filter(c => c.tagName === ancestor.tagName);
          const ancIdx = sameTagSiblings.indexOf(ancestor);
          if (ancIdx > -1) {
            const ancNth = `${parentOfAnc.tagName.toLowerCase()} > ${ancTag}:nth-of-type(${ancIdx + 1})`;
            const cand2 = `${ancNth} ${selector}`;
            if (document.querySelectorAll(cand2).length === 1) return cand2;
          }
        }
      }

      // Build a simple ancestor selector (tag + one meaningful class)
      let ancSelector = ancTag;
      if (ancestor.className) {
        const ancClass = ancestor.className.split(' ').filter(c => c && !c.match(/^[0-9]/) && c.length > 2)[0];
        if (ancClass) ancSelector += `.${ancClass}`;
      }

      const cand = `${ancSelector} ${selector}`;
      if (document.querySelectorAll(cand).length === 1) return cand;

      // try ancestor nth-of-type
      const parentOfAncestor = ancestor.parentElement;
      if (parentOfAncestor) {
        const siblings = Array.from(parentOfAncestor.children).filter(c => c.tagName === ancestor.tagName);
        const ancIndex = siblings.indexOf(ancestor);
        if (ancIndex > -1) {
          const ancNth = `${ancSelector}:nth-of-type(${ancIndex + 1})`;
          const cand2 = `${ancNth} ${selector}`;
          if (document.querySelectorAll(cand2).length === 1) return cand2;
        }
      }

      ancestor = ancestor.parentElement;
      depth++;
    }
  } catch (err) {
    // fallback to end
  }

  return selector;
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
  console.log('[Recorder] showAssertionMenu called', {x, y, element});
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
