// background/background.js
console.log('hiTeman: Background service worker started');

// Store active recording sessions
const activeRecordings = new Map();

// CDP Debugger state management
const attachedTabs = new Set();
const requestMap = new Map();
const waitingForApiCapture = new Map(); // tabId -> {actionIndex, resolve, timeout}
const apiCaptureTimeouts = new Map();

// Initialize storage on installation
chrome.runtime.onInstalled.addListener(() => {
  console.log("hiTeman: Extension installed/updated");
  chrome.storage.local.set({
    recording_status: null,
    recordedData: [],
    isRecording: false
  }, () => {
    console.log("Initial storage state set to {isRecording: false, recordedData: []}");
  });
});

// Listen for external messages (from Angular app)
chrome.runtime.onMessageExternal.addListener((request, sender, sendResponse) => {
  console.log('External message received:', request.action);

  if (request.action === "GET_RECORDING_STATUS") {
    chrome.storage.local.get(["recording_status", "isRecording"], (result) => {
      console.log('Returning recording status:', result);
      sendResponse({
        recordingStatus: result.recording_status,
        isRecording: result.isRecording
      });
    });
    return true;
  }
});

// Listen for messages from content script and popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Background received:', request.action, 'from tab:', sender.tab?.id, 'with data:', request.data ? Object.keys(request.data).join(', ') : 'none');

  switch (request.action) {
    case "startRecording":
      handleStartRecording(request, sender, sendResponse);
      return true;

    case "stopRecording":
      handleStopRecording(request, sender, sendResponse);
      return true;

    case "RECORDING_COMPLETED":
      handleRecordingCompleted(request, sender, sendResponse);
      return true;

    case "DOWNLOAD_JSON":
      handleDownloadJson(request, sender, sendResponse);
      return true;

    case "checkStorage":
      handleCheckStorage(request, sender, sendResponse);
      return true;

    case "EXIT_RECORDING":
      handleExitRecording(request, sender, sendResponse);
      return true;

    case "SAVE_STATE":
      handleSaveState(request, sender, sendResponse);
      return true;

    case "GET_RECORDED_DATA":
      handleGetRecordedData(request, sender, sendResponse);
      return true;

    case "CLEAR_RECORDED_DATA":
      handleClearRecordedData(request, sender, sendResponse);
      return true;

    case "ACTION_RECORDED":
      handleActionRecorded(request, sender, sendResponse);
      return true;

    case "START_API_CAPTURE":
      console.log("🎬 START_API_CAPTURE received from content script");
      console.log("📋 Capture details:", {
        tabId: sender.tab?.id,
        actionIndex: request.actionIndex,
        waitingForApiCaptureSize: waitingForApiCapture.size,
        attachedTabs: Array.from(attachedTabs)
      });
      handleStartApiCapture(request, sender, sendResponse);
      return true;

    case "saveRecording":
      chrome.storage.local.get(["recordedData"], (result) => {
        const currentData = result.recordedData || [];
        const newData = [...currentData, request.data];
        chrome.storage.local.set({ recordedData: newData }, () => {
          console.log(`Legacy saveRecording executed. Total steps: ${newData.length}`);
          sendResponse({ status: "Data saved" });
        });
      });
      return true;

    case "clearRecording":
      chrome.storage.local.set({ recordedData: [] }, () => {
        console.log("Legacy clearRecording executed.");
        sendResponse({ status: "Data cleared" });
      });
      return true;
  }
});

// Handle starting recording
function handleStartRecording(request, sender, sendResponse) {
  const tabId = sender.tab?.id;

  if (!tabId) {
    console.error("startRecording failed - No tab ID available.");
    sendResponse({ status: "error", message: "No tab ID available" });
    return;
  }

  chrome.storage.local.set({
    recording_status: {
      type: "RECORDING_STARTED",
      timestamp: new Date().toISOString(),
      tabId: tabId,
      url: sender.tab?.url || "",
      data: []
    },
    isRecording: true,
    recordedData: []
  }, () => {
    console.log(`Recording started for tab ${tabId} on URL: ${sender.tab?.url}`);
    activeRecordings.set(tabId, {
      startTime: Date.now(),
      url: sender.tab?.url
    });

    // Attach debugger for API capture if recording is active
    if (activeRecordings.has(tabId)) {
      tryAttachDebugger(tabId);
    }

    console.log(`activeRecordings map size: ${activeRecordings.size}`);
    sendResponse({ status: "Recording started", tabId });
  });
}

// Handle stopping recording
function handleStopRecording(request, sender, sendResponse) {
  const tabId = sender.tab?.id;

  // Don't clear recordedData when stopping, just set isRecording to false
  chrome.storage.local.get(["recordedData"], (result) => {
    chrome.storage.local.set({
      isRecording: false,
      recordedData: result.recordedData || [] // Preserve existing data
    }, () => {
      if (tabId) {
        activeRecordings.delete(tabId);
        // Detach debugger when recording stops
        tryDetachDebugger(tabId);
      }
      console.log(`Recording stopped for tab ${tabId}`);
      console.log(`activeRecordings map size after stop: ${activeRecordings.size}`);
      console.log(`Recorded data preserved: ${(result.recordedData || []).length} steps`);
      sendResponse({ status: "Recording stopped" });
    });
  });
}

// Handle API capture start for shift+click
function handleStartApiCapture(request, sender, sendResponse) {
  const tabId = sender.tab?.id; // Get tabId from sender, not request
  const actionIndex = request.actionIndex;

  if (!tabId) {
    console.error("START_API_CAPTURE failed - No tab ID available.");
    sendResponse({ status: "error", message: "No tab ID available" });
    return;
  }

  console.log(`Starting API capture for tab ${tabId}, action index ${actionIndex}`);
  console.log(`📊 Current state - attachedTabs: ${Array.from(attachedTabs)}, waitingForApiCapture: ${waitingForApiCapture.size}`);

  // Ensure debugger is attached
  tryAttachDebugger(tabId);

  // Clear any existing capture state
  if (waitingForApiCapture.has(tabId)) {
    const existing = waitingForApiCapture.get(tabId);
    console.log(`🧹 Clearing existing capture state for tab ${tabId}`);
    if (existing.timeout) {
      clearTimeout(existing.timeout);
      console.log(`⏰ Cleared existing timeout for tab ${tabId}`);
    }
    waitingForApiCapture.delete(tabId);
  }

  // Clear any existing timeout
  if (apiCaptureTimeouts.has(tabId)) {
    clearTimeout(apiCaptureTimeouts.get(tabId));
    apiCaptureTimeouts.delete(tabId);
    console.log(`🗑️ Cleared existing API capture timeout for tab ${tabId}`);
  }

  // Set up capture state with 10-second timeout
  const captureState = {
    actionIndex: actionIndex,
    startedAt: Date.now(),
    tabId: tabId
  };

  waitingForApiCapture.set(tabId, captureState);
  console.log(`✅ Capture state set for tab ${tabId}. Waiting for JSON API calls...`);

  // Set timeout to auto-cancel capture after 10 seconds
  const timeoutId = setTimeout(() => {
    if (waitingForApiCapture.has(tabId)) {
      console.log(`⏰ API capture timeout for tab ${tabId} after 10 seconds`);
      console.log(`❌ No API calls captured within timeout period`);
      waitingForApiCapture.delete(tabId);
      
      // Notify content script about timeout
      try {
        chrome.tabs.sendMessage(tabId, {
          action: 'API_CAPTURE_TIMEOUT',
          actionIndex: actionIndex
        });
        console.log(`📤 Sent API_CAPTURE_TIMEOUT to content script for tab ${tabId}`);
      } catch (error) {
        console.log("⚠️ Could not send timeout notification:", error);
      }
    }
  }, 10000);

  apiCaptureTimeouts.set(tabId, timeoutId);
  console.log(`⏰ Set 10-second timeout for API capture on tab ${tabId}`);

  sendResponse({ status: "api_capture_started", tabId });
}

// Debugger attachment for CDP
function tryAttachDebugger(tabId) {
  if (attachedTabs.has(tabId)) {
    console.log(`🔍 Debugger already attached to tab ${tabId}`);
    return;
  }

  console.log(`🔄 Attempting to attach debugger to tab ${tabId}...`);
  chrome.debugger.attach(
    { tabId },
    "1.3",
    () => {
      if (chrome.runtime.lastError) {
        console.error(`❌ Debugger attach failed for tab ${tabId}:`, chrome.runtime.lastError.message);
        return;
      }

      attachedTabs.add(tabId);
      chrome.debugger.sendCommand({ tabId }, "Network.enable");
      setupDebuggerListeners(tabId);
      console.log(`✅ Debugger attached to tab ${tabId}, Network.enable sent`);
    }
  );
}

function tryDetachDebugger(tabId) {
  if (!attachedTabs.has(tabId)) {
    console.log(`🔍 Debugger not attached to tab ${tabId}, skipping detach`);
    return;
  }

  console.log(`🔄 Detaching debugger from tab ${tabId}...`);
  chrome.debugger.detach({ tabId }, () => {
    if (chrome.runtime.lastError) {
      console.warn(`⚠️ Debugger detach failed for tab ${tabId}:`, chrome.runtime.lastError.message);
    } else {
      attachedTabs.delete(tabId);
      console.log(`✅ Debugger detached from tab ${tabId}`);
    }
  });
}

function setupDebuggerListeners(tabId) {
  console.log(`👂 Setting up debugger listeners for tab ${tabId}`);
  
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId !== tabId) return;

    // Only process if we're waiting for API capture for this tab
    if (!waitingForApiCapture.has(tabId)) {
      // Optional: log that we're ignoring events when not waiting
      if (method.startsWith("Network.")) {
        console.log(`📡 Ignoring ${method} for tab ${tabId} (not waiting for capture)`);
      }
      return;
    }

    const captureState = waitingForApiCapture.get(tabId);
    console.log(`📡 Debugger event for tab ${tabId}: ${method}`);

    switch (method) {
      case "Network.requestWillBeSent":
        console.log(`🌐 Network request: ${params.request.method} ${params.request.url}`);
        console.log(`📦 Request headers count: ${Object.keys(params.request.headers || {}).length}`);
        
        requestMap.set(params.requestId, {
          url: params.request.url,
          method: params.request.method,
          requestHeaders: params.request.headers || {},
          requestBody: params.request.postData || null,
          timestamp: Date.now()
        });
        break;

      case "Network.responseReceived":
        console.log(`📥 Response received for requestId: ${params.requestId}`);
        console.log(`📊 Response status: ${params.response.status} ${params.response.statusText || ""}`);
        console.log(`📄 MIME type: ${params.response.mimeType || "unknown"}`);
        
        const entry = requestMap.get(params.requestId);
        if (entry) {
          entry.status = params.response.status;
          entry.statusText = params.response.statusText || "OK";
          entry.responseHeaders = params.response.headers || {};
          entry.mimeType = params.response.mimeType || "";
          
          // Check if this is a JSON response
          const isJson = entry.mimeType && entry.mimeType.includes("json");
          console.log(`🔍 Response is JSON: ${isJson}`);
        } else {
          console.log(`⚠️ No request entry found for requestId: ${params.requestId}`);
        }
        break;

      case "Network.loadingFinished":
        console.log(`✅ Loading finished for requestId: ${params.requestId}`);
        
        const req = requestMap.get(params.requestId);
        if (!req) {
          console.log(`⚠️ No request data found for requestId: ${params.requestId}`);
          return;
        }

        // Check if we're still waiting for capture
        if (!captureState) {
          console.log(`⚠️ No capture state found for tab ${tabId}, ignoring request`);
          return;
        }

        if (!req.mimeType || !req.mimeType.includes("json")) {
          console.log(`📭 Ignoring non-JSON response (${req.mimeType}) for ${req.url}`);
          return;
        }

        console.log(`🎯 Found JSON API call for tab ${tabId}`);
        console.log(`📊 Request details: ${req.method} ${req.url}, Status: ${req.status}`);
        console.log(`⏱️ Capture started ${Date.now() - captureState.startedAt}ms ago`);

        // Get response body
        chrome.debugger.sendCommand(
          { tabId },
          "Network.getResponseBody",
          { requestId: params.requestId },
          (result) => {
            if (chrome.runtime.lastError) {
              console.error("❌ Failed to get response body:", chrome.runtime.lastError);
              return;
            }

            if (!result) {
              console.log("⚠️ No response body received");
              return;
            }

            console.log(`📦 Response body received, base64Encoded: ${result.base64Encoded}`);
            console.log(`📏 Response body length: ${result.body ? result.body.length : 0}`);

            let responseBody = result.body;
            if (result.base64Encoded) {
              try { 
                responseBody = atob(result.body);
                console.log(`🔓 Successfully decoded base64 response`);
              } catch (error) {
                console.error("❌ Failed to decode base64 response:", error);
                return;
              }
            }

            let parsedResponse;
            try {
              parsedResponse = JSON.parse(responseBody);
              console.log(`✅ Successfully parsed JSON response`);
              console.log(`📊 Response type: ${Array.isArray(parsedResponse) ? 'Array' : 'Object'}`);
              console.log(`📐 Response size: ${JSON.stringify(parsedResponse).length} chars`);
            } catch (error) {
              console.warn("⚠️ Response is not valid JSON:", error);
              return;
            }

            // Format the API assertion
            console.log(`🛠️ Formatting API assertion...`);
            const assertion = formatApiAssertion(req, parsedResponse);
            console.log(`✅ Assertion formatted with type: ${assertion.assertionType}`);
            console.log(`📤 Assertion includes: request body (${assertion.request.body ? 'yes' : 'no'}), response body (${assertion.response.body ? 'yes' : 'no'})`);

            // Send to content script
            try {
              chrome.tabs.sendMessage(tabId, {
                action: 'API_CAPTURE_RESULT',
                assertion: assertion,
                actionIndex: captureState.actionIndex
              });
              console.log(`📤 Sent API_CAPTURE_RESULT to content script for action index ${captureState.actionIndex}`);
            } catch (error) {
              console.error("❌ Failed to send API_CAPTURE_RESULT to content script:", error);
            }

            // Clean up
            requestMap.delete(params.requestId);
            waitingForApiCapture.delete(tabId);
            
            // Clear timeout
            if (apiCaptureTimeouts.has(tabId)) {
              clearTimeout(apiCaptureTimeouts.get(tabId));
              apiCaptureTimeouts.delete(tabId);
              console.log(`🗑️ Cleared API capture timeout for tab ${tabId}`);
            }

            console.log(`🎉 API capture COMPLETED successfully for tab ${tabId}`);
            console.log(`📊 Remaining waitingForApiCapture: ${waitingForApiCapture.size}, requestMap: ${requestMap.size}`);
          }
        );
        break;
        
      default:
        // Optional: log other network events for debugging
        if (method.startsWith("Network.")) {
          console.log(`📡 Other network event: ${method}`);
        }
        break;
    }
  });
}

function formatApiAssertion(req, responseBody) {
  console.log(`🛠️ Creating API assertion for URL: ${req.url}`);
  
  const url = new URL(req.url);
  const queryParams = {};
  url.searchParams.forEach((value, key) => {
    queryParams[key] = value;
  });
  
  console.log(`🔗 URL parsed - hostname: ${url.hostname}, path: ${url.pathname}`);
  console.log(`🔍 Query params count: ${Object.keys(queryParams).length}`);

  // Parse request body if present
  let parsedRequestBody = null;
  if (req.requestBody) {
    console.log(`📥 Request body present, length: ${req.requestBody.length}`);
    try {
      // Try to parse as JSON
      if (req.requestBody.startsWith('{') || req.requestBody.startsWith('[')) {
        parsedRequestBody = JSON.parse(req.requestBody);
        console.log(`✅ Request body parsed as JSON`);
      } else if (req.requestBody.includes('=')) {
        // Try to parse as URL-encoded
        parsedRequestBody = Object.fromEntries(
          new URLSearchParams(req.requestBody)
        );
        console.log(`✅ Request body parsed as URL-encoded`);
      } else {
        parsedRequestBody = req.requestBody;
        console.log(`📝 Request body treated as plain text`);
      }
    } catch (error) {
      console.warn(`⚠️ Failed to parse request body:`, error);
      parsedRequestBody = req.requestBody;
    }
  } else {
    console.log(`📭 No request body found`);
  }

  const assertion = {
    _metadata: {
      hostname: url.hostname,
      origin: url.origin,
      originalUrl: req.url,
      timestamp: new Date().toISOString()
    },
    assertionType: "api",
    expectedStatus: req.status,
    expectedStatusText: req.statusText,
    request: {
      body: parsedRequestBody,
      headers: req.requestHeaders,
      query: queryParams
    },
    response: {
      body: responseBody,
      headers: req.responseHeaders
    },
    target: {
      fullUrl: req.url,
      method: req.method,
      url: `${url.origin}${url.pathname}`
    }
  };
  
  console.log(`✅ API assertion created successfully`);
  console.log(`📊 Assertion summary: ${req.method} ${url.pathname} → ${req.status}`);
  
  return assertion;
}

// Handle recording completion
function handleRecordingCompleted(request, sender, sendResponse) {
  console.log("📝 handleRecordingCompleted called");

  const recordingData = request.data;
  let playwrightData = request.playwrightData;

  if (!playwrightData && recordingData.data) {
    playwrightData = {
      steps: recordingData.data.map(action => {
        const { _metadata, ...cleanAction } = action;
        return cleanAction;
      }),
      metadata: {
        timestamp: recordingData.timestamp,
        type: "PLAYWRIGHT_RECORDING",
        generator: "hiTeman Chrome Extension"
      }
    };
  }

  const assertionCount = playwrightData.steps.reduce((count, step) =>
    count + (step.assertAfter ? step.assertAfter.length : 0), 0
  );

  console.log("🎯 Recording Completion Summary:");
  console.log(`📊 Total steps in final output: ${playwrightData.steps.length}`);
  console.log(`🔍 Total API assertions in final output: ${assertionCount}`);

  playwrightData.metadata.assertionCount = assertionCount;
  playwrightData.metadata.totalSteps = playwrightData.steps.length;

  chrome.storage.local.set({
    recording_status: {
      ...recordingData,
      playwrightData: playwrightData,
      completedAt: new Date().toISOString()
    },
    isRecording: false,
    recordedData: recordingData.data || []
  }, () => {
    console.log(`💾 Final recording saved with ${playwrightData.steps.length} steps and ${assertionCount} assertions.`);

    sendResponse({
      status: "Recording saved",
      stats: {
        totalSteps: playwrightData.steps.length,
        assertions: assertionCount
      }
    });
  });
}

// Handle JSON download
function handleDownloadJson(request, sender, sendResponse) {
  chrome.storage.local.get(["recording_status"], (result) => {
    let jsonData;

    if (result.recording_status && result.recording_status.playwrightData) {
      jsonData = result.recording_status.playwrightData;
      console.log(`💾 Using stored playwright data with ${jsonData.steps.length} steps`);
    } else if (request.data) {
      jsonData = {
        steps: request.data.map(action => {
          const { _metadata, ...cleanAction } = action;
          return cleanAction;
        }),
        metadata: {
          timestamp: new Date().toISOString(),
          type: "PLAYWRIGHT_RECORDING",
          generator: "hiTeman Chrome Extension"
        }
      };
      console.log(`📦 Using fallback data with ${jsonData.steps.length} steps`);
    } else {
      console.error("❌ No data available for download");
      sendResponse({ status: "error", error: "No data available" });
      return;
    }

    const assertionCount = jsonData.steps.reduce((count, step) =>
      count + (step.assertAfter ? step.assertAfter.length : 0), 0
    );
    console.log(`📊 Download includes ${jsonData.steps.length} steps with ${assertionCount} assertions`);

    const jsonString = JSON.stringify(jsonData, null, 2);
    const dataUrl = "data:application/json;charset=utf-8," + encodeURIComponent(jsonString);

    chrome.downloads.download({
      url: dataUrl,
      filename: `hiTeman-recording-${Date.now()}.json`,
      saveAs: true
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error("❌ Download error:", chrome.runtime.lastError);
        sendResponse({ status: "error", error: chrome.runtime.lastError.message });
      } else {
        console.log(`✅ Download started with ID: ${downloadId}`);
        sendResponse({
          status: "download_started",
          downloadId,
          stats: {
            steps: jsonData.steps.length,
            assertions: assertionCount
          }
        });
      }
    });
  });
}

// Handle storage check
function handleCheckStorage(request, sender, sendResponse) {
  chrome.storage.local.get(["recording_status", "recordedData", "isRecording"], (result) => {
    console.log("📦 CheckStorage results:", {
      isRecording: result.isRecording,
      stepCount: (result.recordedData || []).length
    });
    sendResponse({
      data: result.recording_status,
      recordedData: result.recordedData,
      isRecording: result.isRecording
    });
  });
}

// Handle exit recording
function handleExitRecording(request, sender, sendResponse) {
  const tabId = sender.tab?.id;

  if (tabId) {
    activeRecordings.delete(tabId);
    tryDetachDebugger(tabId);
  }

  chrome.storage.local.set({
    isRecording: false,
    recordedData: []
  }, () => {
    console.log("🚪 Recording session explicitly exited and cleared.");
    sendResponse({ status: "exited" });

    if (tabId && request.closeTab !== false) {
      setTimeout(() => {
        console.log(`🗑️ Closing tab ${tabId} as requested.`);
        chrome.tabs.remove(tabId);
      }, 100);
    }
  });
}

// Handle save state
function handleSaveState(request, sender, sendResponse) {
  chrome.storage.local.get(["recording_status", "recordedData"], (result) => {
    const currentStatus = result.recording_status || {};
    const currentData = result.recordedData || [];

    const newData = [...currentData, ...(request.data.steps || [])];

    chrome.storage.local.set({
      recording_status: {
        ...currentStatus,
        ...request.data,
        tabId: sender.tab?.id,
        type: "RECORDING_STARTED",
        lastUpdated: new Date().toISOString()
      },
      recordedData: newData
    }, () => {
      console.log(`💾 State saved with ${request.data.steps?.length || 0} new step(s). Total steps: ${newData.length}`);
      sendResponse({ status: "State saved", stepCount: newData.length });
    });
  });
}

// Handle get recorded data
function handleGetRecordedData(request, sender, sendResponse) {
  chrome.storage.local.get(["recordedData"], (result) => {
    console.log(`📤 Sending recorded data. Count: ${(result.recordedData || []).length}`);
    sendResponse({
      status: "success",
      data: result.recordedData || [],
      count: (result.recordedData || []).length
    });
  });
}

// Handle clear recorded data
function handleClearRecordedData(request, sender, sendResponse) {
  chrome.storage.local.set({
    recordedData: []
  }, () => {
    console.log("🧹 Recorded data cleared.");
    sendResponse({ status: "cleared" });
  });
}

// Handle action recorded
function handleActionRecorded(request, sender, sendResponse) {
  console.log(`📝 Action recorded: ${request.data.step.action} (Total: ${request.data.totalSteps})`);

  chrome.runtime.sendMessage({
    action: "UPDATE_STEP_COUNT",
    count: request.data.totalSteps
  }).catch(() => {});

  sendResponse({ status: "notified" });
}

// Handle extension icon click
chrome.action.onClicked.addListener((tab) => {
  chrome.storage.local.get(["isRecording"], (result) => {
    console.log(`🖱️ Action icon clicked. isRecording: ${result.isRecording}`);
    if (result.isRecording) {
      chrome.action.setPopup({ popup: "popup/popup.html" });
      chrome.action.openPopup();
    } else {
      chrome.tabs.sendMessage(tab.id, {
        action: "startRecording"
      });
    }
  });
});

// Handle tab updates (navigation)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete") {
    chrome.storage.local.get(["recording_status", "isRecording"], (result) => {
      const status = result.recording_status;
      const isRecording = result.isRecording;

      if (isRecording && status && status.tabId === tabId) {
        console.log(`🔄 Tab ${tabId} completed navigation. Attempting to restore recording.`);
        setTimeout(() => {
          chrome.tabs.sendMessage(tabId, {
            action: "RESTORE_RECORDING",
            data: status
          }).catch((error) => {
            console.log("⚠️ Content script not ready yet, will retry:", error);
            setTimeout(() => {
              chrome.tabs.sendMessage(tabId, {
                action: "RESTORE_RECORDING",
                data: status
              }).catch((e) => {
                console.error("❌ Failed to restore recording on navigation after retry:", e);
              });
            }, 500);
          });
        }, 1000);
      }
    });
  }
});

// Handle tab removal
chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeRecordings.has(tabId)) {
    activeRecordings.delete(tabId);
    tryDetachDebugger(tabId);
    console.log(`🧹 Cleaned up recording session for closed tab ${tabId}`);
  }
  
  // Clean up API capture state
  if (waitingForApiCapture.has(tabId)) {
    console.log(`🧹 Removing API capture state for closed tab ${tabId}`);
    waitingForApiCapture.delete(tabId);
  }
  if (apiCaptureTimeouts.has(tabId)) {
    clearTimeout(apiCaptureTimeouts.get(tabId));
    apiCaptureTimeouts.delete(tabId);
    console.log(`⏰ Cleared API capture timeout for closed tab ${tabId}`);
  }
});

// Handle window focus changes
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    console.log('🔍 Browser unfocused.');
    return;
  }

  chrome.tabs.query({ active: true, windowId }, (tabs) => {
    if (tabs[0]) {
      const tabId = tabs[0].id;
      if (activeRecordings.has(tabId)) {
        console.log(`▶️ Resuming recording for focused tab ${tabId}.`);
        chrome.tabs.sendMessage(tabId, {
          action: "RESUME_RECORDING"
        }).catch(() => {});
      }
    }
  });
});

// Service worker wake-up
chrome.runtime.onStartup.addListener(() => {
  console.log('⏰ hiTeman: Service worker started on browser startup');

  chrome.storage.local.get(["isRecording", "recording_status"], (result) => {
    if (result.isRecording && result.recording_status) {
      const tabId = result.recording_status.tabId;
      if (tabId) {
        activeRecordings.set(tabId, {
          startTime: Date.now(),
          url: result.recording_status.url
        });
        console.log(`🔄 Restored recording session for tab ${tabId}.`);
      }
    }
  });
});

// Utility to safely parse body content for logging/assertion creation
function parseBody(bodyString) {
  if (!bodyString) return null;
  try {
    return JSON.parse(bodyString);
  } catch (e) {
    return bodyString.length > 50 ? bodyString.substring(0, 50) + '...' : bodyString;
  }
}