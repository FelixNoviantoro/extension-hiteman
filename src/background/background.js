// Mendengarkan ketika ekstensi diinstal atau diupdate
chrome.runtime.onInstalled.addListener(() => {
  console.log('Ekstensi berhasil diinstal');
});

// Menyimpan data rekaman
let recordedData = [];

// Mendengarkan pesan external (dari Angular app)
chrome.runtime.onMessageExternal.addListener(
  function(request, sender, sendResponse) {
    if (request.action === 'GET_RECORDING_STATUS') {
      // Ambil data dari extension storage
      chrome.storage.local.get(['recording_status'], function(result) {
        sendResponse({ recordingStatus: result.recording_status });
      });
      return true; // Penting untuk async response
    }
  }
);

// Mendengarkan pesan dari content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'saveRecording') {
    // Menyimpan data dari content script
    recordedData.push(request.data);
    sendResponse({ status: 'Data saved' });
  } else if (request.action === 'getRecording') {
    // Mengirim data ke popup untuk di-download
    sendResponse({ data: recordedData });
  } else if (request.action === 'clearRecording') {
    // Reset data rekaman
    recordedData = [];
    sendResponse({ status: 'Data cleared' });
  } else if (request.action === 'startRecording') {
    // Reset dan simpan status recording dimulai
    chrome.storage.local.clear(() => {  // Hapus semua data storage dulu
      chrome.storage.local.set({ 
        'recording_status': {
          type: 'RECORDING_STARTED',
          timestamp: new Date().toISOString(),
          data: [] // Inisialisasi data kosong
        }
      }, () => {
        console.log('Recording started, storage cleared');
        sendResponse({ status: 'Storage cleared and recording started' });
      });
    });
    return true; // Penting untuk async response
  } else if (request.action === 'RECORDING_COMPLETED') {
    const recordingData = request.data;
    
    // Hanya simpan ke storage
    chrome.storage.local.set({ 
      'recording_status': recordingData 
    }, () => {
      chrome.storage.local.get(['recording_status'], function(result) {
        console.log('Data tersimpan di storage:', result.recording_status);
      });
    });

  } else if (request.action === 'DOWNLOAD_JSON') {
    const recordingData = {
      timestamp: new Date().toISOString(),
      data: request.data,
      type: 'RECORDING_COMPLETED'
    };

    // Download JSON file
    const jsonString = JSON.stringify(recordingData, null, 2);
    const dataUrl = 'data:application/json;charset=utf-8,' + encodeURIComponent(jsonString);
    chrome.downloads.download({
      url: dataUrl,
      filename: 'selenium-commands.json',
      saveAs: true
    }, () => {
      // Tutup tab setelah download selesai
      chrome.tabs.remove(sender.tab.id);
    });
  } else if (request.action === 'checkStorage') {
    // Fungsi baru untuk mengecek storage
    chrome.storage.local.get(['recording_status'], function(result) {
      sendResponse({ data: result.recording_status });
    });
    return true; // Penting untuk async response
  } else if (request.action === 'EXIT_RECORDING') {
    // Langsung tutup tab tanpa download
    chrome.tabs.remove(sender.tab.id);
  }
  return true;
});

chrome.action.onClicked.addListener((tab) => {
  // Update path ke recorder.html
  const url = new URL(chrome.runtime.getURL('src/recorder/recorder.html'));
  url.searchParams.set('url', tab.url || '');
  chrome.tabs.create({ url: url.toString() });
}); 