// ============================================
// CONFIGURATION & STATE
// ============================================

let isRecording = false;
let recordedData = [];
let inputBuffer = {};
let observer = null;
let isTargetPage = false;
let currentOverlay = null;
let currentTooltip = null;
let lastClickedElement = null;
let lastHoveredElement = null;
let hoverStartTime = null;
let hoverTimeout = null;

const HOVER_CONFIG = {
  minHoverTime: 3000,
  maxHoverTime: 5000,
  debounceTime: 300
};

// ============================================
// INITIALIZATION & MESSAGE HANDLING
// ============================================

chrome.storage.local.get(["isRecording", "recordedData"], (result) => {
  if (result.isRecording) {
    isRecording = true;
    recordedData = result.recordedData || [];
    isTargetPage = true;
    addControlPanel();
    startRecording();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "startRecording") {
    isTargetPage = true;
    isRecording = true;
    recordedData = [];

    chrome.storage.local.set({
      isRecording: true,
      recordedData: recordedData,
    });

    recordAction("open", document.body, {
      command: "open",
      value: window.location.href,
    });

    chrome.runtime.sendMessage({ action: "startRecording" }, (response) => {
      if (chrome.runtime.lastError) {
        console.log("Background script error:", chrome.runtime.lastError);
      }
      addControlPanel();
      startRecording();
      sendResponse({ status: "Recording started" });
    });
    return true;
  } else if (message.action === "resetStorage") {
    sessionStorage.clear();
    sendResponse({ status: "Storage cleared" });
  } else if (message.action === "stopAndDownload") {
    isRecording = false;
    chrome.storage.local.set({ isRecording: false, recordedData: [] });
    stopRecording();
    sendResponse({ status: "Recording stopped", data: recordedData });
  } else if (message.action === "RESTORE_RECORDING") {
    const status = message.data;
    if (status && status.type === "RECORDING_STARTED") {
      isRecording = true;
      isTargetPage = true;
      addControlPanel();
      startRecording();
    }
    sendResponse({ status: "Restored" });
  }
});

// ============================================
// CONTROL PANEL FUNCTIONS
// ============================================

function addControlPanel() {
  removeControlPanel();
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
  controls.style.pointerEvents = 'auto';

  setupDragAndDrop(controls);
  setupControlButtons(controls);
}

function removeControlPanel() {
  const existingPanel = document.querySelector(".recorder-controls");
  if (existingPanel) existingPanel.remove();
}

function setupDragAndDrop(controls) {
  let isDragging = false;
  let currentX, currentY, initialX, initialY, xOffset = 0, yOffset = 0;

  const dragStart = (e) => {
    if (e.target.closest(".stop-btn")) return;
    initialX = e.type === "mousedown" ? e.clientX - xOffset : e.touches[0].clientX - xOffset;
    initialY = e.type === "mousedown" ? e.clientY - yOffset : e.touches[0].clientY - yOffset;

    if (e.target === controls || e.target.closest(".recorder-handle")) {
      isDragging = true;
    }
  };

  const dragEnd = () => { isDragging = false; };

  const drag = (e) => {
    if (isDragging) {
      e.preventDefault();
      currentX = e.type === "mousemove" ? e.clientX - initialX : e.touches[0].clientX - initialX;
      currentY = e.type === "mousemove" ? e.clientY - initialY : e.touches[0].clientY - initialY;
      xOffset = currentX;
      yOffset = currentY;
      setTranslate(currentX, currentY, controls);
    }
  };

  const setTranslate = (xPos, yPos, el) => {
    const rect = el.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width;
    const maxY = window.innerHeight - rect.height;
    xPos = Math.min(Math.max(0, xPos), maxX);
    yPos = Math.min(Math.max(0, yPos), maxY);
    el.style.transform = `translate3d(${xPos}px, ${yPos}px, 0)`;
  };

  controls.addEventListener("mousedown", dragStart);
  controls.addEventListener("touchstart", dragStart);
  document.addEventListener("mousemove", drag);
  document.addEventListener("touchmove", drag);
  document.addEventListener("mouseup", dragEnd);
  document.addEventListener("touchend", dragEnd);
}

function setupControlButtons(controls) {
  const stopBtnEl = controls.querySelector('#stopBtn');
  const downloadBtnEl = controls.querySelector('#downloadBtn');
  const downloadScriptBtnEl = controls.querySelector('#downloadScriptBtn');
  const exitBtnEl = controls.querySelector('#exitBtn');

  if (stopBtnEl) {
    stopBtnEl.addEventListener('click', handleStopButton);
  }

  if (downloadBtnEl) {
    downloadBtnEl.addEventListener('click', () => {
      downloadBtnEl.style.pointerEvents = 'auto';
      const exported = transformStepsForExport(recordedData || []);
      chrome.runtime.sendMessage({ action: 'DOWNLOAD_JSON', data: exported });
    });
  }

  if (downloadScriptBtnEl) {
    downloadScriptBtnEl.addEventListener("click", () => {
      chrome.storage.local.get(["recordedData"], (result) => {
        const rawSteps = result.recordedData || recordedData || [];
        const steps = transformStepsForExport(rawSteps);
        const script = generatePlaywrightScriptFromSteps(steps);
        downloadFile(script, `playwright-script-${new Date().toISOString().replace(/[:.]/g, "-")}.js`, "text/javascript");
      });
    });
  }

  if (exitBtnEl) {
    exitBtnEl.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'EXIT_RECORDING' });
    });
  }
}

function handleStopButton() {
  try {
    isRecording = false;
    stopRecording();

    const stepsWithWaits = transformStepsForExport(recordedData || []);
    const recordingData = {
      timestamp: new Date().toISOString(),
      data: stepsWithWaits,
      type: 'RECORDING_COMPLETED'
    };

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

    chrome.runtime.sendMessage({ action: 'RECORDING_COMPLETED', data: recordingData });

    if (window.opener) {
      window.opener.postMessage({ type: 'RECORDING_COMPLETED', data: recordingData, playwrightData }, 'http://localhost:4200');
    }

    updateUIAfterStop();
  } catch (err) {
    console.error('[Recorder] stopBtn handler error:', err);
  }
}

function updateUIAfterStop() {
  const stopBtnEl = document.querySelector('#stopBtn');
  const downloadBtnEl = document.querySelector('#downloadBtn');
  const downloadScriptBtnEl = document.querySelector('#downloadScriptBtn');
  const exitBtnEl = document.querySelector('#exitBtn');
  const statusEl = document.querySelector('.recorder-status');

  if (stopBtnEl) stopBtnEl.style.display = 'none';
  if (downloadBtnEl) downloadBtnEl.style.display = 'block';
  if (downloadScriptBtnEl) downloadScriptBtnEl.style.display = 'block';
  if (exitBtnEl) exitBtnEl.style.display = 'block';
  if (statusEl) {
    statusEl.textContent = 'Recording completed';
    statusEl.classList.remove('recording');
  }
}

// ============================================
// RECORDING CONTROL FUNCTIONS
// ============================================

function startRecording() {
  document.addEventListener("click", handleClick, true);
  document.addEventListener("contextmenu", handleRightClick, true);
  document.addEventListener("change", handleChange, true);
  document.addEventListener("input", handleInput, true);
  document.addEventListener("keyup", handleInput, true);
  document.addEventListener("blur", handleBlur, true);
  document.addEventListener("mouseover", handleHover, true);
  document.addEventListener("mouseout", handleMouseOut, true);
  startObserver();
}

function stopRecording() {
  document.removeEventListener("click", handleClick, true);
  document.removeEventListener("contextmenu", handleRightClick, true);
  document.removeEventListener("change", handleChange, true);
  document.removeEventListener("input", handleInput, true);
  document.removeEventListener("keyup", handleInput, true);
  document.removeEventListener("blur", handleBlur, true);
  document.removeEventListener("mouseover", handleHover, true);
  document.removeEventListener("mouseout", handleMouseOut, true);

  if (hoverTimeout) {
    clearTimeout(hoverTimeout);
    hoverTimeout = null;
  }
  lastHoveredElement = null;
  hoverStartTime = null;
  inputBuffer = {};

  if (observer) observer.disconnect();
  removeOverlay();
}

function cleanup() {
  if (!isRecording) {
    chrome.storage.local.set({ isRecording: false, recordedData: [] });
  }
  inputBuffer = {};
  if (observer) observer.disconnect();
  removeControlPanel();
  removeOverlay();
}

window.addEventListener("unload", cleanup);

// ============================================
// EVENT HANDLERS
// ============================================

function handleClick(e) {
  if (!isRecording) return;
  const element = e.target;

  if (element.closest(".recorder-controls") ||
    element.classList.contains("recorder-hover-overlay") ||
    element.classList.contains("recorder-tooltip")) return;

  showOverlay(element, "click");
  setTimeout(() => {
    if (currentOverlay && currentOverlay.classList.contains("recorder-click-overlay")) {
      removeOverlay();
    }
  }, 500);

  if (element.tagName === "IMG") {
    recordAction("click", element, { command: "click", value: "" });
    return;
  }

  if (element.tagName === "A") {
    recordAction("click", element, { command: "click", value: "" });
  } else if (element.tagName === "BUTTON" ||
    (element.tagName === "INPUT" && ["button", "submit", "reset"].includes(element.type))) {
    recordAction("click", element, { command: "click", value: "" });
  } else if (element.tagName === "INPUT" && ["checkbox", "radio"].includes(element.type)) {
    return;
  } else {
    recordAction("click", element, { command: "click", value: "" });
  }
}

function handleHover(e) {
  if (!isRecording) return;
  const element = e.target;

  if (element.closest(".recorder-controls") ||
    element.classList.contains("recorder-hover-overlay") ||
    element.classList.contains("recorder-tooltip")) return;

  if (hoverTimeout) {
    clearTimeout(hoverTimeout);
    hoverTimeout = null;
  }

  if (element !== lastHoveredElement) {
    lastHoveredElement = element;
    hoverStartTime = Date.now();
    hoverTimeout = setTimeout(() => {
      recordHoverAction(element);
    }, HOVER_CONFIG.minHoverTime);
  }

  showOverlay(element, "hover");
}

function handleMouseOut(e) {
  if (!isRecording) return;
  if (hoverTimeout) {
    clearTimeout(hoverTimeout);
    hoverTimeout = null;
  }
  lastHoveredElement = null;
  hoverStartTime = null;
  removeOverlay();
}

function handleChange(e) {
  if (!isRecording) return;
  const element = e.target;
  if (element.tagName === "SELECT") {
    recordAction("select", element, { command: "selectOption", value: element.value });
  }
}

function handleInput(e) {
  if (!isRecording) return;
  const element = e.target;
  if (element.tagName !== "INPUT" && element.tagName !== "TEXTAREA") return;

  const type = (element.type || "").toLowerCase();
  const textLikeInputTypes = new Set(["text", "search", "email", "password", "tel", "url", "number"]);

  if (element.tagName === "TEXTAREA" || textLikeInputTypes.has(type)) {
    const key = getUniqueElementKey(element);
    inputBuffer[key] = { element, value: element.value, timestamp: new Date() };
  }
}

function handleBlur(e) {
  if (!isRecording) return;
  const element = e.target;
  const bufferKey = getUniqueElementKey(element);
  const tag = element.tagName;
  const textLikeInputTypes = new Set(['text', 'search', 'email', 'password', 'tel', 'url', 'number']);

  if (inputBuffer[bufferKey] && (tag === 'TEXTAREA' || (tag === 'INPUT' && textLikeInputTypes.has((element.type || '').toLowerCase())))) {
    let selectorToUse = null;
    try {
      const lastAction = recordedData.length > 0 ? recordedData[recordedData.length - 1] : null;
      if (lastAction && lastAction.action === 'click' && lastAction.selector) {
        const matches = element.matches(lastAction.selector);
        if (matches) selectorToUse = lastAction.selector;
      }
    } catch (err) {
      // Fall through
    }

    if (!selectorToUse) selectorToUse = getBestPlaywrightSelector(element);

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
    if (isRecording) {
      chrome.storage.local.set({ recordedData: recordedData });
    }
    delete inputBuffer[bufferKey];
  }
}

function handleRightClick(e) {
  if (!isRecording) return;
  e.preventDefault();
  const element = e.target;

  if (element.closest(".recorder-controls") ||
    element.classList.contains("recorder-hover-overlay") ||
    element.classList.contains("recorder-tooltip")) return;

  showAssertionMenu(e.clientX, e.clientY, element);
}

// ============================================
// ACTION RECORDING FUNCTIONS
// ============================================

function recordAction(type, element, data) {
  const selector = getBestPlaywrightSelector(element);

  if (type === "assert" && data.type && ["elementText", "elementVisible", "elementClass", "elementValue"].includes(data.type)) {
    recordedData.push(data);
    if (isRecording) chrome.storage.local.set({ recordedData: recordedData });
    return;
  }

  let action = {
    action: mapToPlaywrightAction(data.command, type),
    selector: selector
  };

  if (data.value && shouldIncludeValue(data.command)) {
    action.value = data.value;
  }

  if (data.command === "open") {
    action = { action: "goto", url: data.value };
  }

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
  if (isRecording) chrome.storage.local.set({ recordedData: recordedData });
}

function recordHoverAction(element) {
  if (!isRecording || !element) return;
  const selector = getBestPlaywrightSelector(element);
  const hoverDuration = Date.now() - hoverStartTime;

  const action = {
    action: 'hover',
    selector: selector,
    duration: Math.min(hoverDuration, HOVER_CONFIG.maxHoverTime),
    _metadata: {
      timestamp: new Date().toISOString(),
      pageUrl: window.location.href,
      originalCommand: 'hover',
      elementInfo: {
        tagName: element.tagName,
        id: element.id,
        className: element.className,
        text: element.textContent?.trim()
      }
    }
  };

  recordedData.push(action);
  if (isRecording) chrome.storage.local.set({ recordedData: recordedData });
  lastHoveredElement = null;
  hoverStartTime = null;
  hoverTimeout = null;
}

function mapToPlaywrightAction(command, type) {
  const actionMap = {
    'click': 'click',
    'fill': 'fill',
    'type': 'fill',
    'select': 'selectOption',
    'selectOption': 'selectOption',
    'check': 'check',
    'uncheck': 'uncheck',
    'submit': 'click',
    'assertVisible': 'waitForSelector',
    'hover': 'hover'
  };
  return actionMap[command] || 'click';
}

function shouldIncludeValue(command) {
  const commandsWithValue = ['fill', 'type', 'select', 'selectOption'];
  return commandsWithValue.includes(command);
}

// ============================================
// SELECTOR UTILITIES
// ============================================

function stripAngularClasses(selector) {
  if (!selector || typeof selector !== 'string') return selector;
  let cleaned = selector.replace(/\.ng-\w+/g, '');
  cleaned = cleaned.replace(/-inserted(?=\.|:|$)/g, '');
  cleaned = cleaned.replace(/\.$/, '');
  cleaned = cleaned.replace(/\.(?=\.)/g, '');
  return cleaned;
}

function isValidSelector(selector) {
  try {
    document.querySelector(selector);
    return true;
  } catch (error) {
    return false;
  }
}

function buildSimpleSelector(element) {
  if (element.id && !element.id.match(/^[0-9]/)) {
    return `#${CSS.escape(element.id)}`;
  }

  const dataAttributes = ['data-testid', 'data-cy', 'data-id', 'data-qa'];
  for (const attr of dataAttributes) {
    if (element.hasAttribute(attr)) {
      const value = element.getAttribute(attr);
      if (value) return `[${attr}="${CSS.escape(value)}"]`;
    }
  }

  if (element.hasAttribute('role')) {
    return `${element.tagName.toLowerCase()}[role="${CSS.escape(element.getAttribute('role'))}"]`;
  }

  return element.tagName.toLowerCase();
}

function getBestPlaywrightSelector(element) {

  // ============================================================
  // UTILITIES
  // ============================================================

  const isUnique = (sel) => {
    // Only return true if exactly one element matches the selector.
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch (_) {
      return false;
    }
  };

  const clean = (selector) =>
    // Removes common framework-specific attributes/classes (Angular, Material, etc.)
    selector.replace(/(ng-|cdk-|mat-|_ngcontent)[^\s"'=]*/g, "");

  const textOf = (el) =>
    // Extracts and cleans visible text (trims, collapses multiple spaces)
    el.textContent?.trim().replace(/\s+/g, " ") || "";

  const visibleText = textOf(element);

  const escape = CSS.escape;

  // Tailwind-safe class extraction
  const getMeaningfulClasses = (el) => {
    if (!el.classList) return [];
    return Array.from(el.classList).filter(cls => {
      // remove framework / utility classes
      return !(
        // Common Tailwind utility classes to ignore
        /^(p-|m-|gap-|grid-|flex-|rounded|w-|h-|text-|hover:|active:|focus:)/.test(cls) ||
        // Common framework artifacts
        /(ng-|cdk-|mat-|_ngcontent)/.test(cls)
      );
    });
  };

  // Click normalization: if SVG/Icon → find parent button/link
  const iconTags = ["SVG", "PATH", "I", "SPAN"];
  if (iconTags.includes(element.tagName)) {
    let p = element.parentElement;
    while (p && p !== document.body) {
      if (["BUTTON", "A"].includes(p.tagName) || p.getAttribute("role") === "button") {
        element = p;
        break;
      }
      p = p.parentElement;
    }
  }

  const tag = element.tagName.toLowerCase();

  // ============================================================
  // 1. data-testid / data-qa / data-cy (Highest Priority)
  // ============================================================
  if (element.dataset) {
    for (const k of ["testid", "qa", "cy"]) {
      if (element.dataset[k]) {
        const sel = `[data-${k}="${escape(element.dataset[k])}"]`;
        if (isUnique(sel)) return clean(sel);
      }
    }
  }

  // ============================================================
  // 2. ID (if clean & unique)
  // ============================================================
  if (element.id && !/^[0-9]/.test(element.id)) {
    const sel = `#${escape(element.id)}`;
    if (isUnique(sel)) return clean(sel);
  }

  // ============================================================
  // 3. Inputs (Form-Specific Attributes)
  // ============================================================
  if (tag === "input" || tag === "textarea" || tag === "select") {

    // 3A: name attribute (ADJUSTED for consistent uniqueness check)
    if (element.name) {
      const sel = `[name="${escape(element.name)}"]`;
      if (isUnique(sel)) return clean(sel);
    }

    // 3B: placeholder
    if (element.placeholder) {
      const sel = `[placeholder="${escape(element.placeholder)}"]`;
      if (isUnique(sel)) return clean(sel);
    }

    // NOTE: Removed redundant aria-label check here. 
    // It will be handled globally in step 6.
  }

  // ============================================================
  // 4. Button / Link text
  // ============================================================
  if (["button", "a"].includes(tag)) {
    if (visibleText && visibleText.length <= 40) {
      const all = Array.from(document.querySelectorAll(tag));
      const match = all.filter(el => textOf(el) === visibleText);
      if (match.length === 1) {
        // Use Playwright's :has-text() selector for text-based elements
        return `${tag}:has-text("${visibleText.replace(/"/g, '\\"')}")`;
      }
    }
  }

  // ============================================================
  // 5. Title attribute
  // ============================================================
  const title = element.getAttribute("title");
  if (title) {
    const sel = `${tag}[title="${escape(title)}"]`;
    if (isUnique(sel)) return clean(sel);
  }

  // ============================================================
  // 6. aria-label (Generic Accessibility Attribute)
  // ============================================================
  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) {
    const sel = `[aria-label="${escape(ariaLabel)}"]`;
    if (isUnique(sel)) return clean(sel);
  }

  // ============================================================
  // 7. Meaningful CSS classes
  // ============================================================
  const goodClasses = getMeaningfulClasses(element);
  if (goodClasses.length) {
    const sel = `${tag}.${goodClasses.map(escape).join(".")}`;
    if (isUnique(sel)) return clean(sel);
  }

  // ============================================================
  // 8. role="button" etc.
  // ============================================================
  const role = element.getAttribute("role");
  if (role) {
    const sel = `[role="${escape(role)}"]`;
    if (isUnique(sel)) return clean(sel);
  }

  // ============================================================
  // 9. nth-of-type fallback (Playwright recommended)
  // ============================================================
  if (element.parentElement) {
    const siblings = Array.from(element.parentElement.children)
      .filter(n => n.tagName.toLowerCase() === tag);

    if (siblings.length > 1) {
      const idx = siblings.indexOf(element) + 1;
      const sel = `${tag}:nth-of-type(${idx})`;
      if (isUnique(sel)) return clean(sel);
    }
  }

  // ============================================================
  // 10. XPath fallback (final)
  // ============================================================
  return `xpath=${getXPath(element)}`;

  // Simple XPath generator
  function getXPath(el) {
    if (el === document.body) return "/html/body";

    const ix = (sib, name) =>
      Array.from(sib.parentNode.children)
        .filter(n => n.tagName === name).indexOf(sib) + 1;

    return (
      getXPath(el.parentNode) +
      "/" +
      el.tagName.toLowerCase() +
      "[" +
      ix(el, el.tagName) +
      "]"
    );
  }
}



function isSelectorUnique(selector) {
  try {
    return document.querySelectorAll(selector).length === 1;
  } catch (error) {
    return false;
  }
}

function getBestPlaywrightSelector(element) {

  // ============================================================
  // UTILITIES
  // ============================================================

  const isUnique = (sel) => {
    // Only return true if exactly one element matches the selector.
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch (_) {
      return false;
    }
  };

  const clean = (selector) =>
    // Removes common framework-specific attributes/classes (Angular, Material, etc.)
    selector.replace(/(ng-|cdk-|mat-|_ngcontent)[^\s"'=]*/g, "");

  const textOf = (el) =>
    // Extracts and cleans visible text (trims, collapses multiple spaces)
    el.textContent?.trim().replace(/\s+/g, " ") || "";

  const visibleText = textOf(element);

  const escape = CSS.escape;

  // Tailwind-safe class extraction
  const getMeaningfulClasses = (el) => {
    if (!el.classList) return [];
    return Array.from(el.classList).filter(cls => {
      // remove framework / utility classes
      return !(
        // Common Tailwind utility classes to ignore
        /^(p-|m-|gap-|grid-|flex-|rounded|w-|h-|text-|hover:|active:|focus:)/.test(cls) ||
        // Common framework artifacts
        /(ng-|cdk-|mat-|_ngcontent)/.test(cls)
      );
    });
  };

  // Click normalization: if SVG/Icon → find parent button/link
  const iconTags = ["SVG", "PATH", "I", "SPAN"];
  if (iconTags.includes(element.tagName)) {
    let p = element.parentElement;
    while (p && p !== document.body) {
      if (["BUTTON", "A"].includes(p.tagName) || p.getAttribute("role") === "button") {
        element = p;
        break;
      }
      p = p.parentElement;
    }
  }

  const tag = element.tagName.toLowerCase();

  // ============================================================
  // 1. data-testid / data-qa / data-cy (Highest Priority)
  // ============================================================
  if (element.dataset) {
    for (const k of ["testid", "qa", "cy"]) {
      if (element.dataset[k]) {
        const sel = `[data-${k}="${escape(element.dataset[k])}"]`;
        if (isUnique(sel)) return clean(sel);
      }
    }
  }

  // ============================================================
  // 2. ID (if clean & unique)
  // ============================================================
  if (element.id && !/^[0-9]/.test(element.id)) {
    const sel = `#${escape(element.id)}`;
    if (isUnique(sel)) return clean(sel);
  }

  // ============================================================
  // 3. Inputs (Form-Specific Attributes)
  // ============================================================
  if (tag === "input" || tag === "textarea" || tag === "select") {

    // 3A: name attribute (ADJUSTED for consistent uniqueness check)
    if (element.name) {
      const sel = `[name="${escape(element.name)}"]`;
      if (isUnique(sel)) return clean(sel);
    }

    // 3B: placeholder
    if (element.placeholder) {
      const sel = `[placeholder="${escape(element.placeholder)}"]`;
      if (isUnique(sel)) return clean(sel);
    }

    // NOTE: Removed redundant aria-label check here. 
    // It will be handled globally in step 6.
  }

  // ============================================================
  // 4. Button / Link text
  // ============================================================
  if (["button", "a"].includes(tag)) {
    if (visibleText && visibleText.length <= 40) {
      const all = Array.from(document.querySelectorAll(tag));
      const match = all.filter(el => textOf(el) === visibleText);
      if (match.length === 1) {
        // Use Playwright's :has-text() selector for text-based elements
        return `${tag}:has-text("${visibleText.replace(/"/g, '\\"')}")`;
      }
    }
  }

  // ============================================================
  // 5. Title attribute
  // ============================================================
  const title = element.getAttribute("title");
  if (title) {
    const sel = `${tag}[title="${escape(title)}"]`;
    if (isUnique(sel)) return clean(sel);
  }

  // ============================================================
  // 6. aria-label (Generic Accessibility Attribute)
  // ============================================================
  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) {
    const sel = `[aria-label="${escape(ariaLabel)}"]`;
    if (isUnique(sel)) return clean(sel);
  }

  // ============================================================
  // 7. Meaningful CSS classes
  // ============================================================
  const goodClasses = getMeaningfulClasses(element);
  if (goodClasses.length) {
    const sel = `${tag}.${goodClasses.map(escape).join(".")}`;
    if (isUnique(sel)) return clean(sel);
  }

  // ============================================================
  // 8. role="button" etc.
  // ============================================================
  const role = element.getAttribute("role");
  if (role) {
    const sel = `[role="${escape(role)}"]`;
    if (isUnique(sel)) return clean(sel);
  }

  // ============================================================
  // 9. nth-of-type fallback (Playwright recommended)
  // ============================================================
  if (element.parentElement) {
    const siblings = Array.from(element.parentElement.children)
      .filter(n => n.tagName.toLowerCase() === tag);

    if (siblings.length > 1) {
      const idx = siblings.indexOf(element) + 1;
      const sel = `${tag}:nth-of-type(${idx})`;
      if (isUnique(sel)) return clean(sel);
    }
  }

  // ============================================================
  // 10. XPath fallback (final)
  // ============================================================
  return `xpath=${getXPath(element)}`;

  // Simple XPath generator
  function getXPath(el) {
    if (el === document.body) return "/html/body";

    const ix = (sib, name) =>
      Array.from(sib.parentNode.children)
        .filter(n => n.tagName === name).indexOf(sib) + 1;

    return (
      getXPath(el.parentNode) +
      "/" +
      el.tagName.toLowerCase() +
      "[" +
      ix(el, el.tagName) +
      "]"
    );
  }
}

function getDirectTextContent(element) {
  let text = '';
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
  }
  return text.trim();
}

function getMeaningfulClasses(element) {
  let classStr = '';
  if (typeof element.className === 'string') classStr = element.className;
  else if (typeof element.className?.baseVal === 'string') classStr = element.className.baseVal;
  if (!classStr) return [];

  const classes = classStr.split(' ').filter(Boolean);
  const hasNoIdentifier = !element.id && !element.getAttribute('name') && !element.getAttribute('title') && !getDirectTextContent(element);

  return classes.filter(className => {
    if (!className || className.length < 2) return false;
    if (className.match(/^[0-9]/)) return false;
    if (className.match(/^ng-/)) return false;
    if (className.match(/-inserted$/)) return false;
    if (className.match(/^_ng/)) return false;

    if (hasNoIdentifier) return true;
    if (className.match(/^(p-\d|m-\d|w-\d|h-\d)$/)) return false;
    if (className.match(/^(js-|is-|has-)/)) return true;
    if (className.match(/(menu|nav|btn|button|header|footer|sidebar|content|container|wrapper)/)) return true;
    if (className.match(/^(group|hover|focus|active|text-|bg-|border-|rounded)/)) return true;
    return className.length > 2;
  }).slice(0, 5);
}

function buildParentContextSelector(element, maxDepth = 4) {
  let currentElement = element;
  let depth = 0;
  let pathParts = [buildElementSelector(currentElement)];

  while (currentElement.parentElement && depth < maxDepth) {
    currentElement = currentElement.parentElement;
    if (currentElement.tagName === 'BODY' || currentElement.tagName === 'HTML') break;

    const parentSelector = buildElementSelector(currentElement);
    pathParts.unshift(parentSelector);
    const currentPath = pathParts.join(' > ');
    if (isSelectorUnique(currentPath)) return currentPath;
    depth++;
  }
  return null;
}

function buildElementSelector(element) {
  let selector = element.tagName.toLowerCase();
  if (element.id && !element.id.match(/^[0-9]/)) return `#${CSS.escape(element.id)}`;

  const meaningfulClasses = getMeaningfulClasses(element);
  if (meaningfulClasses.length > 0) selector += '.' + meaningfulClasses.join('.');

  if (element.parentElement) {
    const siblings = Array.from(element.parentElement.children);
    const sameTagSiblings = siblings.filter(sib => sib.tagName === element.tagName);

    if (sameTagSiblings.length > 1) {
      const index = sameTagSiblings.indexOf(element);
      if (index !== -1) {
        const nthOfTypeSelector = `${selector}:nth-of-type(${index + 1})`;
        if (isSelectorUnique(nthOfTypeSelector)) return nthOfTypeSelector;
        const allSiblingsIndex = siblings.indexOf(element);
        if (allSiblingsIndex !== -1) return `${selector}:nth-child(${allSiblingsIndex + 1})`;
      }
    }
  }
  return selector;
}

function buildTableContextSelector(element) {
  const row = element.closest('tr');
  if (!row) return null;

  let uniqueRowText = '';
  const cells = Array.from(row.querySelectorAll('td, th'));
  for (const cell of cells) {
    const text = cell.textContent?.trim();
    if (text && text.length > 5 && !/^[0-9.,\sR]+$/.test(text)) {
      uniqueRowText = text;
      break;
    }
  }
  if (!uniqueRowText) return null;

  const rowRootSelector = `tr:has-text("${CSS.escape(uniqueRowText)}")`;
  let pathSegment = '';
  let current = element;

  while (current && current !== row) {
    const tagName = current.tagName.toLowerCase();
    let currentSelector = tagName;
    const meaningfulClasses = getMeaningfulClasses(current);
    if (meaningfulClasses.length > 0) currentSelector += '.' + meaningfulClasses.join('.');
    pathSegment = currentSelector + (pathSegment ? ' > ' + pathSegment : '');
    current = current.parentElement;
  }

  return `${rowRootSelector} ${pathSegment}`;
}

function buildFullPathSelector(element) {
  const path = [];
  let currentElement = element;
  let ancestors = [];

  while (currentElement && currentElement.tagName !== 'HTML') {
    ancestors.unshift(currentElement);
    currentElement = currentElement.parentElement;
  }

  let startIndex = 0;
  for (let i = 0; i < ancestors.length; i++) {
    const ancestor = ancestors[i];
    if (ancestor.id && !ancestor.id.match(/^[0-9]/)) {
      startIndex = i;
      break;
    }
  }

  for (let i = startIndex; i < ancestors.length; i++) {
    const el = ancestors[i];
    let selector = el.tagName.toLowerCase();

    if (el.id && !el.id.match(/^[0-9]/)) {
      selector = `#${CSS.escape(el.id)}`;
      path.push(selector);
      continue;
    }

    const meaningfulClasses = getMeaningfulClasses(el);
    if (meaningfulClasses.length > 0) selector += '.' + meaningfulClasses.join('.');

    if (el.parentElement) {
      const siblings = Array.from(el.parentElement.children);
      const sameTagSiblings = siblings.filter(s => s.tagName === el.tagName);
      if (sameTagSiblings.length > 1) {
        const index = siblings.indexOf(el);
        if (index !== -1) selector += `:nth-child(${index + 1})`;
      }
    }
    path.push(selector);
  }
  return path.join(' > ');
}

function getPlaywrightXPath(element) {
  const parts = [];
  let current = element;

  while (current && current.nodeType === Node.ELEMENT_NODE) {
    let selector = current.tagName.toLowerCase();
    if (current.id) return `xpath=//*[@id="${current.id}"]`;

    const attributes = [];
    ["name", "class", "role", "type", "aria-label"].forEach((attr) => {
      const value = current.getAttribute(attr);
      if (value) attributes.push(`@${attr}="${value}"`);
    });

    if (attributes.length > 0) selector += `[${attributes.join(" and ")}]`;

    const siblings = current.parentNode ? Array.from(current.parentNode.children) : [];
    const similarSiblings = siblings.filter((sibling) => sibling.tagName === current.tagName);

    if (similarSiblings.length > 1) {
      const index = similarSiblings.indexOf(current) + 1;
      selector += `[${index}]`;
    }

    parts.unshift(selector);
    current = current.parentNode;
    if (parts.length >= 3) break;
  }

  return `xpath=//${parts.join("/")}`;
}

function getUniqueElementKey(element) {
  return element.id || element.name || getXPath(element);
}

function getXPath(element) {
  if (!element) return "";
  let paths = [];
  let current = element;

  while (current && current.nodeType === Node.ELEMENT_NODE) {
    let index = 1;
    if (current.id) {
      paths.unshift(`//*[@id="${current.id}"]`);
      break;
    }

    for (let sibling = current.previousSibling; sibling; sibling = sibling.previousSibling) {
      if (sibling.nodeType === Node.ELEMENT_NODE && sibling.tagName === current.tagName) index++;
    }

    let attributes = "";
    if (current.className) attributes += `[@class="${current.className}"]`;
    if (current.name) attributes += `[@name="${current.name}"]`;

    paths.unshift(`/${current.tagName.toLowerCase()}${attributes}[${index}]`);
    current = current.parentNode;
  }
  return paths.join("");
}

// ============================================
// OVERLAY FUNCTIONS
// ============================================

function showOverlay(element, type) {
  removeOverlay();
  const rect = element.getBoundingClientRect();

  const overlay = document.createElement("div");
  overlay.className = type === "hover" ? "recorder-hover-overlay" : "recorder-click-overlay";
  overlay.style.top = `${rect.top + window.scrollY}px`;
  overlay.style.left = `${rect.left + window.scrollX}px`;
  overlay.style.width = `${rect.width}px`;
  overlay.style.height = `${rect.height}px`;

  const tooltip = document.createElement("div");
  tooltip.className = "recorder-tooltip";
  const selector = getBestPlaywrightSelector(element);
  tooltip.textContent = `Selector: ${selector}`;

  const tooltipX = rect.left + window.scrollX;
  const tooltipY = rect.top + window.scrollY - 25;
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

// ============================================
// ASSERTION FUNCTIONS
// ============================================

function showAssertionMenu(x, y, element) {
  removeAssertionMenu();
  const menu = document.createElement("div");
  menu.className = "recorder-assertion-menu";
  menu.innerHTML = `
    <div class="menu-item" data-mode="chain">Chain Assertion to Previous Action</div>
    <div class="menu-item" data-mode="standalone">Standalone Assertion</div>
  `;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.style.background = 'white';
  menu.style.zIndex = 999999;
  menu.style.position = 'fixed';
  menu.style.display = 'block';
  menu.style.opacity = 1;
  menu.style.pointerEvents = 'auto';

  menu.addEventListener("click", (e) => {
    const menuItem = e.target;
    if (menuItem.classList.contains("menu-item")) {
      const mode = menuItem.dataset.mode;
      if (mode === "chain" || mode === "standalone") {
        showAssertionTypeSubmenu(x + 180, y, element, mode);
        removeAssertionMenu();
      }
    }
  });

  document.body.appendChild(menu);
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
          const last = recordedData[recordedData.length - 1];
          if (last && !last.assertAfter) last.assertAfter = [];
          if (last) last.assertAfter.push(assertion);
          else recordAction("assert", element, assertion);
          if (isRecording) chrome.storage.local.set({ recordedData: recordedData });
        } else {
          recordAction("assert", element, assertion);
        }
        removeAssertionMenu();
      }
    }
  });

  document.body.appendChild(submenu);
}

function removeAssertionMenu() {
  const menu = document.querySelector(".recorder-assertion-menu");
  if (menu) menu.remove();
}

// ============================================
// EXPORT & TRANSFORMATION FUNCTIONS
// ============================================

function urlToPattern(u) {
  try {
    const parsed = new URL(u);
    let route = '';
    if (parsed.hash && parsed.hash.length > 1) {
      route = parsed.hash.slice(1);
    } else {
      route = parsed.pathname || '';
    }
    const parts = route.split('/').filter(Boolean);
    if (parts.length > 0) return `**/${parts[parts.length - 1]}`;
    return u;
  } catch (err) {
    return u;
  }
}

function transformStepsForExport(rawSteps) {
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) return [];
  const out = [];

  for (let i = 0; i < rawSteps.length; i++) {
    const step = rawSteps[i];
    const nextStep = rawSteps[i + 1];
    out.push(step);

    try {
      const curUrl = step?._metadata?.pageUrl;
      const nextUrl = nextStep?._metadata?.pageUrl;

      // Insert framework stabilization wait AFTER navigation / URL change.
      if (nextStep && curUrl && nextUrl && curUrl !== nextUrl) {
        out.push({
          action: 'goto',
          url: nextUrl,
          _metadata: { inserted: true, pageUrl: nextUrl }
        });

        // Single stabilization delay
        out.push({
          action: 'waitForTimeout',
          timeout: 500,
          _metadata: { inserted: true, purpose: 'framework-stabilization' }
        });
      }

    } catch (err) { }
  }

  // Deduplicate
  const deduped = [];
  for (let i = 0; i < out.length; i++) {
    const cur = out[i];
    const prev = deduped.length ? deduped[deduped.length - 1] : null;
    if (!isSameAction(prev, cur)) deduped.push(cur);
    else if (prev && cur && cur._metadata) {
      prev._metadata = Object.assign({}, prev._metadata || {}, cur._metadata || {});
    }
  }

  return deduped;
}


function isSameAction(a, b) {
  if (!a || !b) return false;
  if (a.action !== b.action) return false;

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

  return {
    action: 'evaluate',
    selector: step.selector,
    value: expression,
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

function generatePlaywrightScriptFromSteps(steps) {
  function esc(s) {
    if (s === undefined || s === null) return "";
    return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '');
  }

  let script = `// Generated by hiTeman Chrome Extension\n`;
  script += `const { test, expect } = require('@playwright/test');\n\n`;
  script += `test('Recorded test', async ({ page }) => {\n`;
  script += `  try {\n`;

  let currentUrl = (steps && steps.length > 0 && steps[0]._metadata && steps[0]._metadata.pageUrl) ? steps[0]._metadata.pageUrl : '';

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const nextStep = steps[i + 1];
    const act = step.action || step.command;

    if (act === 'evaluate' && step._metadata && step._metadata.isFallback) continue;

    const stepUrl = step._metadata && step._metadata.pageUrl;
    try {
      const prev = steps[i - 1];
      const prevCausedNav = prev && prev.action === 'click' && prev._metadata && prev._metadata.pageUrl && stepUrl && prev._metadata.pageUrl !== stepUrl;
      if (stepUrl && currentUrl && stepUrl !== currentUrl && !prevCausedNav && act !== 'goto' && act !== 'open') {
        currentUrl = stepUrl;
      }
    } catch (err) { }

    if (act === 'goto' || act === 'open') {
      const url = step.url || step.value || '';
      script += `    await page.goto('${esc(url)}');\n`;
      if (nextStep && nextStep.selector) {
        script += `    await page.waitForSelector('${esc(nextStep.selector)}');\n`;
      }
      currentUrl = step._metadata && step._metadata.pageUrl ? step._metadata.pageUrl : currentUrl;
      continue;
    }

    if (act === 'click' && step.selector) {
      const hasEvaluateFallback = nextStep &&
        nextStep.action === 'evaluate' &&
        nextStep.selector === step.selector &&
        nextStep._metadata &&
        nextStep._metadata.isFallback;

      if (hasEvaluateFallback) {
        script += `    // Click with evaluate fallback\n`;
        script += `    await page.waitForSelector('${esc(step.selector)}');\n`;
        script += `    try {\n`;
        if (step.force) script += `      await page.click('${esc(step.selector)}', { force: true });\n`;
        else script += `      await page.click('${esc(step.selector)}');\n`;
        script += `    } catch (error) {\n`;
        script += `      // Click failed, using evaluate fallback\n`;
        const expression = nextStep.value || nextStep.expression || '';
        if (expression) {
          const escapedExpression = expression.replace(/`/g, '\\`').replace(/\${/g, '\\${');
          script += `      await page.evaluate(() => {\n`;
          script += `        ${escapedExpression}\n`;
          script += `      });\n`;
        }
        script += `    }\n`;
        i++;
        continue;
      } else {
        script += `    await page.waitForSelector('${esc(step.selector)}');\n`;
        if (step.force) script += `    await page.click('${esc(step.selector)}', { force: true });\n`;
        else script += `    await page.click('${esc(step.selector)}');\n`;
        continue;
      }
    }

    if ((act === 'fill' || act === 'type') && step.selector) {
      const hasEvaluateFallback = nextStep &&
        nextStep.action === 'evaluate' &&
        nextStep.selector === step.selector &&
        nextStep._metadata &&
        nextStep._metadata.isFallback;

      if (hasEvaluateFallback) {
        script += `    // Fill with evaluate fallback\n`;
        script += `    await page.waitForSelector('${esc(step.selector)}');\n`;
        script += `    await expect(page.locator('${esc(step.selector)}')).toBeEditable();\n`;
        script += `    try {\n`;
        script += `      await page.fill('${esc(step.selector)}', '${esc(step.value || '')}');\n`;
        script += `    } catch (error) {\n`;
        script += `      // Fill failed, using evaluate fallback\n`;
        const expression = nextStep.value || nextStep.expression || '';
        if (expression) {
          const escapedExpression = expression.replace(/`/g, '\\`').replace(/\${/g, '\\${');
          script += `      await page.evaluate(() => {\n`;
          script += `        ${escapedExpression}\n`;
          script += `      });\n`;
        }
        script += `    }\n`;
        i++;
        continue;
      } else {
        script += `    await page.waitForSelector('${esc(step.selector)}');\n`;
        script += `    await expect(page.locator('${esc(step.selector)}')).toBeEditable();\n`;
        script += `    await page.fill('${esc(step.selector)}', '${esc(step.value || '')}');\n`;
        continue;
      }
    }

    if ((act === 'selectOption') && step.selector) {
      script += `    await page.waitForSelector('${esc(step.selector)}');\n`;
      script += `    await page.selectOption('${esc(step.selector)}', '${esc(step.value || '')}');\n`;
      continue;
    }

    if (act === 'check' && step.selector) {
      script += `    await page.waitForSelector('${esc(step.selector)}');\n`;
      script += `    await page.check('${esc(step.selector)}');\n`;
      continue;
    }

    if (act === 'waitForTimeout' || act === 'waitFor') {
      const timeout = step.timeout || step.value || 1000;
      script += `    await page.waitForTimeout(${timeout});\n`;
      continue;
    }

    if (act === 'waitForURL') {
      if (step.url) script += `    await page.waitForURL('${esc(step.url)}');\n`;
      else script += `    await page.waitForURL('**');\n`;
      continue;
    }

    if (act === 'evaluate' && step.expression && (!step._metadata || !step._metadata.isFallback)) {
      const escapedExpression = step.expression.replace(/`/g, '\\`').replace(/\${/g, '\\${');
      script += `    await page.evaluate(() => {\n`;
      script += `      ${escapedExpression}\n`;
      script += `    });\n`;
      continue;
    }

    if (act === 'dispatchEvent' && step.selector) {
      script += `    await page.dispatchEvent('${esc(step.selector)}', '${step.eventType || 'click'}');\n`;
      continue;
    }

    if (act === 'expectVisible' && step.selector) {
      script += `    await page.waitForSelector('${esc(step.selector)}');\n`;
      script += `    await expect(page.locator('${esc(step.selector)}')).toBeVisible();\n`;
      continue;
    }

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

    if ((act === 'waitForSelector' || act === 'assertVisible') && step.selector) {
      script += `    await page.waitForSelector('${esc(step.selector)}');\n`;
      continue;
    }

    if (act === 'hover' && step.selector) {
      script += `    await page.waitForSelector('${esc(step.selector)}');\n`;
      script += `    await page.hover('${esc(step.selector)}');\n`;
      const hoverWait = Math.min(step.duration || 1000, 3000);
      if (hoverWait > 1000) script += `    await page.waitForTimeout(${hoverWait});\n`;
      continue;
    }

    try {
      if (nextStep && step._metadata && nextStep._metadata && step._metadata.pageUrl && nextStep._metadata.pageUrl && step._metadata.pageUrl !== nextStep._metadata.pageUrl) {
        if (nextStep.selector) script += `    await page.waitForSelector('${esc(nextStep.selector)}');\n`;
        currentUrl = nextStep._metadata.pageUrl;
      }
    } catch (err) { }
  }

  script += `  } catch (err) {\n`;
  script += `    console.error('Test failed', err);\n`;
  script += `    process.exit(1);\n`;
  script += `  }\n`;
  script += `});\n`;
  return script;
}

// ============================================
// HELPER FUNCTIONS
// ============================================

function downloadFile(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}

function startObserver() {
  observer = new MutationObserver((mutations) => {
    if (!isRecording) return;

    mutations.forEach((mutation) => {
      // We're disabling automatic detection of loading states
      // Only keep observer active for potential future use cases
      // For now, we won't process any mutations
    });
  });

  // Still observe but won't trigger any actions
  observer.observe(document.body, {
    childList: true,
    attributes: true,
    characterData: true,
    subtree: true,
    attributeFilter: ["style", "class", "hidden"],
  });
}

function checkVisibilityAndContent(element) {
  return;
  // if (element.closest(".recorder-controls") ||
  //   !isElementVisible(element) ||
  //   element.closest(".recorder-hover-overlay") ||
  //   element.closest(".recorder-tooltip")) return;

  // const text = element.textContent?.trim();
  // if (!text || text.length < 3 || text.length > 200) return;

  // if (isDialog(element)) {
  //   recordAction("assert", element, {
  //     command: "assertVisible",
  //     value: text,
  //     type: "dialog",
  //   });
  //   return;
  // }

  // if (isImportantMessage(element)) {
  //   setTimeout(() => {
  //     if (isElementVisible(element) && element.textContent?.trim() === text && shouldRecordMessage(element, text)) {
  //       recordAction("assert", element, {
  //         command: "assertVisible",
  //         value: "",
  //         type: getMessageType(text),
  //       });
  //     }
  //   }, 500);
  // }
}

function shouldRecordMessage(element, text) {
  if (element.tagName === "DIV" && (!element.className || element.className.length < 3)) return false;

  const commonMessages = ["loading", "please wait", "mohon tunggu", "welcome", "selamat datang"];
  if (commonMessages.some((msg) => text.toLowerCase().includes(msg))) return false;

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

function getMessageType(text) {
  if (isErrorMessage(text)) return "error";
  if (isWarningMessage(text)) return "warning";
  if (isSuccessMessage(text)) return "success";
  return "info";
}

function isImportantMessage(element) {
  const importantRoles = ["alert", "status"];
  if (importantRoles.includes(element.getAttribute("role"))) return true;

  const importantClasses = [
    "alert-danger", "alert-warning", "alert-success", "alert-info",
    "toast-error", "toast-warning", "toast-success", "toast-info",
    "notification--error", "notification--warning", "notification--success"
  ];

  const hasImportantClass = importantClasses.some((className) =>
    element.classList.contains(className) || element.closest(`.${className}`)
  );
  if (hasImportantClass) return true;

  const hasImportantAria = ["aria-invalid", "aria-errormessage"].some((attr) =>
    element.hasAttribute(attr)
  );
  if (hasImportantAria) return true;

  const text = element.textContent?.trim().toLowerCase();
  if (!text) return false;
  return shouldRecordMessage(element, text) &&
    (isErrorMessage(text) || isWarningMessage(text) || isSuccessMessage(text));
}

function isDialog(element) {
  if (element.getAttribute("role") === "dialog" ||
    element.getAttribute("role") === "alertdialog") return true;

  const dialogClasses = ["modal", "dialog", "popup", "overlay", "lightbox", "drawer", "popover"];
  const hasDialogClass = dialogClasses.some((className) => {
    const elementClasses = element.className.toLowerCase();
    return elementClasses.includes(className) &&
      !elementClasses.includes("wrapper") &&
      !elementClasses.includes("container");
  });
  if (hasDialogClass) return true;
  if (element.getAttribute("aria-modal") === "true") return true;
  return false;
}

function isElementVisible(element) {
  const style = window.getComputedStyle(element);
  return style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.opacity !== "0" &&
    element.offsetParent !== null;
}

function isErrorMessage(text) {
  const errorKeywords = [
    "error", "invalid", "failed", "incorrect", "wrong", "gagal", "salah",
    "tidak valid", "tidak benar", "required", "wajib diisi", "tidak ditemukan",
    "tidak tersedia", "tidak sesuai", "tidak boleh kosong", "denied", "rejected",
    "unauthorized", "forbidden"
  ];
  return errorKeywords.some((keyword) => text.toLowerCase().includes(keyword.toLowerCase()));
}

function isSuccessMessage(text) {
  const successKeywords = [
    "success", "successful", "succeeded", "berhasil", "saved", "tersimpan",
    "completed", "selesai", "updated", "diperbarui", "created", "dibuat"
  ];
  return successKeywords.some((keyword) => text.toLowerCase().includes(keyword.toLowerCase()));
}

function isWarningMessage(text) {
  const warningKeywords = ["warning", "perhatian", "hati-hati", "caution"];
  return warningKeywords.some((keyword) => text.toLowerCase().includes(keyword.toLowerCase()));
}

function isMessageElement(element) {
  const messageRoles = ["alert", "status", "log"];
  if (messageRoles.includes(element.getAttribute("role"))) return true;

  const messageClasses = ["alert", "message", "notification", "toast", "error", "success", "warning", "info"];
  const hasMessageClass = messageClasses.some((className) => {
    const elementClasses = element.className.toLowerCase();
    return elementClasses.includes(className.toLowerCase()) &&
      !elementClasses.includes("wrapper") &&
      !elementClasses.includes("container");
  });
  if (hasMessageClass) return true;

  if (element.hasAttribute("aria-live")) return true;

  let parent = element.parentElement;
  let level = 0;
  while (parent && level < 2) {
    if (messageRoles.includes(parent.getAttribute("role")) ||
      messageClasses.some((c) => parent.className.toLowerCase().includes(c.toLowerCase()))) {
      return true;
    }
    parent = parent.parentElement;
    level++;
  }
  return false;
}

window.__hiteman_fixSelectors = function (recording) {
  try {
    if (!recording) return recording;
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
        const weakSelectorPattern = /^\w+(\[.*\])?$|^\w+\.[\w\-]+$/;
        const isWeak = weakSelectorPattern.test(selector) || (document.querySelectorAll(selector || '').length > 1);
        if (!isWeak) continue;

        let el = null;
        try {
          const nodes = document.querySelectorAll(selector);
          if (nodes.length === 1) el = nodes[0];
          else if (nodes.length > 1 && action._metadata && action._metadata.outerHTML) {
            for (const n of nodes) {
              if (n.outerHTML && n.outerHTML.indexOf(action._metadata.outerHTML.trim().slice(0, 60)) !== -1) {
                el = n; break;
              }
            }
          }
        } catch (err) { }

        if (!el && action._metadata && action._metadata.outerHTML) {
          el = findElementByOuterHTML(action._metadata.outerHTML);
        }

        if (!el && (action.value || action.text)) {
          const text = (action.value || action.text).toString().trim();
          if (text) {
            const candidates = Array.from(document.querySelectorAll('*')).filter(n => n.textContent && n.textContent.indexOf(text) !== -1);
            if (candidates.length === 1) el = candidates[0];
          }
        }

        if (!el) continue;
        const full = buildFullPathSelector(el);
        if (full) {
          const cleaned = stripAngularClasses(full);
          action.selector = cleaned;
        }
      } catch (err) { }
    }

    if (Array.isArray(cloned)) return cloned;
    if (cloned.steps) cloned.steps = list;
    else if (cloned.actions) cloned.actions = list;

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
    } catch (err) { }

    return cloned;
  } catch (err) {
    return recording;
  }
};