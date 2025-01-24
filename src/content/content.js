let isRecording = false;
let recordedData = [];
let inputBuffer = {}; // Untuk menyimpan input sementara
let observer = null; // Untuk mutation observer
let isTargetPage = false; // Flag untuk menandai halaman target
let currentOverlay = null;
let currentTooltip = null;

// Terima pesan dari popup/background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startRecording') {
    isTargetPage = true;
    isRecording = true;
    recordedData = [];
    
    // Tambahkan step "Open" sebagai langkah pertama
    recordAction('open', document.body, {
      command: 'open',
      value: window.location.href
    });
    
    // Kirim status recording dimulai ke background
    chrome.runtime.sendMessage({ 
      action: 'startRecording'
    }, () => {
      addControlPanel();
      startRecording();
      sendResponse({ status: 'Recording started' });
    });
  } else if (message.action === 'resetStorage') {
    sessionStorage.clear();
  } else if (message.action === 'stopAndDownload') {
    isRecording = false;
    stopRecording();
    // Kirim data rekaman
    sendResponse({ 
      status: 'Recording stopped',
      data: recordedData 
    });
  }
  return true;
});

// Fungsi untuk menambahkan control panel
function addControlPanel() {
  // Hapus control panel yang mungkin sudah ada sebelumnya
  removeControlPanel();

  // Hanya tambahkan control panel jika ini adalah halaman target
  if (!isTargetPage) return;

  const controls = document.createElement('div');
  controls.className = 'recorder-controls';
  controls.innerHTML = `
    <div class="recorder-handle"></div>
    <button class="stop-btn" id="stopBtn">Stop Recording</button>
    <button class="download-btn" id="downloadBtn" style="display: none;">Download JSON</button>
    <button class="exit-btn" id="exitBtn" style="display: none;">Exit</button>
    <div class="recorder-status recording">Recording...</div>
  `;
  document.body.appendChild(controls);

  // Tambah fungsi drag
  let isDragging = false;
  let currentX;
  let currentY;
  let initialX;
  let initialY;
  let xOffset = 0;
  let yOffset = 0;

  const dragStart = (e) => {
    if (e.target.closest('.stop-btn')) return; // Jangan mulai drag jika klik button
    
    initialX = e.type === 'mousedown' ? e.clientX - xOffset : e.touches[0].clientX - xOffset;
    initialY = e.type === 'mousedown' ? e.clientY - yOffset : e.touches[0].clientY - yOffset;

    if (e.target === controls || e.target.closest('.recorder-handle')) {
      isDragging = true;
    }
  };

  const dragEnd = () => {
    isDragging = false;
  };

  const drag = (e) => {
    if (isDragging) {
      e.preventDefault();
      
      currentX = e.type === 'mousemove' ? e.clientX - initialX : e.touches[0].clientX - initialX;
      currentY = e.type === 'mousemove' ? e.clientY - initialY : e.touches[0].clientY - initialY;

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
  controls.addEventListener('mousedown', dragStart);
  document.addEventListener('mousemove', drag);
  document.addEventListener('mouseup', dragEnd);

  // Event listeners untuk touch (mobile)
  controls.addEventListener('touchstart', dragStart);
  document.addEventListener('touchmove', drag);
  document.addEventListener('touchend', dragEnd);

  // Event listener untuk tombol stop
  document.getElementById('stopBtn').addEventListener('click', async () => {
    isRecording = false;
    stopRecording();

    const recordingData = {
      timestamp: new Date().toISOString(),
      data: recordedData,
      type: 'RECORDING_COMPLETED'
    };

    // Simpan ke storage dan kirim ke Angular
    chrome.runtime.sendMessage({ 
      action: 'RECORDING_COMPLETED',
      data: recordingData
    });

    // Kirim ke Angular app jika window.opener tersedia
    if (window.opener) {
      window.opener.postMessage({
        type: 'RECORDING_COMPLETED',
        data: recordingData
      }, 'http://localhost:4200');
    }

    // Update UI setelah stop
    document.getElementById('stopBtn').style.display = 'none';
    document.getElementById('downloadBtn').style.display = 'block';
    document.getElementById('exitBtn').style.display = 'block';
    document.querySelector('.recorder-status').textContent = 'Recording completed';
    document.querySelector('.recorder-status').classList.remove('recording');
  });

  // Event listener untuk tombol download
  document.getElementById('downloadBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ 
      action: 'DOWNLOAD_JSON',
      data: recordedData
    });
  });

  // Event listener untuk tombol exit
  document.getElementById('exitBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ 
      action: 'EXIT_RECORDING'
    });
  });
}

// Fungsi untuk menghapus control panel
function removeControlPanel() {
  const existingPanel = document.querySelector('.recorder-controls');
  if (existingPanel) {
    existingPanel.remove();
  }
}

// Fungsi untuk membersihkan saat navigasi
function cleanup() {
  isRecording = false;
  isTargetPage = false;
  recordedData = [];
  inputBuffer = {};
  if (observer) {
    observer.disconnect();
  }
  removeControlPanel();
  removeOverlay();
}

// Tambahkan event listener untuk unload
window.addEventListener('unload', cleanup);

function startRecording() {
  document.addEventListener('click', handleClick, true);
  document.addEventListener('change', handleChange, true);
  document.addEventListener('input', handleInput, true);
  document.addEventListener('blur', handleBlur, true);
  document.addEventListener('submit', handleSubmit, true);
  
  // Mulai observasi perubahan DOM
  startObserver();
  
  // Tambahkan event listener untuk hover
  document.addEventListener('mouseover', handleHover, true);
  document.addEventListener('mouseout', handleMouseOut, true);
}

function stopRecording() {
  document.removeEventListener('click', handleClick, true);
  document.removeEventListener('change', handleChange, true);
  document.removeEventListener('input', handleInput, true);
  document.removeEventListener('blur', handleBlur, true);
  document.removeEventListener('submit', handleSubmit, true);
  inputBuffer = {};
  
  // Hentikan observasi
  if (observer) {
    observer.disconnect();
  }
  
  document.removeEventListener('mouseover', handleHover, true);
  document.removeEventListener('mouseout', handleMouseOut, true);
  removeOverlay();
}

function handleClick(e) {
  if (!isRecording) return;
  
  const element = e.target;
  
  // Abaikan klik pada control panel dan overlay
  if (element.closest('.recorder-controls') || 
      element.classList.contains('recorder-hover-overlay') ||
      element.classList.contains('recorder-tooltip')) return;
  
  // Tampilkan overlay klik sebentar
  showOverlay(element, 'click');
  setTimeout(() => {
    if (currentOverlay && currentOverlay.classList.contains('recorder-click-overlay')) {
      removeOverlay();
    }
  }, 500);
  
  if (element.tagName === 'A') {
    recordAction('click', element, {
      command: 'click',
      value: '',
      url: element.href
    });
  } else if (element.tagName === 'BUTTON' || 
            (element.tagName === 'INPUT' && element.type === 'submit')) {
    recordAction('click', element, {
      command: 'click',
      value: element.value || element.textContent
    });
  }
}

function handleChange(e) {
  if (!isRecording) return;
  
  const element = e.target;
  
  if (element.tagName === 'SELECT') {
    recordAction('select', element, {
      command: 'select',
      value: element.value
    });
  } else if (element.tagName === 'INPUT' && 
            (element.type === 'checkbox' || element.type === 'radio')) {
    recordAction('click', element, {
      command: 'click',
      value: element.checked
    });
  }
}

function handleInput(e) {
  if (!isRecording) return;
  
  const element = e.target;
  
  if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
    // Simpan value ke buffer
    inputBuffer[getUniqueElementKey(element)] = {
      element: element,
      value: element.value,
      timestamp: new Date()
    };
  }
}

// Tambahkan event untuk blur (ketika input selesai)
function handleBlur(e) {
  if (!isRecording) return;
  
  const element = e.target;
  const bufferKey = getUniqueElementKey(element);
  
  if (inputBuffer[bufferKey]) {
    recordAction('type', element, {
      command: 'type',
      value: element.value
    });
    
    // Hapus dari buffer
    delete inputBuffer[bufferKey];
  }
}

function handleSubmit(e) {
  if (!isRecording) return;
  
  recordAction('submit', e.target, {
    command: 'submit',
    value: ''
  });
}

function recordAction(type, element, data) {
  const selector = getBestSelector(element);
  const action = {
    ...data,
    timestamp: new Date().toISOString(),
    pageUrl: window.location.href,
    target: selector.value,
    selectorType: selector.type
  };

  // Hanya tambahkan elementInfo jika bukan command 'open'
  if (data.command !== 'open') {
    action.elementInfo = {
      tagName: element.tagName,
      id: element.id,
      name: element.name,
      className: element.className,
      type: element.type,
      value: element.value,
      href: element.href,
      text: element.textContent?.trim(),
      isVisible: isElementVisible(element),
      // Tambah informasi visibility untuk assert
      ...(type === 'assert' && {
        visibility: {
          display: window.getComputedStyle(element).display,
          opacity: window.getComputedStyle(element).opacity,
          height: element.offsetHeight,
          width: element.offsetWidth
        }
      })
    };
  }
  
  recordedData.push(action);
  console.log('Action recorded:', action);
}

// Fungsi untuk mendapatkan selector terbaik
function getBestSelector(element) {
  // 1. ID (paling spesifik)
  if (element.id) {
    return {
      type: 'id',
      value: `id=${element.id}`
    };
  }
  
  // 2. Name attribute
  if (element.name) {
    const sameNames = document.getElementsByName(element.name);
    if (sameNames.length === 1) {
      return {
        type: 'name',
        value: `name=${element.name}`
      };
    }
  }
  
  // 3. Link text untuk anchor
  if (element.tagName === 'A' && element.textContent.trim()) {
    const text = element.textContent.trim();
    const sameTextLinks = Array.from(document.getElementsByTagName('A'))
      .filter(a => a.textContent.trim() === text);
    if (sameTextLinks.length === 1) {
      return {
        type: 'linkText',
        value: `linkText=${text}`
      };
    }
    // Jika ada multiple links dengan text yang sama, gunakan partial link text
    return {
      type: 'partialLinkText',
      value: `partialLinkText=${text}`
    };
  }
  
  // 4. Label for attribute
  const label = element.closest('label') || document.querySelector(`label[for="${element.id}"]`);
  if (label && label.textContent.trim()) {
    return {
      type: 'label',
      value: `label=${label.textContent.trim()}`
    };
  }
  
  // 5. XPath yang spesifik
  const xpath = getXPath(element);
  if (xpath) {
    return {
      type: 'xpath',
      value: `xpath=${xpath}`
    };
  }
  
  // 6. CSS Selector sebagai fallback
  return {
    type: 'css',
    value: `css=${getCssSelector(element)}`
  };
}

function getXPath(element) {
  if (!element) return '';
  
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
    for (let sibling = current.previousSibling; sibling; sibling = sibling.previousSibling) {
      if (sibling.nodeType === Node.ELEMENT_NODE && sibling.tagName === current.tagName) {
        index++;
      }
    }
    
    // Tambahkan atribut untuk spesifisitas
    let attributes = '';
    if (current.className) {
      attributes += `[@class="${current.className}"]`;
    }
    if (current.name) {
      attributes += `[@name="${current.name}"]`;
    }
    
    paths.unshift(`/${current.tagName.toLowerCase()}${attributes}[${index}]`);
    current = current.parentNode;
  }
  
  return paths.join('');
}

// Helper function untuk mendapatkan unique key untuk element
function getUniqueElementKey(element) {
  return element.id || element.name || getXPath(element);
}

function getCssSelector(element) {
  if (!element) return '';
  
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
      selector += `.${element.className.trim().replace(/\s+/g, '.')}`;
    }
    
    let index = 1;
    let sibling = element;
    while (sibling = sibling.previousElementSibling) {
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
  
  return path.join(' > ');
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
      if (mutation.type === 'attributes' && 
          (mutation.attributeName === 'style' || 
           mutation.attributeName === 'class' || 
           mutation.attributeName === 'hidden')) {
        checkVisibilityAndContent(mutation.target);
      }

      // Cek perubahan teks
      if (mutation.type === 'characterData' && mutation.target.parentElement) {
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
    attributeFilter: ['style', 'class', 'hidden']
  });
}

// Fungsi untuk memeriksa visibility dan konten elemen
function checkVisibilityAndContent(element) {
  // Abaikan elemen control panel
  if (element.closest('.recorder-controls')) return;

  // Cek apakah elemen visible
  if (isElementVisible(element)) {
    const text = element.textContent?.trim();
    if (text && (isErrorMessage(text) || isMessageElement(element))) {
      // Langsung rekam sebagai assert visibility
      recordAction('assert', element, {
        command: 'assertVisible',
        value: text,
        isError: isErrorMessage(text),
        visibilityType: 'content',
        contentType: isErrorMessage(text) ? 'error' : 'message'
      });
    }
  }
}

// Fungsi untuk memeriksa apakah elemen visible
function isElementVisible(element) {
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && 
         style.visibility !== 'hidden' && 
         style.opacity !== '0' &&
         element.offsetParent !== null;
}

// Fungsi untuk memeriksa apakah teks berisi pesan error
function isErrorMessage(text) {
  const errorKeywords = [
    'error', 'invalid', 'failed', 'incorrect', 'wrong',
    'gagal', 'salah', 'tidak valid', 'tidak benar',
    'required', 'wajib diisi', 'tidak ditemukan',
    'tidak tersedia', 'tidak sesuai', 'tidak boleh kosong',
    'invalid', 'error', 'failed', 'failure', 'denied',
    'rejected', 'unauthorized', 'forbidden'
  ];
  
  return errorKeywords.some(keyword => 
    text.toLowerCase().includes(keyword.toLowerCase())
  );
}

// Fungsi untuk memeriksa apakah elemen biasanya berisi pesan
function isMessageElement(element) {
  const messageClasses = [
    'message', 'alert', 'notification', 'toast',
    'error', 'success', 'warning', 'info',
    'help-block', 'form-text', 'feedback',
    'validation-message', 'help-text',
    'error-text', 'success-text', 'hint-text'
  ];

  const hasMessageClass = messageClasses.some(className => 
    element.className.toLowerCase().includes(className.toLowerCase())
  );

  const messageRoles = ['alert', 'status', 'log', 'note', 'tooltip'];
  const hasMessageRole = messageRoles.includes(element.getAttribute('role'));

  const hasAriaLabel = element.hasAttribute('aria-label');
  const hasAriaDescribedby = element.hasAttribute('aria-describedby');

  return hasMessageClass || hasMessageRole || hasAriaLabel || hasAriaDescribedby;
}

function handleHover(e) {
  if (!isRecording) return;
  
  const element = e.target;
  
  // Abaikan hover pada control panel dan overlay
  if (element.closest('.recorder-controls') || 
      element.classList.contains('recorder-hover-overlay') ||
      element.classList.contains('recorder-tooltip')) return;
  
  showOverlay(element, 'hover');
}

function handleMouseOut(e) {
  if (!isRecording) return;
  removeOverlay();
}

function showOverlay(element, type) {
  removeOverlay();
  
  const rect = element.getBoundingClientRect();
  const overlay = document.createElement('div');
  const tooltip = document.createElement('div');
  
  // Buat overlay
  overlay.className = type === 'hover' ? 'recorder-hover-overlay' : 'recorder-click-overlay';
  overlay.style.top = `${rect.top + window.scrollY}px`;
  overlay.style.left = `${rect.left + window.scrollX}px`;
  overlay.style.width = `${rect.width}px`;
  overlay.style.height = `${rect.height}px`;
  
  // Buat tooltip
  tooltip.className = 'recorder-tooltip';
  const selector = getBestSelector(element);
  tooltip.textContent = `${selector.type}: ${selector.value.split('=')[1]}`;
  
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
  const overlay = document.createElement('div');
  const tooltip = document.createElement('div');
  
  // Buat overlay dengan warna berbeda untuk error dan sukses
  overlay.className = 'recorder-hover-overlay';
  if (options.isError) {
    overlay.style.backgroundColor = 'rgba(255, 0, 0, 0.1)';
    overlay.style.borderColor = '#ff0000';
  } else {
    overlay.style.backgroundColor = 'rgba(0, 255, 0, 0.1)';
    overlay.style.borderColor = '#00ff00';
  }
  
  overlay.style.top = `${rect.top + window.scrollY}px`;
  overlay.style.left = `${rect.left + window.scrollX}px`;
  overlay.style.width = `${rect.width}px`;
  overlay.style.height = `${rect.height}px`;
  
  // Buat tooltip
  tooltip.className = 'recorder-tooltip';
  tooltip.innerHTML = `
    <div style="font-weight: bold; margin-bottom: 4px;">
      ${options.isError ? '🚫 Error Message' : '✅ Success Message'}
    </div>
    <div>${options.text}</div>
  `;
  
  // Posisikan tooltip
  const tooltipX = rect.left + window.scrollX;
  const tooltipY = rect.top + window.scrollY - 25;
  tooltip.style.left = `${tooltipX}px`;
  tooltip.style.top = `${tooltipY}px`;
  
  // Tambahkan event click untuk merekam assertVisible
  overlay.addEventListener('click', () => {
    if (!isRecording) return;
    
    recordAction('assert', element, {
      command: 'assertVisible',
      value: options.text,
      isError: options.isError
    });
    
    // Animasi klik
    overlay.classList.remove('recorder-hover-overlay');
    overlay.classList.add('recorder-click-overlay');
    setTimeout(() => {
      removeOverlay();
    }, 500);
  });
  
  document.body.appendChild(overlay);
  document.body.appendChild(tooltip);
  
  currentOverlay = overlay;
  currentTooltip = tooltip;
}
