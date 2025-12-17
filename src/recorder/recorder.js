// Global function for inline onclick
function startRecording() {
  const targetUrl = document.getElementById('urlInput').value.trim();

  if (!targetUrl) {
    alert('Silakan masukkan URL');
    return;
  }

  try {
    new URL(targetUrl);
    chrome.tabs.create({ url: targetUrl }).then(tab => {
      // Tunggu tab selesai loading dan mulai rekam
      chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.sendMessage(tab.id, { action: 'startRecording' });
          chrome.tabs.onUpdated.removeListener(listener);
          // Tutup tab recorder
          window.close();
        }
      });
    }).catch(error => {
      console.error('Error creating tab:', error);
      alert('Error membuka tab baru');
    });
  } catch (e) {
    alert('URL tidak valid. Pastikan URL dimulai dengan http:// atau https://');
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  // Ambil URL dari parameter dan isi ke input
  const urlParams = new URLSearchParams(window.location.search);
  const url = urlParams.get('url');
  if (url) {
    document.getElementById('urlInput').value = url;
  }

  // Clear storage saat recorder.html dibuka
  if (chrome && chrome.storage) {
    chrome.storage.local.clear(() => {
      console.log('Storage dibersihkan');
    });
  }

  // Handler submit form agar prevent reload dan panggil startRecording
  const form = document.getElementById("recording-form");
  if (form) {
    form.addEventListener("submit", function(e) {
      e.preventDefault();
      startRecording();
    });
  }

  // NEW: Only restore API data if NOT on the recorder page
  const isRecorderPage = window.location.href.includes('recorder.html');
  if (!isRecorderPage && typeof restorePendingApiData === 'function') {
    // This is a page being recorded, restore API data
    setTimeout(restorePendingApiData, 500);
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