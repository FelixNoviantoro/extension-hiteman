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
let pendingApiAssertionIndex = null;

const HOVER_CONFIG = {
  minHoverTime: 3000,
  maxHoverTime: 5000,
  debounceTime: 300
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', addStyles);
} else {
  addStyles();
}

function addStyles() {
  const style = document.createElement('style');
  style.textContent = `
    @keyframes slideIn {
      from {
        transform: translateX(100%);
        opacity: 0;
      }
      to {
        transform: translateX(0);
        opacity: 1;
      }
    }
  `;
  document.head.appendChild(style);
}

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

      chrome.storage.local.get(["recordedData"], (result) => {
        recordedData = result.recordedData || [];
        console.log(`Restored recording with ${recordedData.length} steps after navigation`);

        addControlPanel();
        startRecording();
      });
    }
    sendResponse({ status: "Restored" });
  } else if (message.action === "API_CAPTURE_RESULT") {
    console.log('API capture result received for action index:', message.actionIndex);
    console.log('Captured API:', {
      url: message.assertion?.target?.fullUrl,
      method: message.assertion?.target?.method,
      status: message.assertion?.expectedStatus
    });
    handleApiCaptureResult(message);
    sendResponse({ status: "processed" });
    return true;
  } else if (message.action === "API_CAPTURE_TIMEOUT") {
    console.log('API capture timeout for action index:', message.actionIndex);
    handleApiCaptureTimeout(message);
    sendResponse({ status: "processed" });
    return true;
  }
});

function handleApiCaptureResult(message) {
  const { assertion, actionIndex } = message;

  // Find the action and add the assertion
  if (actionIndex >= 0 && actionIndex < recordedData.length) {
    const targetAction = recordedData[actionIndex];

    if (!targetAction.assertAfter) {
      targetAction.assertAfter = [];
    }

    targetAction.assertAfter.push(assertion);

    // Update storage
    chrome.storage.local.set({ recordedData: recordedData });

    // Show success notification
    showApiCaptureSuccessNotification(assertion);
  }

  pendingApiAssertionIndex = null;
}

function handleApiCaptureTimeout(message) {
  const { actionIndex } = message;

  // Show timeout notification
  showApiCaptureTimeoutNotification();

  pendingApiAssertionIndex = null;
}

function showApiCaptureSuccessNotification(assertion) {
  const notification = document.createElement('div');
  notification.className = 'api-capture-success';
  notification.innerHTML = `
    <div style="
      position: fixed;
      top: 20px;
      right: 20px;
      background: #2196F3;
      color: white;
      padding: 12px 20px;
      border-radius: 4px;
      z-index: 1000000;
      box-shadow: 0 2px 10px rgba(0,0,0,0.2);
      animation: slideIn 0.3s ease;
    ">
      <div style="font-weight: bold;">✅ API Captured</div>
      <div style="font-size: 12px; opacity: 0.9;">
        ${assertion.target.method} ${assertion.target.fullUrl}<br>
        Status: ${assertion.expectedStatus} ${assertion.expectedStatusText}
      </div>
    </div>
  `;

  document.body.appendChild(notification);

  setTimeout(() => {
    if (notification.parentNode) {
      notification.parentNode.removeChild(notification);
    }
  }, 5000);
}

function showApiCaptureTimeoutNotification() {
  const notification = document.createElement('div');
  notification.className = 'api-capture-timeout';
  notification.innerHTML = `
    <div style="
      position: fixed;
      top: 20px;
      right: 20px;
      background: #FF9800;
      color: white;
      padding: 12px 20px;
      border-radius: 4px;
      z-index: 1000000;
      box-shadow: 0 2px 10px rgba(0,0,0,0.2);
      animation: slideIn 0.3s ease;
    ">
      <div style="font-weight: bold;">⏰ API Capture Timeout</div>
      <div style="font-size: 12px; opacity: 0.9;">
        No API call detected within 10 seconds
      </div>
    </div>
  `;

  document.body.appendChild(notification);

  setTimeout(() => {
    if (notification.parentNode) {
      notification.parentNode.removeChild(notification);
    }
  }, 5000);
}

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

async function handleStopButton() {
  try {
    isRecording = false;
    stopRecording();

    // Force sync with storage to get the latest data
    await syncWithStorage();

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

    chrome.runtime.sendMessage({
      action: 'RECORDING_COMPLETED',
      data: recordingData,
      playwrightData: playwrightData
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('Background error:', chrome.runtime.lastError);
        downloadJSONDirectly(playwrightData);
      }
    });

    updateUIAfterStop();
  } catch (err) {
    console.error('stopBtn handler error:', err);
  }
}

function downloadJSONDirectly(data) {
  const jsonString = JSON.stringify(data, null, 2);
  const blob = new Blob([jsonString], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `hiTeman-fallback-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
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
  startSyncInterval();
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
  stopSyncInterval();

  syncWithStorage();
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

function safeCleanup() {
  if (isRecording) {
    return;
  }

  chrome.storage.local.get(["isRecording"], (result) => {
    if (!result.isRecording) {
      inputBuffer = {};
      if (observer) observer.disconnect();
      removeControlPanel();
      removeOverlay();
    }
  });
}

// ============================================
// EVENT HANDLERS
// ============================================

async function handleClick(e) {
  if (!isRecording) return;
  const element = e.target;

  const isShiftClick = e.shiftKey;
  let data = { command: "click", value: "" };

  if (element.closest(".recorder-controls") ||
    element.classList.contains("recorder-hover-overlay") ||
    element.classList.contains("recorder-tooltip")) return;

  showOverlay(element, "click");

  const savePromise = recordAction("click", element, data);

  if (isShiftClick && savePromise) {
    console.log('Shift+Click detected - starting API capture');
    await savePromise;

    const actionIndex = recordedData.length - 1;
    pendingApiAssertionIndex = actionIndex;

    try {
      // We don't need to send tabId, the background script will get it from sender.tab.id
      const response = await chrome.runtime.sendMessage({
        action: 'START_API_CAPTURE',
        actionIndex: actionIndex
        // Don't send tabId - background will get it from the message sender
      });

      console.log('API capture started:', response);
      showApiCaptureNotification();
    } catch (error) {
      console.error('Failed to start API capture:', error);
    }
  }
}

function handleHover(e) {
  if (!isRecording) return;
  const element = e.target;

  if (element.closest(".recorder-controls") ||
    element.classList.contains("recorder-hover-overlay") ||
    element.classList.contains("recorder-tooltip")) return;

  // Clear any existing timeout
  if (hoverTimeout) {
    clearTimeout(hoverTimeout);
    hoverTimeout = null;
  }

  // Set new hover tracking
  lastHoveredElement = element;
  hoverStartTime = Date.now();

  hoverTimeout = setTimeout(() => {
    recordHoverAction(element);
    removeOverlay();
  }, HOVER_CONFIG.minHoverTime);

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
  if (element.tagName === "INPUT" && element.type === "file") {
    const files = Array.from(element.files).map(file => file.name);
    recordAction("upload", element, {
      command: "setInputFiles",
      value: files,
      fileCount: files.length
    });
  }
}

function handleInput(e) {
  if (!isRecording) return;
  const element = e.target;
  if (element.tagName !== "INPUT" && element.tagName !== "TEXTAREA") return;
  if (element.tagName === "INPUT" && element.type === "file") return;

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

  if (element.tagName === "INPUT" && element.type === "file") return;

  if (inputBuffer[bufferKey] && (tag === 'TEXTAREA' || (tag === 'INPUT' && textLikeInputTypes.has((element.type || '').toLowerCase())))) {
    let selectorToUse = null;
    try {
      const lastAction = recordedData.length > 0 ? recordedData[recordedData.length - 1] : null;
      if (lastAction && lastAction.action === 'click' && lastAction.selector) {
        const matches = element.matches(lastAction.selector);
        if (matches) selectorToUse = lastAction.selector;
      }
    } catch (err) { }

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
    return Promise.resolve({ status: 'success' });
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

  if (data.command === "setInputFiles") {
    action = {
      action: "setInputFiles",
      selector: selector,
      files: data.value, // Array of file names
      fileCount: data.fileCount
    };
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
  if (isRecording) {
    chrome.storage.local.set({ recordedData: recordedData });
  }
  return Promise.resolve({ status: 'success' });
}

function recordHoverAction(element) {
  if (!isRecording || !element) return;

  // Check if element is still in the DOM
  if (!element.parentNode || !document.body.contains(element)) {
    return;
  }

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
    'hover': 'hover',
    'setInputFiles': 'setInputFiles',
    'upload': 'setInputFiles'
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

function getBestPlaywrightSelector(element) {
  const isUnique = (sel) => {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch (_) {
      return false;
    }
  };

  const clean = (selector) =>
    selector.replace(/(ng-|cdk-|mat-|_ngcontent)[^\s"'=]*/g, "");

  const textOf = (el) =>
    el.textContent?.trim().replace(/\s+/g, " ") || "";

  const visibleText = textOf(element);

  const escape = CSS.escape;

  const getMeaningfulClasses = (el) => {
    if (!el.classList) return [];
    return Array.from(el.classList).filter(cls => {
      return !(
        /^(p-|m-|gap-|grid-|flex-|rounded|w-|h-|text-|hover:|active:|focus:)/.test(cls) ||
        /(ng-|cdk-|mat-|_ngcontent)/.test(cls)
      );
    });
  };

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

  if (element.dataset) {
    for (const k of ["testid", "qa", "cy"]) {
      if (element.dataset[k]) {
        const sel = `[data-${k}="${escape(element.dataset[k])}"]`;
        if (isUnique(sel)) return clean(sel);
      }
    }
  }

  if (element.id && !/^[0-9]/.test(element.id)) {
    const sel = `#${escape(element.id)}`;
    if (isUnique(sel)) return clean(sel);
  }

  if (tag === "input" || tag === "textarea" || tag === "select") {
    if (element.name) {
      const sel = `[name="${escape(element.name)}"]`;
      if (isUnique(sel)) return clean(sel);
    }

    if (element.placeholder) {
      const sel = `[placeholder="${escape(element.placeholder)}"]`;
      if (isUnique(sel)) return clean(sel);
    }
  }

  if (["button", "a"].includes(tag)) {
    if (visibleText && visibleText.length <= 40) {
      const all = Array.from(document.querySelectorAll(tag));
      const match = all.filter(el => textOf(el) === visibleText);
      if (match.length === 1) {
        return `${tag}:has-text("${visibleText.replace(/"/g, '\\"')}")`;
      }
    }
  }

  const title = element.getAttribute("title");
  if (title) {
    const sel = `${tag}[title="${escape(title)}"]`;
    if (isUnique(sel)) return clean(sel);
  }

  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) {
    const sel = `[aria-label="${escape(ariaLabel)}"]`;
    if (isUnique(sel)) return clean(sel);
  }

  const goodClasses = getMeaningfulClasses(element);
  if (goodClasses.length) {
    const sel = `${tag}.${goodClasses.map(escape).join(".")}`;
    if (isUnique(sel)) return clean(sel);
  }

  const role = element.getAttribute("role");
  if (role) {
    const sel = `[role="${escape(role)}"]`;
    if (isUnique(sel)) return clean(sel);
  }

  if (element.parentElement) {
    const siblings = Array.from(element.parentElement.children)
      .filter(n => n.tagName.toLowerCase() === tag);

    if (siblings.length > 1) {
      const idx = siblings.indexOf(element) + 1;
      const sel = `${tag}:nth-of-type(${idx})`;
      if (isUnique(sel)) return clean(sel);
    }
  }

  return `xpath=${getXPath(element)}`;

  function getXPath(el) {
    if (el === document.body) return "/html/body";
    if (!el || !el.parentNode) return "";

    const ix = (sib, name) =>
      Array.from(sib.parentNode.children)
        .filter(n => n.tagName === name).indexOf(sib) + 1;

    const parentXPath = getXPath(el.parentNode);
    if (parentXPath === "") {
      return `/${el.tagName.toLowerCase()}[${ix(el, el.tagName)}]`;
    }

    return (
      parentXPath +
      "/" +
      el.tagName.toLowerCase() +
      "[" +
      ix(el, el.tagName) +
      "]"
    );
  }
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

function transformStepsForExport(rawSteps) {
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) return [];
  
  // Step 1: Clean the steps (your current implementation)
  const cleanedSteps = rawSteps.map((step, index) => {
    const cleanStep = JSON.parse(JSON.stringify(step));

    // Clean up empty fields, but preserve duration for hover actions
    const emptyFields = ['key', 'ms', 'to', 'from', 'value', 'timeout'];
    emptyFields.forEach(field => {
      if (cleanStep[field] === '' || cleanStep[field] === null || cleanStep[field] === undefined) {
        delete cleanStep[field];
      }
    });

    // Don't delete duration for hover actions
    if (cleanStep.action !== 'hover' && (cleanStep.duration === '' || cleanStep.duration === null || cleanStep.duration === undefined)) {
      delete cleanStep.duration;
    }

    // Clean metadata
    if (cleanStep._metadata) {
      Object.keys(cleanStep._metadata).forEach(key => {
        if (cleanStep._metadata[key] === '' || cleanStep._metadata[key] === null || cleanStep._metadata[key] === undefined) {
          delete cleanStep._metadata[key];
        }
      });

      if (Object.keys(cleanStep._metadata).length === 0) {
        delete cleanStep._metadata;
      }
    }

    return cleanStep;
  });

  // Step 2: Add page navigation detection (your previous implementation)
  const withNavigation = [];
  
  for (let i = 0; i < cleanedSteps.length; i++) {
    const step = cleanedSteps[i];
    const nextStep = cleanedSteps[i + 1];
    
    // Add current step
    withNavigation.push(step);
    
    // Check for URL change
    if (nextStep) {
      const curUrl = step?._metadata?.pageUrl;
      const nextUrl = nextStep?._metadata?.pageUrl;
      
      // Insert framework stabilization wait AFTER navigation / URL change
      if (curUrl && nextUrl && curUrl !== nextUrl) {
        withNavigation.push({
          action: 'goto',
          url: nextUrl,
          _metadata: { inserted: true, pageUrl: nextUrl }
        });

        // Single stabilization delay
        withNavigation.push({
          action: 'waitForTimeout',
          timeout: 500,
          _metadata: { inserted: true, purpose: 'framework-stabilization' }
        });
      }
    }
  }

  // Step 3: Filter and deduplicate
  const deduped = [];
  const isSameAction = (a, b) => {
    if (!a || !b) return false;
    return a.action === b.action && 
           a.selector === b.selector && 
           a.url === b.url;
  };
  
  for (let i = 0; i < withNavigation.length; i++) {
    const cur = withNavigation[i];
    const prev = deduped.length ? deduped[deduped.length - 1] : null;
    
    if (!isSameAction(prev, cur)) {
      deduped.push(cur);
    } else if (prev && cur && cur._metadata) {
      // Merge metadata if same action
      prev._metadata = { ...prev._metadata, ...cur._metadata };
    }
  }

  // Step 4: Final essential fields check
  const finalSteps = deduped.filter(step => {
    const hasEssentialFields = step.action && (
      step.selector || 
      step.url || 
      step.assertAfter !== undefined
    );

    const hasContent = Object.keys(step).length > 0;

    return hasEssentialFields && hasContent;
  });

  return finalSteps;
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
  });

  observer.observe(document.body, {
    childList: true,
    attributes: true,
    characterData: true,
    subtree: true,
    attributeFilter: ["style", "class", "hidden"],
  });
}

async function syncWithStorage() {
  return new Promise(resolve => {
    chrome.storage.local.get(["recordedData"], (result) => {
      const storageData = result.recordedData || [];
      recordedData = storageData;
      resolve();
    });
  });
}

let syncInterval = null;

function startSyncInterval() {
  if (syncInterval) clearInterval(syncInterval);
  syncInterval = setInterval(() => {
    if (isRecording) {
      syncWithStorage();
    }
  }, 2000);
}

function stopSyncInterval() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}

function showApiCaptureNotification() {
  const notification = document.createElement('div');
  notification.className = 'api-capture-notification';
  notification.innerHTML = `
    <div style="
      position: fixed;
      top: 20px;
      right: 20px;
      background: #4CAF50;
      color: white;
      padding: 12px 20px;
      border-radius: 4px;
      z-index: 1000000;
      box-shadow: 0 2px 10px rgba(0,0,0,0.2);
      animation: slideIn 0.3s ease;
    ">
      <div style="font-weight: bold;">🎯 API Capture Active</div>
      <div style="font-size: 12px; opacity: 0.9;">
        Recording next API call... (10s timeout)
      </div>
    </div>
  `;

  document.body.appendChild(notification);

  setTimeout(() => {
    if (notification.parentNode) {
      notification.parentNode.removeChild(notification);
    }
  }, 3000);
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

window.addEventListener("unload", safeCleanup);