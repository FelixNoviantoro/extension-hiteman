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
  console.log('Content script received message:', message.action);

  if (message.action === "startRecording") {
    console.log('=== START RECORDING ===');
    console.log('Current URL:', window.location.href);

    isTargetPage = true;
    isRecording = true;
    recordedData = [];

    console.log('Initialized empty recordedData array');

    // First record the open action
    const openActionPromise = recordAction("open", document.body, {
      command: "open",
      value: window.location.href,
    });

    // After recording the open action, save to storage
    openActionPromise.then(() => {
      console.log('Open action recorded, saving to storage');
      console.log('Recorded data now has', recordedData.length, 'steps');

      chrome.storage.local.set({
        isRecording: true,
        recordedData: recordedData,
      }, () => {
        console.log('Storage saved with', recordedData.length, 'steps');

        // Verify storage was saved correctly
        chrome.storage.local.get(["recordedData"], (result) => {
          console.log('Verification - Storage contains', result.recordedData?.length || 0, 'steps');
        });
      });

      chrome.runtime.sendMessage({ action: "startRecording" }, (response) => {
        if (chrome.runtime.lastError) {
          console.log("Background script error:", chrome.runtime.lastError);
        }
        addControlPanel();
        startRecording();
        sendResponse({ status: "Recording started", stepCount: recordedData.length });
      });
    }).catch(err => {
      console.error('Error recording open action:', err);
      sendResponse({ status: "Error", error: err.message });
    });

    return true; // Keep message channel open for async response
  }
  else if (message.action === "resetStorage") {
    sessionStorage.clear();
    sendResponse({ status: "Storage cleared" });
  }
  else if (message.action === "stopAndDownload") {
    isRecording = false;
    chrome.storage.local.set({ isRecording: false, recordedData: [] });
    stopRecording();
    sendResponse({ status: "Recording stopped", data: recordedData });
  }
  else if (message.action === "RESTORE_RECORDING") {
    console.log('=== RESTORE RECORDING ===');
    const status = message.data;

    if (status && status.type === "RECORDING_STARTED") {
      isRecording = true;
      isTargetPage = true;

      // Load recorded data from storage
      chrome.storage.local.get(["recordedData"], (result) => {
        recordedData = result.recordedData || [];
        console.log(`Restored recording with ${recordedData.length} steps after navigation`);

        // Debug: Check what's in the restored data
        if (recordedData.length > 0) {
          console.log('First step in restored data:', {
            action: recordedData[0].action,
            url: recordedData[0].url,
            hasMetadata: !!recordedData[0]._metadata
          });

          // If first step is not a goto/open action, add one
          if (recordedData[0].action !== 'goto' && recordedData[0].action !== 'open') {
            console.log('WARNING: First step is not a goto action! Adding one...');
            const initialGoto = {
              action: 'goto',
              url: recordedData[0]?._metadata?.pageUrl || window.location.href,
              _metadata: {
                timestamp: new Date().toISOString(),
                pageUrl: recordedData[0]?._metadata?.pageUrl || window.location.href,
                originalCommand: 'open',
                inserted: true
              }
            };
            recordedData.unshift(initialGoto);
            console.log('Added initial goto action:', initialGoto);

            // Save back to storage
            chrome.storage.local.set({ recordedData: recordedData });
          }
        } else {
          console.log('WARNING: No steps found in restored recording!');
        }

        addControlPanel();
        startRecording();
      });
    }
    sendResponse({ status: "Restored" });
  }
  else if (message.action === "API_CAPTURE_RESULT") {
    console.log('API capture result received for action index:', message.actionIndex);
    console.log('Captured API:', {
      url: message.assertion?.target?.fullUrl,
      method: message.assertion?.target?.method,
      status: message.assertion?.expectedStatus
    });
    handleApiCaptureResult(message);
    sendResponse({ status: "processed" });
    return true;
  }
  else if (message.action === "API_CAPTURE_TIMEOUT") {
    console.log('API capture timeout for action index:', message.actionIndex);
    handleApiCaptureTimeout(message);
    sendResponse({ status: "processed" });
    return true;
  }

  // Return true for async responses
  return true;
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
  }, 1000);
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
  }, 3000);
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

    if (recordedData && recordedData.length > 0) {
      const firstAction = recordedData[0].action;
      if (firstAction !== 'goto' && firstAction !== 'open') {
        console.log('Adding missing initial goto action before export');
        const initialGoto = {
          action: 'goto',
          url: recordedData[0]?._metadata?.pageUrl || window.location.href,
          _metadata: {
            timestamp: new Date().toISOString(),
            pageUrl: recordedData[0]?._metadata?.pageUrl || window.location.href,
            originalCommand: 'open',
            inserted: true
          }
        };
        recordedData.unshift(initialGoto);
      }
    }

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
  // document.addEventListener("contextmenu", handleRightClick, true);
  document.addEventListener("change", handleChange, true);
  document.addEventListener("input", handleInput, true);
  document.addEventListener("keyup", handleKeyup, true);
  document.addEventListener("blur", handleBlur, true);
  document.addEventListener("mouseover", handleHover, true);
  document.addEventListener("mouseout", handleMouseOut, true);
  startObserver();
  startSyncInterval();
}

function stopRecording() {
  document.removeEventListener("click", handleClick, true);
  // document.removeEventListener("contextmenu", handleRightClick, true);
  document.removeEventListener("change", handleChange, true);
  document.removeEventListener("input", handleInput, true);
  document.removeEventListener("keyup", handleKeyup, true);
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
    const files = Array.from(element.files);

    if (files.length === 0) {
      recordAction("upload", element, {
        command: "setInputFiles",
        value: ""
      });
    } else {
      // Get extensions only
      const extensions = files.map(file => {
        const name = file.name;
        if (name.includes('.')) {
          return name.split('.').pop().toLowerCase();
        }
        return 'file'; // fallback for files without extension
      });

      // Join extensions (for single file, just the extension; for multiple, comma-separated)
      const extensionString = extensions.join(', ');

      recordAction("upload", element, {
        command: "setInputFiles",
        value: extensionString
      });
    }
  }
}

function handleInput(e) {
  if (!isRecording) return;
  const element = e.target;

  console.log('🔵 INPUT EVENT FIRED - Type:', e.type);
  console.log('  Element:', {
    tagName: element.tagName,
    type: element.type,
    id: element.id,
    name: element.name,
    className: element.className
  });
  console.log('  Value BEFORE:', element.value);
  console.log('  Event type:', e.type);
  console.log('  Timestamp:', Date.now());

  if (element.tagName !== "INPUT" && element.tagName !== "TEXTAREA") {
    console.log('  ⚠️ Not an input/textarea, skipping');
    return;
  }
  if (element.tagName === "INPUT" && element.type === "file") {
    console.log('  ⚠️ File input, skipping');
    return;
  }

  const type = (element.type || "").toLowerCase();
  const textLikeInputTypes = new Set(["text", "search", "email", "password", "tel", "url", "number"]);

  if (element.tagName === "TEXTAREA" || textLikeInputTypes.has(type)) {
    const key = getUniqueElementKey(element);

    // Use setTimeout to get value AFTER oninput handler runs
    setTimeout(() => {
      console.log('🟢 Delayed capture - Value:', element.value);
      inputBuffer[key] = {
        element,
        value: element.value,
        timestamp: new Date(),
        selector: getBestPlaywrightSelector(element)
      };
    }, 10); // Small delay
  }
}


function handleBlur(e) {
  if (!isRecording) return;
  const element = e.target;

  console.log('🔵 BLUR EVENT FIRED');
  console.log('  Element:', {
    tagName: element.tagName,
    type: element.type,
    id: element.id,
    name: element.name,
    value: element.value,
    className: element.className
  });
  console.log('  Current value:', element.value);

  const bufferKey = getUniqueElementKey(element);
  console.log('  🔑 Looking for buffer with key:', bufferKey);
  console.log('  📦 Buffer contents:', inputBuffer[bufferKey]);

  const tag = element.tagName;
  const textLikeInputTypes = new Set(['text', 'search', 'email', 'password', 'tel', 'url', 'number']);

  if (element.tagName === "INPUT" && element.type === "file") {
    console.log('  ⚠️ File input, skipping');
    return;
  }

  if (inputBuffer[bufferKey] && (tag === 'TEXTAREA' || (tag === 'INPUT' && textLikeInputTypes.has((element.type || '').toLowerCase())))) {
    console.log('  ✅ Buffer found, processing...');
    console.log('  📝 Buffer value:', inputBuffer[bufferKey].value);
    console.log('  📝 Current element value:', element.value);

    let selectorToUse = null;
    try {
      const lastAction = recordedData.length > 0 ? recordedData[recordedData.length - 1] : null;
      if (lastAction && lastAction.action === 'click' && lastAction.selector) {
        const matches = element.matches(lastAction.selector);
        if (matches) selectorToUse = lastAction.selector;
        console.log('  🔍 Last action selector check:', matches ? 'Matched' : 'No match');
      }
    } catch (err) {
      console.log('  ❌ Error checking last action:', err.message);
    }

    if (!selectorToUse) {
      selectorToUse = getBestPlaywrightSelector(element);
      console.log('  🔍 Generated new selector:', selectorToUse);
    }

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

    console.log('  💾 Recording action:', action);
    recordedData.push(action);

    if (isRecording) {
      chrome.storage.local.set({ recordedData: recordedData });
      console.log('  ✅ Saved to storage');
    }

    delete inputBuffer[bufferKey];
    console.log('  🗑️ Buffer cleared');
  } else {
    console.log('  ⚠️ No buffer found or not a text-like input');
    console.log('  Has buffer?', !!inputBuffer[bufferKey]);
    console.log('  Is text-like?', tag === 'TEXTAREA' || (tag === 'INPUT' && textLikeInputTypes.has((element.type || '').toLowerCase())));
  }
}

function handleKeyup(e) {
  console.log('🔵 KEYUP EVENT FIRED');
  console.log('  Element:', {
    tagName: e.target.tagName,
    type: e.target.type,
    id: e.target.id,
    name: e.target.name,
    value: e.target.value
  });
  console.log('  Key:', e.key);
  console.log('  Key code:', e.keyCode);

  // Then call your existing handleInput
  handleInput(e);
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
  console.log('=== recordAction === Type:', type, 'Command:', data.command, 'Value:', data.value);

  // Handle assertions first
  if (type === "assert" && data.type && ["elementText", "elementVisible", "elementClass", "elementValue"].includes(data.type)) {
    recordedData.push(data);
    if (isRecording) chrome.storage.local.set({ recordedData: recordedData });
    return Promise.resolve({ status: 'success' });
  }

  // Special handling for "open" command
  if (data.command === "open") {
    console.log('Creating goto action for URL:', data.value);

    const gotoAction = {
      action: "goto",
      url: data.value,
      _metadata: {
        timestamp: new Date().toISOString(),
        pageUrl: data.value,
        originalCommand: "open",
        elementInfo: undefined
      }
    };

    console.log('Goto action created:', gotoAction);
    recordedData.push(gotoAction);

    if (isRecording) {
      console.log('Saving to storage, total steps:', recordedData.length);
      chrome.storage.local.set({ recordedData: recordedData });
    }

    return Promise.resolve({ status: 'success' });
  }

  // For other commands
  const selector = getBestPlaywrightSelector(element);

  let action = {
    action: mapToPlaywrightAction(data.command, type),
    selector: selector
  };

  // Handle file uploads specially
  if (data.command === "setInputFiles") {
    action = {
      action: "setInputFiles",
      selector: selector,
      // Put file name/extension in the value field
      value: data.value || ""
    };

    // Also store additional metadata about files
    if (element.files && element.files.length > 0) {
      const files = Array.from(element.files);
      const fileInfo = files.map(file => ({
        name: file.name,
        extension: file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '',
        type: file.type,
        size: file.size
      }));

      action._metadata = {
        timestamp: new Date().toISOString(),
        pageUrl: window.location.href,
        originalCommand: data.command,
        elementInfo: {
          tagName: element.tagName,
          id: element.id,
          className: element.className,
          text: element.textContent?.trim(),
          value: element.value || '',
          fileCount: files.length,
          fileDetails: fileInfo
        }
      };
    } else {
      action._metadata = {
        timestamp: new Date().toISOString(),
        pageUrl: window.location.href,
        originalCommand: data.command,
        elementInfo: {
          tagName: element.tagName,
          id: element.id,
          className: element.className,
          text: element.textContent?.trim(),
          value: element.value || '',
          fileCount: 0
        }
      };
    }
  } else {
    // Regular actions (fill, click, etc.)
    if (data.value && shouldIncludeValue(data.command)) {
      action.value = data.value;
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
  }

  console.log('Pushing action:', action);
  recordedData.push(action);

  if (isRecording) {
    console.log('Saving to storage, total steps:', recordedData.length);
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
  // =========================
  // Helpers
  // =========================

  const isUnique = (sel) => {
    try {
      const hasTextRegex = /:has-text\("((?:\\.|[^"\\])*)"\)/;
      const m = sel.match(hasTextRegex);

      if (m) {
        let raw = m[1];
        raw = raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\');

        const cssPart = sel.replace(hasTextRegex, "").trim();
        const candidates = cssPart
          ? Array.from(document.querySelectorAll(cssPart))
          : Array.from(document.querySelectorAll("*"));

        const norm = (el) =>
          (el.textContent || "").trim().replace(/\s+/g, " ");

        const count = candidates.filter((el) => {
          const t = norm(el);
          return t === raw || t.includes(raw);
        }).length;

        return count === 1;
      }

      return document.querySelectorAll(sel).length === 1;
    } catch {
      return false;
    }
  };

  const clean = (selector) =>
    selector.replace(/(ng-|cdk-|mat-|_ngcontent)[^\s"'=]*/g, "");

  const textOf = (el) => {
    // Only get text content that's directly in the element, not from attributes
    const text = el.textContent?.trim().replace(/\s+/g, " ") || "";
    
    // Check if this text looks like it might be from a tooltip attribute
    // by comparing with tooltip attributes of child elements
    const hasTooltipChild = el.querySelector('[ngbtooltip], [title], [aria-label]');
    if (hasTooltipChild) {
      // Get tooltip text from child elements
      const tooltipText = hasTooltipChild.getAttribute('ngbtooltip') || 
                         hasTooltipChild.getAttribute('title') || 
                         hasTooltipChild.getAttribute('aria-label') || "";
      
      // If the element's text content matches or contains the tooltip text, return empty
      if (tooltipText && text.includes(tooltipText)) {
        return "";
      }
    }
    
    return text;
  };

  const escape = CSS.escape;

  const isLikelyGeneratedId = (id) =>
    /^[a-f0-9]{8,}(-\d+)?$/i.test(id) ||
    /^pn_id_\d+$/i.test(id) ||
    /^DataTables_Table_\d+_?(next|previous|first|last)?$/i.test(id);

  const getMeaningfulClasses = (el) => {
    if (!el.classList) return [];
    return Array.from(el.classList).filter(
      (cls) =>
        !/^(p-|m-|gap-|grid-|flex-|rounded|w-|h-|text-|hover:|active:|focus:)/.test(
          cls
        ) &&
        !/(ng-|cdk-|mat-|_ngcontent)/.test(cls)
    );
  };

  const getImplicitRole = (el) => {
    const tag = el.tagName.toLowerCase();
    const type = el.type || "";

    if (tag === "button") return "button";
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "input" && type === "checkbox") return "checkbox";
    if (tag === "input" && type === "radio") return "radio";
    if (
      tag === "input" &&
      ["text", "search", "email", "tel", "url", "password"].includes(type)
    )
      return "textbox";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    return null;
  };

  // =========================
  // Clickable normalization
  // =========================

  const iconTags = [
    "SVG",
    "PATH",
    "LINE",
    "RECT",
    "CIRCLE",
    "POLYLINE",
    "POLYGON",
    "G",
    "I",
    "SPAN",
  ];

  if (iconTags.includes(element.tagName.toUpperCase())) {
    const clickableAncestor = element.closest(
      'button, a[href], [role="button"], [role="combobox"]'
    );
    if (clickableAncestor) element = clickableAncestor;
  }

  const isNaturallyClickable = (el) => {
    const tag = el.tagName.toLowerCase();
    if (["button", "a", "input", "textarea", "select"].includes(tag))
      return true;
    if (
      el.hasAttribute("role") &&
      ["button", "link", "combobox"].includes(el.getAttribute("role"))
    )
      return true;
    if (el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1")
      return true;
    return false;
  };

  if (!isNaturallyClickable(element)) {
    const interactiveChild = element.querySelector(
      'button, a[href], input, textarea, select, [role="button"], [role="combobox"], [contenteditable="true"], [tabindex]:not([tabindex="-1"])'
    );
    if (interactiveChild) element = interactiveChild;
  }

  // =========================
  // DROPDOWN NORMALIZATION (CRITICAL FIX)
  // =========================

  const dropdownSelectors = [
    'p-dropdown',
    'mat-select',
    'ng-select',
    'p-multiselect',
    '[class*="dropdown"][formcontrolname]',
    '[class*="select"][formcontrolname]'
  ];

  // Check if we're inside a dropdown component
  let dropdownContainer = null;
  for (const selector of dropdownSelectors) {
    dropdownContainer = element.closest(selector);
    if (dropdownContainer) break;
  }

  // Store original element for potential use
  let originalElement = element;

  // If we're inside a dropdown and clicked on an internal element
  if (dropdownContainer) {
    const currentRole = element.getAttribute('role');
    const currentTag = element.tagName.toLowerCase();
    const currentAriaLabel = element.getAttribute('aria-label');

    // If clicked on internal trigger button, combobox span, or icon
    const isInternalElement = (
      (currentRole === 'button' && currentAriaLabel?.toLowerCase().includes('trigger')) ||
      (currentRole === 'combobox' && currentTag === 'span') ||
      currentTag === 'svg' ||
      currentTag === 'path' ||
      element.classList.contains('p-select-dropdown') ||
      element.classList.contains('p-dropdown-trigger')
    );

    if (isInternalElement) {
      // Use the dropdown container instead
      element = dropdownContainer;
    }
  }

  const tag = element.tagName.toLowerCase();
  const visibleText = textOf(element);
  const role = element.getAttribute("role");

  // =========================
  // PRIORITY 1: Stable IDs & Form Controls
  // =========================

  if (element.dataset) {
    for (const k of [
      "testid",
      "qa",
      "cy",
      "test",
      "e2e",
      "qa-id",
      "test-id",
    ]) {
      if (element.dataset[k]) {
        const sel = `[data-${k}="${escape(element.dataset[k])}"]`;
        if (isUnique(sel)) return clean(sel);
      }
    }
  }

  // HIGH PRIORITY: formcontrolname for form elements
  const formControlName = element.getAttribute("formcontrolname");
  if (formControlName) {
    const sel = `[formcontrolname="${escape(formControlName)}"]`;
    if (isUnique(sel)) return clean(sel);
  }

  // Check for name attribute on form controls
  const name = element.getAttribute("name");
  if (name && ['input', 'select', 'textarea'].includes(tag)) {
    const sel = `${tag}[name="${escape(name)}"]`;
    if (isUnique(sel)) return clean(sel);
  }

  if (
    element.id &&
    !isLikelyGeneratedId(element.id) &&
    role !== "option" &&
    !element.closest("ng-dropdown-panel")
  ) {
    const sel = `#${escape(element.id)}`;
    if (isUnique(sel)) return clean(sel);
  }

  // =========================
  // PRIORITY 2: Placeholder for custom dropdowns
  // =========================

  if (element.hasAttribute('placeholder')) {
    const placeholder = element.getAttribute('placeholder');
    // Try tag + placeholder
    const sel1 = `${tag}[placeholder="${escape(placeholder)}"]`;
    if (isUnique(sel1)) return clean(sel1);

    // Try just placeholder if unique
    const sel2 = `[placeholder="${escape(placeholder)}"]`;
    if (isUnique(sel2)) return clean(sel2);
  }

  // =========================
  // PRIORITY 3: Text
  // =========================

  if (["button", "a"].includes(tag) && visibleText) {
    const sel = `${tag}:has-text("${visibleText.replace(/"/g, '\\"')}")`;
    if (isUnique(sel)) return clean(sel);
  }

  // Handle buttons with tooltip children
  if (tag === "button" && !visibleText) {
    // Look for child elements with ngbtooltip, title, or aria-label
    const tooltipChild = element.querySelector('[ngbtooltip], [title], [aria-label]');
    if (tooltipChild) {
      const tooltipAttr = tooltipChild.getAttribute('ngbtooltip') || 
                         tooltipChild.getAttribute('title') || 
                         tooltipChild.getAttribute('aria-label');
      
      if (tooltipAttr) {
        // Try button:has(i[ngbtooltip="..."]) - but only use it if it's UNIQUE
        const sel = `${tag}:has(${tooltipChild.tagName.toLowerCase()}[ngbtooltip="${escape(tooltipAttr)}"])`;
        if (isUnique(sel)) return clean(sel);
        
        // Also try with title attribute - only if unique
        if (tooltipChild.hasAttribute('title')) {
          const sel2 = `${tag}:has(${tooltipChild.tagName.toLowerCase()}[title="${escape(tooltipAttr)}"])`;
          if (isUnique(sel2)) return clean(sel2);
        }
        
        // Also try with aria-label attribute - only if unique
        if (tooltipChild.hasAttribute('aria-label')) {
          const sel3 = `${tag}:has(${tooltipChild.tagName.toLowerCase()}[aria-label="${escape(tooltipAttr)}"])`;
          if (isUnique(sel3)) return(sel3);
        }
      }
    }
  }

  // =========================
  // PRIORITY 4: ARIA / ROLE (excluding internal dropdown elements)
  // =========================

  if (role === "option" && visibleText) {
    const sel = `[role="option"]:has-text("${visibleText.replace(/"/g, '\\"')}")`;
    if (isUnique(sel)) return clean(sel);
  }

  // Only use role="button" selector if it's NOT a dropdown trigger
  if (role === "button") {
    const aria = element.getAttribute("aria-label");
    if (aria && !aria.toLowerCase().includes('trigger') && !aria.toLowerCase().includes('dropdown')) {
      const sel = `[role="button"][aria-label="${escape(aria)}"]`;
      if (isUnique(sel)) return clean(sel);
    }
  }

  if (role && role !== "option" && role !== "button" && role !== "combobox") {
    const sel = `[role="${escape(role)}"]`;
    if (isUnique(sel)) return clean(sel);
  }

  const implicitRole = getImplicitRole(element);
  if (implicitRole && !role && visibleText) {
    const sel = `${implicitRole}:has-text("${visibleText.replace(
      /"/g,
      '\\"'
    )}")`;
    if (isUnique(sel)) return clean(sel);
  }

  // =========================
  // PRIORITY 5: Classes
  // =========================

  const goodClasses = getMeaningfulClasses(element);
  if (goodClasses.length) {
    const sel = `${tag}.${goodClasses.map(escape).join(".")}`;
    if (isUnique(sel)) return clean(sel);
  }

  // =========================
  // PRIORITY 6: Tag-specific attributes
  // =========================

  // For custom components, try using the tag name if unique enough
  if (tag.includes('-') || tag.startsWith('p-') || tag.startsWith('mat-') || tag.startsWith('ng-')) {
    const sel = tag;
    if (isUnique(sel)) return clean(sel);
  }

  // =========================
  // PRIORITY 7: Combined
  // =========================

  const parts = [tag];
  if (element.id && !isLikelyGeneratedId(element.id)) {
    parts.push(`#${escape(element.id)}`);
  }
  if (role && role !== "combobox" && role !== "button") {
    parts.push(`[role="${escape(role)}"]`);
  }

  if (parts.length > 1) {
    const sel = parts.join("");
    if (isUnique(sel)) return clean(sel);
  }

  // =========================
  // FINAL FALLBACK: XPATH (FIXED)
  // =========================

  let xpathTarget = element;

  // 🔑 Fix for dropdowns / comboboxes
  if (xpathTarget.getAttribute?.("role") === "combobox") {
    const container = xpathTarget.closest("p-dropdown, mat-select, ng-select, [role='combobox']");
    if (container) {
      xpathTarget = container;
    }
  }

  // 🔑 Fix for SVG / icon clicks
  if (xpathTarget instanceof SVGElement) {
    const clickableAncestor = xpathTarget.closest(
      'button, a[href], [role="button"], p-dropdown, mat-select, ng-select, [tabindex]:not([tabindex="-1"])'
    );
    if (clickableAncestor) xpathTarget = clickableAncestor;
  }

  return `xpath=${getXPath(xpathTarget)}`;

  function getXPath(el) {
    if (el === document.body) return "/html/body";
    if (!el || !el.parentNode) return "";

    const siblings = Array.from(el.parentNode.children).filter(
      (n) => n.tagName === el.tagName
    );
    const idx = siblings.indexOf(el) + 1;

    return `${getXPath(el.parentNode)}/${el.tagName.toLowerCase()}[${idx}]`;
  }
}


function getUniqueElementKey(element) {
  // Use formcontrolname if available (most reliable for Angular)
  const formControlName = element.getAttribute('formcontrolname');
  if (formControlName) {
    return formControlName; // Simple and unique
  }

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

    // Only include stable, non-Angular classes
    if (current.className) {
      const stableClasses = current.className.split(' ')
        .filter(cls => !cls.includes('ng-') &&
          !cls.includes('cdk-') &&
          !cls.includes('mat-') &&
          !cls.includes('touched') &&
          !cls.includes('pristine') &&
          !cls.includes('dirty') &&
          !cls.includes('valid') &&
          !cls.includes('invalid'))
        .filter(cls => cls.trim());

      if (stableClasses.length > 0) {
        attributes += `[@class="${stableClasses.join(' ')}"]`;
      }
    }

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
  console.log('=== transformStepsForExport START ===');
  console.log('Raw steps input:', rawSteps);
  console.log('Number of raw steps:', rawSteps?.length || 0);
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) return [];
  const out = [];

  for (let i = 0; i < rawSteps.length; i++) {
    const step = rawSteps[i];
    const nextStep = rawSteps[i + 1];

    // Clean step before adding
    const cleanStep = cleanStepForExport(step);
    out.push(cleanStep);

    // try {
    //   const curUrl = step?._metadata?.pageUrl;
    //   const nextUrl = nextStep?._metadata?.pageUrl;

    //   // Insert framework stabilization wait AFTER navigation / URL change.
    //   if (nextStep && curUrl && nextUrl && curUrl !== nextUrl) {
    //     out.push({
    //       action: 'goto',
    //       url: nextUrl,
    //       _metadata: { inserted: true, pageUrl: nextUrl }
    //     });

    //     // Single stabilization delay
    //     out.push({
    //       action: 'waitForTimeout',
    //       timeout: 500,
    //       _metadata: { inserted: true, purpose: 'framework-stabilization' }
    //     });
    //   }
    // } catch (err) { }
  }

  console.log('Steps after adding waits:', out);

  // Deduplicate
  const deduped = [];
  for (let i = 0; i < out.length; i++) {
    const cur = out[i];
    const prev = deduped.length ? deduped[deduped.length - 1] : null;

    // Helper function to check if actions are the same
    const isSameAction = (a, b) => {
      if (!a || !b) return false;
      return a.action === b.action &&
        a.selector === b.selector &&
        a.url === b.url;
    };

    if (!isSameAction(prev, cur)) {
      deduped.push(cur);
    } else if (prev && cur && cur._metadata) {
      // Merge metadata if same action
      prev._metadata = { ...prev._metadata, ...cur._metadata };
    }
  }

  // Final essential fields check to ensure we have valid steps
  const finalSteps = deduped.filter(step => {
    // A step is valid if:
    // 1. It has an action
    // 2. AND it has either a selector, url, or assertAfter
    const hasEssentialFields = step.action && (
      step.selector ||
      step.url ||
      step.assertAfter !== undefined
    );

    // Also ensure it's not an empty object
    const hasContent = Object.keys(step).length > 0;

    return hasEssentialFields && hasContent;
  });

  console.log('Final transformed steps:', finalSteps);
  console.log('Number of final steps:', finalSteps.length);
  console.log('=== transformStepsForExport END ===');

  return finalSteps;
}

function cleanStepForExport(step) {
  if (!step) return step;

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
  }, 1000);
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