// ─── DOM Elements ───
const toggleSwitch = document.getElementById('toggleSwitch');
const toggleText = document.getElementById('toggleText');
const serverStatus = document.getElementById('serverStatus');
const tabStatus = document.getElementById('tabStatus');

// ─── Init: Load saved state ───
chrome.storage.local.get(['extensionEnabled'], (result) => {
  const enabled = result.extensionEnabled !== false; // default: true
  toggleSwitch.checked = enabled;
  updateToggleUI(enabled);
});

// ─── Toggle handler ───
toggleSwitch.addEventListener('change', () => {
  const enabled = toggleSwitch.checked;
  chrome.storage.local.set({ extensionEnabled: enabled });
  updateToggleUI(enabled);

  // Notify background script
  chrome.runtime.sendMessage({ type: 'TOGGLE_EXTENSION', enabled });
});

function updateToggleUI(enabled) {
  toggleText.textContent = enabled ? 'Extension đang bật' : 'Extension đã tắt';
  toggleText.style.color = enabled ? '#e0e0e0' : '#666';
}

// ─── Check Server Status ───
async function checkServer() {
  try {
    const res = await fetch(CONFIG.SERVER_URL + '/api/extension/stream', {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok || res.status === 200) {
      serverStatus.textContent = 'Đã kết nối';
      serverStatus.className = 'value online';
    } else {
      serverStatus.textContent = 'Lỗi ' + res.status;
      serverStatus.className = 'value offline';
    }
  } catch (e) {
    serverStatus.textContent = 'Không kết nối';
    serverStatus.className = 'value offline';
  }
}

// ─── Check Shopee Tab ───
async function checkShopeeTab() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://affiliate.shopee.vn/*' });
    if (tabs.length > 0) {
      tabStatus.textContent = 'Đã mở (' + tabs.length + ')';
      tabStatus.className = 'value online';
    } else {
      tabStatus.textContent = 'Chưa mở';
      tabStatus.className = 'value offline';
    }
  } catch (e) {
    tabStatus.textContent = 'Lỗi';
    tabStatus.className = 'value offline';
  }
}

// ─── Run checks ───
checkServer();
checkShopeeTab();
