// Ambil URL dari parameter dan isi ke input
document.addEventListener('DOMContentLoaded', () => {
  // Ambil URL dari parameter dan isi ke input
  const urlParams = new URLSearchParams(window.location.search);
  const url = urlParams.get('url');
  if (url) {
    document.getElementById('urlInput').value = url;
  }

  // Clear storage saat recorder.html dibuka
  chrome.storage.local.clear(() => {
    console.log('Storage dibersihkan');
  });
});

document.getElementById("startRecord").addEventListener("click", async () => {
  const targetUrl = document.getElementById('urlInput').value.trim();

  if (!targetUrl) {
    alert('Silakan masukkan URL');
    return;
  }

  try {
    new URL(targetUrl);
    const tab = await chrome.tabs.create({ url: targetUrl });
    
    // Tunggu tab selesai loading dan mulai rekam
    chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.sendMessage(tab.id, { action: 'startRecording' });
        chrome.tabs.onUpdated.removeListener(listener);
        // Tutup tab recorder
        window.close();
      }
    });
  } catch (e) {
    alert('URL tidak valid. Pastikan URL dimulai dengan http:// atau https://');
  }
});

// Tambah handler untuk tombol check storage
document.getElementById("checkStorage")?.addEventListener("click", async () => {
  chrome.runtime.sendMessage({ action: 'checkStorage' }, response => {
    if (response.data) {
      alert('Data tersimpan:\n' + JSON.stringify(response.data, null, 2));
    } else {
      alert('Tidak ada data tersimpan');
    }
  });
}); 