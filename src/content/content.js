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
  document.addEventListener('contextmenu', handleRightClick, true);
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
  document.removeEventListener('contextmenu', handleRightClick, true);
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

  // Jika element adalah button type submit atau form submit, jangan record click
  if (element.type === 'submit' || 
      (element.tagName === 'BUTTON' && element.getAttribute('type') === 'submit')) {
    return; // Submit event akan di-handle oleh handleSubmit
  }
  
  if (element.tagName === 'A') {
    recordAction('click', element, {
      command: 'click',
      value: element.textContent.trim() || '',
      url: element.href
    });
  } else if (element.tagName === 'BUTTON' || 
            (element.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(element.type))) {
    recordAction('click', element, {
      command: 'click',
      value: element.value || element.textContent.trim() || ''
    });
  } else if (element.tagName === 'INPUT' && ['checkbox', 'radio'].includes(element.type)) {
    recordAction('click', element, {
      command: 'click',
      value: element.checked.toString()
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
  
  const form = e.target;
  const submitButton = form.querySelector('button[type="submit"], input[type="submit"]');
  
  recordAction('submit', submitButton || form, {
    command: 'submit',
    value: submitButton ? (submitButton.value || submitButton.textContent.trim()) : ''
  });

  // Tunggu sebentar untuk melihat apakah ada response message
  setTimeout(() => {
    const messages = document.querySelectorAll('[role="alert"], .alert, .message, .notification');
    messages.forEach(msg => {
      checkVisibilityAndContent(msg);
    });
  }, 1000);
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
  // 1. ID yang unik
  if (element.id && document.querySelectorAll(`#${element.id}`).length === 1) {
    return {
      type: 'id',
      value: `id=${element.id}`
    };
  }
  
  // 2. Data-testid atau data-cy (untuk testing attributes)
  if (element.dataset) {
    const testId = element.dataset.testid || element.dataset.cy;
    if (testId) {
      return {
        type: 'css',
        value: `css=[data-${testId.includes('testid') ? 'testid' : 'cy'}="${testId}"]`
      };
    }
  }
  
  // 3. Name attribute yang unik
  if (element.name && document.getElementsByName(element.name).length === 1) {
      return {
      type: 'name',
      value: `name=${element.name}`
      };
    }

  // 4. Label dengan for attribute
  const labelFor = element.id && document.querySelector(`label[for="${element.id}"]`);
  if (labelFor && labelFor.textContent.trim()) {
    return {
      type: 'label',
      value: `label=${labelFor.textContent.trim()}`
    };
  }

  // 5. Label sebagai parent
  const parentLabel = element.closest('label');
  if (parentLabel && parentLabel.textContent.trim()) {
    return {
      type: 'label',
      value: `label=${parentLabel.textContent.trim()}`
    };
  }

  // 6. Button/Link dengan exact text
  if ((element.tagName === 'BUTTON' || element.tagName === 'A') && element.textContent.trim()) {
    const text = element.textContent.trim();
    const sameTextElements = Array.from(document.querySelectorAll(element.tagName))
      .filter(el => el.textContent.trim() === text);
    
    if (sameTextElements.length === 1) {
    return {
        type: element.tagName === 'A' ? 'linkText' : 'text',
        value: `${element.tagName === 'A' ? 'linkText' : 'text'}=${text}`
    };
    }
  }
  
  // 7. Input dengan placeholder yang unik
  if (element.placeholder) {
    const sameplaceholder = document.querySelectorAll(`[placeholder="${element.placeholder}"]`);
    if (sameplaceholder.length === 1) {
  return {
    type: 'css',
        value: `css=[placeholder="${element.placeholder}"]`
      };
    }
  }

  // 8. Kombinasi tag, class, dan atribut untuk CSS selector yang unik
  const cssSelector = buildUniqueCssSelector(element);
  if (cssSelector) {
    return {
      type: 'css',
      value: `css=${cssSelector}`
    };
  }

  // 9. XPath sebagai fallback, tapi yang lebih spesifik
  return {
    type: 'xpath',
    value: `xpath=${getSpecificXPath(element)}`
  };
}

function buildUniqueCssSelector(element) {
  let selector = element.tagName.toLowerCase();
  let current = element;
  let index = 1;

  // Tambahkan class yang meaningful (hindari class yang dinamis/generated)
  if (element.className) {
    const classes = element.className.split(' ')
      .filter(c => {
        // Filter class yang kemungkinan besar stabil
        return c && 
               !c.match(/^[0-9]/) && // Hindari class yang dimulai dengan angka
               !c.includes('__') &&   // Hindari class BEM modifier
               !c.includes('--') &&   // Hindari class dengan format khusus
               c.length > 2;          // Hindari class yang terlalu pendek
      });
    
    if (classes.length > 0) {
      selector += '.' + classes.join('.');
    }
  }

  // Tambahkan atribut penting
  ['type', 'role', 'name', 'title', 'aria-label'].forEach(attr => {
    if (element.getAttribute(attr)) {
      selector += `[${attr}="${element.getAttribute(attr)}"]`;
    }
  });

  // Cek apakah selector sudah unik
  if (document.querySelectorAll(selector).length === 1) {
    return selector;
  }

  // Jika belum unik, tambahkan parent elements
  while (current.parentElement && index <= 3) {
    current = current.parentElement;
    const parentTag = current.tagName.toLowerCase();
    
    // Skip body/html
    if (['body', 'html'].includes(parentTag)) continue;

    // Tambahkan parent tag dan class yang meaningful
    let parentSelector = parentTag;
    if (current.className) {
      const parentClasses = current.className.split(' ')
        .filter(c => c && !c.match(/^[0-9]/) && !c.includes('__') && !c.includes('--') && c.length > 2);
      if (parentClasses.length > 0) {
        parentSelector += '.' + parentClasses.join('.');
      }
    }

    selector = `${parentSelector} > ${selector}`;
    if (document.querySelectorAll(selector).length === 1) {
      return selector;
    }

    index++;
  }

  return selector;
}

function getSpecificXPath(element) {
  const parts = [];
  let current = element;

  while (current && current.nodeType === Node.ELEMENT_NODE) {
    let selector = current.tagName.toLowerCase();
    
    // Tambahkan ID jika ada
    if (current.id) {
      selector += `[@id="${current.id}"]`;
      parts.unshift(selector);
      break;
    }

    // Tambahkan atribut penting
    const attributes = [];
    ['name', 'class', 'role', 'type', 'aria-label'].forEach(attr => {
      const value = current.getAttribute(attr);
      if (value) {
        attributes.push(`@${attr}="${value}"`);
      }
    });

    if (attributes.length > 0) {
      selector += `[${attributes.join(' and ')}]`;
    }

    // Tambahkan text content jika meaningful
    const text = current.textContent?.trim();
    if (text && text.length < 50) {
      selector += `[contains(text(),"${text}")]`;
    }

    // Tambahkan index jika perlu
    const siblings = current.parentNode ? Array.from(current.parentNode.children) : [];
    const similarSiblings = siblings.filter(sibling => 
      sibling.tagName === current.tagName
    );

    if (similarSiblings.length > 1) {
      const index = similarSiblings.indexOf(current) + 1;
      selector += `[${index}]`;
    }

    parts.unshift(selector);
    current = current.parentNode;
  }

  return `//${parts.join('/')}`;
}

// Helper function untuk mendapatkan unique key untuk element
function getUniqueElementKey(element) {
  return element.id || element.name || getXPath(element);
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
  // Abaikan elemen control panel dan elemen yang tidak visible
  if (element.closest('.recorder-controls') || !isElementVisible(element)) return;

    const text = element.textContent?.trim();
  if (!text) return;

  // Cek apakah ini dialog/modal yang baru muncul
  if (isDialog(element)) {
      recordAction('assert', element, {
        command: 'assertVisible',
        value: text,
      type: 'dialog'
    });
    return;
  }

  // Cek pesan error/warning yang penting
  if (isImportantMessage(element)) {
    // Tunggu sebentar untuk memastikan pesan stabil
    setTimeout(() => {
      if (isElementVisible(element) && element.textContent?.trim() === text) {
        recordAction('assert', element, {
          command: 'assertVisible',
          value: text,
          type: isErrorMessage(text) ? 'error' : 
                isWarningMessage(text) ? 'warning' : 'info'
        });
      }
    }, 500);
  }
}

// Fungsi untuk mengecek apakah elemen adalah dialog/modal
function isDialog(element) {
  // Cek role dialog/alertdialog
  if (element.getAttribute('role') === 'dialog' || 
      element.getAttribute('role') === 'alertdialog') {
    return true;
  }

  // Cek class yang umum untuk modal/dialog
  const dialogClasses = [
    'modal', 'dialog', 'popup', 'overlay',
    'lightbox', 'drawer', 'popover'
  ];

  const hasDialogClass = dialogClasses.some(className => {
    const elementClasses = element.className.toLowerCase();
    return elementClasses.includes(className) &&
           !elementClasses.includes('wrapper') &&
           !elementClasses.includes('container');
  });

  if (hasDialogClass) return true;

  // Cek aria attributes
  if (element.getAttribute('aria-modal') === 'true') return true;

  return false;
}

// Fungsi untuk mengecek apakah ini pesan penting
function isImportantMessage(element) {
  // Cek role yang relevan
  const importantRoles = [
    'alert', 'status', 'alertdialog', 'log', 'banner',
    'marquee', 'timer', 'tooltip', 'status', 'note'
  ];
  if (importantRoles.includes(element.getAttribute('role'))) {
    return true;
  }

  // Cek class yang mengindikasikan pesan penting
  const importantClasses = [
    // Alert & Messages
    'alert', 'error', 'warning', 'notification', 'toast',
    'snackbar', 'message', 'info', 'notice', 'flash',
    
    // Bootstrap classes
    'alert-danger', 'alert-warning', 'alert-info', 'alert-success',
    'text-danger', 'text-warning', 'text-info', 'text-success',
    'invalid-feedback', 'valid-feedback', 'form-text',
    
    // Material UI classes
    'MuiAlert', 'MuiSnackbar', 'MuiTooltip',
    
    // Common framework classes
    'ant-message', 'ant-notification', 'ant-alert',
    'el-message', 'el-notification', 'el-alert',
    'toast-error', 'toast-warning', 'toast-info', 'toast-success',
    
    // Common utility classes
    'error-text', 'warning-text', 'info-text', 'success-text',
    'error-message', 'warning-message', 'info-message', 'success-message',
    'validation-message', 'help-text', 'hint-text', 'helper-text'
  ];

  const hasImportantClass = importantClasses.some(className => {
    const elementClasses = element.className.toLowerCase();
    return elementClasses.includes(className.toLowerCase()) &&
           !elementClasses.includes('wrapper') &&
           !elementClasses.includes('container');
  });

  // Cek tag dan atribut spesifik
  const isImportantTag = [
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'STRONG', 'EM', 'B', 'I', 'MARK',
    'SMALL', 'DEL', 'INS', 'SUB', 'SUP'
  ].includes(element.tagName);

  // Cek aria attributes
  const hasAriaAttr = [
    'aria-label', 'aria-description', 'aria-details',
    'aria-errormessage', 'aria-invalid', 'aria-required'
  ].some(attr => element.hasAttribute(attr));

  // Cek data attributes
  const hasDataAttr = [
    'data-error', 'data-test', 'data-warning', 'data-info', 'data-message',
    'data-tooltip', 'data-hint', 'data-validation'
  ].some(attr => element.hasAttribute(attr));

  if (hasImportantClass || hasAriaAttr || hasDataAttr) {
    return true;
  }

  // Cek parent elements (maksimal 3 level)
  let parent = element.parentElement;
  let level = 0;
  while (parent && level < 3) {
    if (importantRoles.includes(parent.getAttribute('role')) ||
        importantClasses.some(c => parent.className.toLowerCase().includes(c.toLowerCase())) ||
        hasImportantParentTag(parent)) {
      return true;
    }
    parent = parent.parentElement;
    level++;
  }

  // Jika ini heading dan mengandung keyword penting
  if (isImportantTag && hasImportantText(element.textContent)) {
    return true;
  }

  return false;
}

function hasImportantParentTag(element) {
  const importantTags = [
    'ASIDE', 'ARTICLE', 'SECTION', 'NAV',
    'HEADER', 'FOOTER', 'MAIN', 'DIALOG',
    'DETAILS', 'SUMMARY', 'FIGURE', 'FIGCAPTION'
  ];
  return importantTags.includes(element.tagName);
}

function hasImportantText(text) {
  if (!text) return false;
  
  const importantKeywords = [
    // Error keywords
    'error', 'invalid', 'failed', 'incorrect', 'wrong',
    'gagal', 'salah', 'tidak valid', 'tidak benar',
    'required', 'wajib', 'harus', 'tidak ditemukan',
    'tidak tersedia', 'tidak sesuai', 'tidak boleh kosong',
    'denied', 'rejected', 'unauthorized', 'forbidden',
    
    // Warning keywords
    'warning', 'peringatan', 'caution', 'attention',
    'perhatian', 'careful', 'hati-hati',
    
    // Info keywords
    'important', 'penting', 'note', 'catatan',
    'please', 'harap', 'mohon', 'silakan',
    'must', 'should', 'need to', 'perlu',
    
    // Success keywords
    'success', 'successful', 'succeeded', 'berhasil',
    'saved', 'tersimpan', 'completed', 'selesai',
    'updated', 'diperbarui', 'created', 'dibuat'
  ];

  return importantKeywords.some(keyword => 
    text.toLowerCase().includes(keyword.toLowerCase())
  );
}

// Fungsi untuk mengecek warning message
function isWarningMessage(text) {
  const warningKeywords = [
    'warning', 'peringatan', 'caution', 'attention',
    'perhatian', 'warning', 'careful', 'hati-hati'
  ];
  
  return warningKeywords.some(keyword => 
    text.toLowerCase().includes(keyword.toLowerCase())
  );
}

// Fungsi untuk mengecek pesan info penting
function isImportantInfoMessage(text) {
  const infoKeywords = [
    'important', 'penting', 'note', 'catatan',
    'please', 'harap', 'mohon', 'silakan',
    'must', 'harus', 'wajib'
  ];
  
  return infoKeywords.some(keyword => 
    text.toLowerCase().includes(keyword.toLowerCase())
  );
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

// Tambah fungsi untuk mengecek success message
function isSuccessMessage(text) {
  const successKeywords = [
    'success', 'successful', 'succeeded', 'berhasil',
    'saved', 'tersimpan', 'completed', 'selesai',
    'updated', 'diperbarui', 'created', 'dibuat'
  ];
  
  return successKeywords.some(keyword => 
    text.toLowerCase().includes(keyword.toLowerCase())
  );
}

// Update fungsi isMessageElement untuk lebih selektif
function isMessageElement(element) {
  // Cek apakah elemen memiliki role yang relevan
  const messageRoles = ['alert', 'status', 'log'];
  if (messageRoles.includes(element.getAttribute('role'))) {
    return true;
  }

  // Cek class yang spesifik untuk pesan
  const messageClasses = [
    'alert', 'message', 'notification', 'toast',
    'error', 'success', 'warning', 'info'
  ];

  const hasMessageClass = messageClasses.some(className => {
    const elementClasses = element.className.toLowerCase();
    return elementClasses.includes(className.toLowerCase()) &&
           !elementClasses.includes('wrapper') && // Hindari wrapper elements
           !elementClasses.includes('container');
  });

  if (hasMessageClass) {
    return true;
  }

  // Cek aria attributes
  if (element.hasAttribute('aria-live')) {
    return true;
  }

  // Cek parent elements (maksimal 2 level)
  let parent = element.parentElement;
  let level = 0;
  while (parent && level < 2) {
    if (messageRoles.includes(parent.getAttribute('role')) ||
        messageClasses.some(c => parent.className.toLowerCase().includes(c.toLowerCase()))) {
      return true;
    }
    parent = parent.parentElement;
    level++;
  }

  return false;
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

// Tambah handler untuk right click
function handleRightClick(e) {
  if (!isRecording) return;
  
  e.preventDefault(); // Prevent default context menu
  const element = e.target;
  
  // Abaikan klik pada control panel dan overlay
  if (element.closest('.recorder-controls') || 
      element.classList.contains('recorder-hover-overlay') ||
      element.classList.contains('recorder-tooltip')) return;

  // Tampilkan menu assertion
  showAssertionMenu(e.clientX, e.clientY, element);
}

// Fungsi untuk menampilkan menu assertion
function showAssertionMenu(x, y, element) {
  // Hapus menu yang mungkin sudah ada
  removeAssertionMenu();
  
  const menu = document.createElement('div');
  menu.className = 'recorder-assertion-menu';
  menu.innerHTML = `
    <div class="menu-item" data-type="error">Assert as Error Message</div>
    <div class="menu-item" data-type="warning">Assert as Warning Message</div>
    <div class="menu-item" data-type="info">Assert as Info Message</div>
  `;
  
  // Posisikan menu
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  
  // Event listeners untuk menu items
  menu.addEventListener('click', (e) => {
    const menuItem = e.target;
    if (menuItem.classList.contains('menu-item')) {
      const type = menuItem.dataset.type;
      recordAction('assert', element, {
        command: 'assertVisible',
        value: element.textContent.trim(),
        type: type
      });
      removeAssertionMenu();
    }
  });
  
  // Close menu when clicking outside
  document.addEventListener('click', removeAssertionMenu, { once: true });
  
  document.body.appendChild(menu);
}

function removeAssertionMenu() {
  const menu = document.querySelector('.recorder-assertion-menu');
  if (menu) menu.remove();
}
