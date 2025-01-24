let isRecording = false;
let recordingTabId = null;

document.getElementById("startRecord").addEventListener("click", async () => {
  const urlInput = document.getElementById('urlInput');
  const url = urlInput.value.trim();

  if (!url) {
    alert('Silakan masukkan URL yang valid');
    return;
  }

  try {
    new URL(url);
    // Buka URL di tab baru
    await chrome.tabs.create({ url: url });
    // Tutup popup
    window.close();
  } catch (e) {
    alert('URL tidak valid. Pastikan URL dimulai dengan http:// atau https://');
  }
});

document.getElementById("stopRecord").addEventListener("click", async () => {
  if (recordingTabId) {
    isRecording = false;
    chrome.tabs.sendMessage(recordingTabId, { action: 'stopRecording' });
    document.getElementById('status').textContent = 'Rekaman dihentikan';
    document.getElementById('status').className = '';
  }
});

document.getElementById("downloadJSON").addEventListener("click", async () => {
  if (recordingTabId) {
    chrome.tabs.sendMessage(recordingTabId, { action: 'getRecording' }, (response) => {
      if (response && response.data && response.data.length > 0) {
        // Buat file JSON untuk didownload
        const jsonString = JSON.stringify(response.data, null, 2);
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        // Buat link download dan klik secara otomatis
        const a = document.createElement('a');
        a.href = url;
        a.download = 'selenium-commands.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else {
        alert('Tidak ada data rekaman yang tersedia');
      }
    });
  } else {
    alert('Tidak ada tab yang sedang direkam');
  }
});
