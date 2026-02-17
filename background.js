importScripts('config.js');

// ─── Keep-Alive ───
chrome.alarms.create('keepAlive', { periodInMinutes: 0.25 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    chrome.runtime.getPlatformInfo(() => { });
  }
});

// Map requestId → pending request context
const pendingRequests = new Map();
let pollTimer = null;

// ─── Helpers ───
function remoteLog(msg, level = 'INFO') {
  console.log(`[BG-LIVE][${level}] ${msg}`);
  fetch(CONFIG.SERVER_URL + '/api/extension/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: msg, level, sender: 'Background-Live' })
  }).catch(() => { });
}

function generateSubId() {
  return Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10);
}

// ─── Toggle handler from popup ───
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'TOGGLE_EXTENSION') {
    remoteLog(`Extension toggled: ${msg.enabled ? 'ON' : 'OFF'}`);
  }
});

// ─── Polling for pending tasks (Vercel-compatible, replaces SSE) ───
async function pollForTasks() {
  try {
    const res = await fetch(CONFIG.SERVER_URL + '/api/extension/pending-tasks', {
      headers: { 'Accept': 'application/json' }
    });

    if (!res.ok) return;

    const { tasks } = await res.json();
    if (tasks && tasks.length > 0) {
      console.log(`[BG-LIVE] Got ${tasks.length} pending task(s)`);
      for (const task of tasks) {
        if (task.type === 'generate_link' && task.itemId) {
          handleGenerateLink(task);
        }
      }
    }
  } catch (err) {
    // Silent fail — will retry on next poll
    console.log('[BG-LIVE] Poll error (will retry):', err.message);
  }
}

function startPolling() {
  if (pollTimer) return;
  console.log('[BG-LIVE] Starting polling (every 2s)...');
  remoteLog('Extension Live started polling.');

  // Initial poll
  pollForTasks();

  // Poll every 2 seconds
  pollTimer = setInterval(pollForTasks, 2000);
}

// ─── Find or open affiliate.shopee.vn tab ───
async function getAffiliateTab() {
  const tabs = await chrome.tabs.query({ url: 'https://affiliate.shopee.vn/*' });
  if (tabs.length > 0) {
    return tabs[0];
  }
  // Open a new tab
  remoteLog('No affiliate tab found. Opening one...');
  const newTab = await chrome.tabs.create({
    url: 'https://affiliate.shopee.vn/offer/custom_link',
    active: false
  });

  // Wait for the page to load
  await new Promise((resolve) => {
    const listener = (tabId, info) => {
      if (tabId === newTab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);
  });

  // Small extra delay for content scripts to inject
  await new Promise(r => setTimeout(r, 2000));
  return newTab;
}

// ─── Core: Handle generate_link from server ───
async function handleGenerateLink(data) {
  // Check if extension is enabled
  const { extensionEnabled } = await chrome.storage.local.get(['extensionEnabled']);
  if (extensionEnabled === false) {
    remoteLog('Extension is disabled. Skipping generate_link.');
    return;
  }

  const { itemId, shopId, requestId, userId, originalUrl } = data;
  remoteLog(`Processing: itemId=${itemId}, shopId=${shopId}, reqId=${requestId}`);

  try {
    const tab = await getAffiliateTab();
    if (!tab || !tab.id) {
      remoteLog('Failed to get affiliate tab', 'ERROR');
      return;
    }

    const subId = generateSubId();
    pendingRequests.set(requestId, { requestId, userId, originalUrl, subId, tabId: tab.id });

    remoteLog(`Sending GENERATE_LINK to tab ${tab.id}...`);

    // Send message to content.js
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'GENERATE_LINK',
        itemId: String(itemId),
        shopId: shopId || 0,
        requestId
      });

      remoteLog(`Content script response: ${JSON.stringify(response)}`);

      if (response && response.success) {
        const ctx = pendingRequests.get(requestId);
        if (ctx) {
          sendResultToServer({
            link: response.data,
            productData: response.productData || null,
            requestId: ctx.requestId,
            subId: ctx.subId,
            originalUrl: ctx.originalUrl,
            userId: ctx.userId
          });
        }
      } else {
        remoteLog(`Generation failed: ${response?.error || 'Unknown'}`, 'ERROR');
      }
    } catch (msgErr) {
      remoteLog(`Tab message error: ${msgErr.message}. Retrying...`, 'ERROR');

      // Try reloading the tab and retrying once
      await chrome.tabs.reload(tab.id);
      await new Promise(r => setTimeout(r, 3000));

      try {
        const retryResponse = await chrome.tabs.sendMessage(tab.id, {
          type: 'GENERATE_LINK',
          itemId: String(itemId),
          shopId: shopId || 0,
          requestId
        });

        if (retryResponse && retryResponse.success) {
          const ctx = pendingRequests.get(requestId);
          if (ctx) {
            sendResultToServer({
              link: retryResponse.data,
              productData: retryResponse.productData || null,
              requestId: ctx.requestId,
              subId: ctx.subId,
              originalUrl: ctx.originalUrl,
              userId: ctx.userId
            });
          }
        } else {
          remoteLog(`Retry also failed: ${retryResponse?.error || 'Unknown'}`, 'ERROR');
        }
      } catch (retryErr) {
        remoteLog(`Retry failed: ${retryErr.message}`, 'ERROR');
      }
    }

    pendingRequests.delete(requestId);
  } catch (err) {
    remoteLog(`handleGenerateLink error: ${err.message}`, 'ERROR');
    pendingRequests.delete(requestId);
  }
}

// ─── Send result back to server ───
function sendResultToServer({ link, productData, requestId, subId, originalUrl, userId }) {
  remoteLog(`Sending result to server: ${link}`);
  if (productData) remoteLog(`Product: ${productData.name}`);

  fetch(CONFIG.SERVER_URL + '/api/extension/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      link,
      data: productData,
      requestId,
      subId,
      originalUrl,
      userId
    })
  })
    .then(res => res.json())
    .then(() => remoteLog('Result sent to server successfully.'))
    .catch(err => remoteLog(`Failed to send result: ${err}`, 'ERROR'));
}

// ─── Start ───
console.log('[BG-LIVE] Service Worker starting...');
startPolling();
remoteLog('Extension Live Background started (polling mode).');
