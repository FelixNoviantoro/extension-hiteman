// Mendengarkan ketika ekstensi diinstal atau diupdate
chrome.runtime.onInstalled.addListener(() => {
  console.log("Ekstensi berhasil diinstal");
});

// Menyimpan data rekaman
let recordedData = [];

// Mendengarkan pesan external (dari Angular app)
chrome.runtime.onMessageExternal.addListener(function (
  request,
  sender,
  sendResponse
) {
  if (request.action === "GET_RECORDING_STATUS") {
    // Ambil data dari extension storage
    chrome.storage.local.get(["recording_status"], function (result) {
      sendResponse({ recordingStatus: result.recording_status });
    });
    return true; // Penting untuk async response
  }
});

// Mendengarkan pesan dari content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "saveRecording") {
    // Menyimpan data dari content script
    recordedData.push(request.data);
    sendResponse({ status: "Data saved" });
  } else if (request.action === "getRecording") {
    // Mengirim data ke popup untuk di-download
    sendResponse({ data: recordedData });
  } else if (request.action === "clearRecording") {
    // Reset data rekaman
    recordedData = [];
    sendResponse({ status: "Data cleared" });
  } else if (request.action === "startRecording") {
    // Reset dan simpan status recording dimulai
    chrome.storage.local.set(
      {
        recording_status: {
          type: "RECORDING_STARTED",
          timestamp: new Date().toISOString(),
          tabId: sender.tab.id, // Simpan tab ID
          url: sender.tab.url, // Simpan URL
          data: [],
        },
      },
      () => {
        console.log("Recording started");
        sendResponse({ status: "Recording started" });
      }
    );
    return true;
  } else if (request.action === "RECORDING_COMPLETED") {
    const recordingData = request.data;

    // Convert to Playwright format before saving
    const playwrightData = {
      steps: recordingData.data.map(action => {
        // Remove metadata for clean output
        const { _metadata, ...cleanAction } = action;
        return cleanAction;
      }),
      metadata: {
        timestamp: recordingData.timestamp,
        type: "PLAYWRIGHT_RECORDING",
        generator: "hiTeman Chrome Extension"
      }
    };

    // Simpan ke storage
    chrome.storage.local.set(
      {
        recording_status: {
          ...recordingData,
          playwrightData: playwrightData
        },
      },
      () => {
        chrome.storage.local.get(["recording_status"], function (result) {
          console.log("Data tersimpan di storage:", result.recording_status);
        });
      }
    );
  } else if (request.action === "DOWNLOAD_JSON") {
    // Convert to Playwright format
    const playwrightData = {
      steps: request.data.map(action => {
        // Remove metadata for clean output
        const { _metadata, ...cleanAction } = action;
        return cleanAction;
      }),
      metadata: {
        timestamp: new Date().toISOString(),
        type: "PLAYWRIGHT_RECORDING",
        generator: "hiTeman Chrome Extension"
      }
    };

    // Download JSON file
    const jsonString = JSON.stringify(playwrightData, null, 2);
    const dataUrl =
      "data:application/json;charset=utf-8," + encodeURIComponent(jsonString);
    chrome.downloads.download(
      {
        url: dataUrl,
        filename: "playwright-commands.json",
        saveAs: true,
      },
      () => {
        // Tutup tab setelah download selesai
        chrome.tabs.remove(sender.tab.id);
      }
    );
  } else if (request.action === "checkStorage") {
    // Fungsi baru untuk mengecek storage
    chrome.storage.local.get(["recording_status"], function (result) {
      sendResponse({ data: result.recording_status });
    });
    return true; // Penting untuk async response
  } else if (request.action === "EXIT_RECORDING") {
    // Langsung tutup tab tanpa download
    chrome.tabs.remove(sender.tab.id);
  } else if (request.action === "SAVE_STATE") {
    chrome.storage.local.get(["recording_status"], (result) => {
      const currentStatus = result.recording_status || {};

      chrome.storage.local.set(
        {
          recording_status: {
            ...currentStatus,
            ...request.data,
            tabId: sender.tab.id,
            type: "RECORDING_STARTED",
          },
        },
        () => {
          console.log("State saved with navigation info");
          sendResponse({ status: "State saved" });
        }
      );
    });
    return true;
  }
  return true;
});

chrome.action.onClicked.addListener((tab) => {
  // Update path ke recorder.html
  const url = new URL(chrome.runtime.getURL("src/recorder/recorder.html"));
  url.searchParams.set("url", tab.url || "");
  chrome.tabs.create({ url: url.toString() });
});

// Tambahkan listener untuk tab updates
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete") {
    chrome.storage.local.get(["recording_status"], (result) => {
      const status = result.recording_status;
      if (
        status &&
        status.type === "RECORDING_STARTED" &&
        status.tabId === tabId
      ) {
        // Convert to Playwright format for Angular app
        const playwrightData = {
          steps: recordedData.map(action => {
            // Remove metadata for clean output
            const { _metadata, ...cleanAction } = action;
            return cleanAction;
          }),
          metadata: {
            timestamp: status.timestamp,
            type: "PLAYWRIGHT_RECORDING",
            generator: "hiTeman Chrome Extension"
          }
        };

        // Kirim pesan ke content script untuk restore recording
        chrome.tabs.sendMessage(tabId, {
          action: "RESTORE_RECORDING",
          data: status,
        });
      }
    });
  }
});
