importScripts('config.js');

// ─── Alarms: Keep-Alive + Polling (Fallback only) ───
chrome.alarms.create('keepAlive', { periodInMinutes: 0.25 });
chrome.alarms.create('pollTasks', { periodInMinutes: 1.0 }); // Giảm polling xuống 1 phút vì đã dùng SSE

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    chrome.runtime.getPlatformInfo(() => { });
    ensureSseConnection(); // Giữ kết nối SSE khi keep-alive chạy
  } else if (alarm.name === 'pollTasks') {
    pollForTasks();
  }
});

// Map requestId → pending request context
const pendingRequests = new Map();

// ─── Server-Sent Events (Real-time) ───
let sseConnection = null;
let reconnectTimeout = null;
let watchdogInterval = null;
let lastSseMessageTime = 0;
const processedTasks = new Set(); // Stores requestId to prevent duplicate processing

function ensureSseConnection() {
  if (sseConnection && sseConnection.readyState !== EventSource.CLOSED) return;

  chrome.storage.local.get(['extensionEnabled']).then(({ extensionEnabled }) => {
    if (extensionEnabled === false) return; // Nếu bị tắt thì không tạo kết nối stream

    remoteLog('Connecting to Server-Sent Events stream...');
    sseConnection = new EventSource(CONFIG.SERVER_URL + '/api/extension/stream');

    sseConnection.onopen = () => {
      remoteLog('SSE connection established.', 'INFO');
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      lastSseMessageTime = Date.now(); // Reset watchdog timer on open
      startWatchdog();
      // Immediately poll in case tasks were missed during downtime
      pollForTasks();
    };

    sseConnection.onmessage = (event) => {
      try {
        lastSseMessageTime = Date.now(); // Update watchdog explicitly
        const data = JSON.parse(event.data);
        if (data.type === 'ping') return; // Heartbeat

        if (data.type === 'generate_link' && data.itemId) {
          remoteLog(`[SSE] Received target link generation task instantly!`);
          handleGenerateLink(data);
        }
      } catch (err) {
        // Ignore parse error
      }
    };

    sseConnection.onerror = (err) => {
      stopSseAndReconnect();
    };
  });
}

function stopSseAndReconnect() {
  if (sseConnection) {
    sseConnection.close();
    sseConnection = null;
  }
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
  }
  // Auto reconnect sau 5s nếu bị rớt kết nối
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  reconnectTimeout = setTimeout(ensureSseConnection, 5000);
}

function startWatchdog() {
  if (watchdogInterval) clearInterval(watchdogInterval);
  watchdogInterval = setInterval(() => {
    // Nếu quá 40s không nhận được data/ping từ server (server ping mỗi 15s)
    if (Date.now() - lastSseMessageTime > 40000) {
      remoteLog('[SSE Watchdog] Connection silently dropped (no messages for >40s). Reconnecting...', 'WARNING');
      stopSseAndReconnect();
    }
  }, 10000); // Check every 10s
}


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
  return 'ht24h' + Math.random().toString(36).substring(2, 10);
}

// ─── Toggle handler from popup ───
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'TOGGLE_EXTENSION') {
    remoteLog(`Extension toggled: ${msg.enabled ? 'ON' : 'OFF'}`);
    if (msg.enabled) {
      ensureSseConnection();
    } else {
      if (sseConnection) {
        sseConnection.close();
        sseConnection = null;
      }
      if (watchdogInterval) {
        clearInterval(watchdogInterval);
        watchdogInterval = null;
      }
    }
  }
});

// ─── Polling for pending tasks ───
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
    console.log('[BG-LIVE] Poll error (will retry):', err.message);
  }
}

function startPolling() {
  console.log('[BG-LIVE] Polling via chrome.alarms (fallback every 1m)...');
  remoteLog('Extension Live started (SSE + Fallback Polling).');
  ensureSseConnection();
  pollForTasks();
}

// ─── Find or open affiliate.shopee.vn tab ───
async function getAffiliateTab() {
  const tabs = await chrome.tabs.query({ url: 'https://affiliate.shopee.vn/*' });
  if (tabs.length > 0) {
    return tabs[0];
  }
  remoteLog('No affiliate tab found. Opening one...');
  const newTab = await chrome.tabs.create({
    url: 'https://affiliate.shopee.vn/offer/custom_link',
    active: false
  });

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

  await new Promise(r => setTimeout(r, 3000));
  return newTab;
}

// ─── Execute fetch in page context (like F12 console) ───
async function executeInPage(tabId, itemId, shopId, subId, originalUrl, isShopeeFood) {
  // Chạy code TRỰC TIẾP trong page context — giống hệt gõ trong F12 console
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (itemId, shopId, subId, originalUrl, isShopeeFood) => {
      try {
        if (isShopeeFood) {
          // ─── SHOPEE FOOD LOGIC ───
          const linkRes = await fetch('https://affiliate.shopee.vn/api/v3/gql?q=batchCustomLink', {
            method: 'POST',
            headers: {
              'content-type': 'application/json; charset=UTF-8',
              'affiliate-program-type': '1'
            },
            credentials: 'include',
            body: JSON.stringify({
              operationName: "batchGetCustomLink",
              query: "\n    query batchGetCustomLink($linkParams: [CustomLinkParam!], $sourceCaller: SourceCaller){\n      batchCustomLink(linkParams: $linkParams, sourceCaller: $sourceCaller){\n        shortLink\n        longLink\n        failCode\n      }\n    }\n    ",
              variables: {
                linkParams: [{
                  originalLink: originalUrl,
                  advancedLinkParams: {
                    subId1: subId
                  }
                }],
                sourceCaller: "CUSTOM_LINK_CALLER"
              }
            })
          }).then(r => r.json());

          if (linkRes?.data?.batchCustomLink?.[0]?.shortLink) {
            return {
              success: true,
              data: linkRes.data.batchCustomLink[0].shortLink,
              productData: null
            };
          } else {
            return { success: false, error: 'Shopee Food error: ' + JSON.stringify(linkRes) };
          }
        } else {
          // ─── NORMAL SHOPEE LOGIC ───
          // Helper format
          const formatPrice = (p) => {
            if (!p) return '';
            return (parseInt(p) / 100000).toLocaleString('vi-VN') + '₫';
          };
          const formatImage = (id) => id ? `https://down-bs-vn.img.susercontent.com/${id}.webp` : '';

          // Gọi song song: tạo link + lấy data sản phẩm
          const [linkRes, productRes] = await Promise.all([
            // 1. Tạo affiliate link
            fetch('/api/v3/gql?q=productOfferLinks', {
              method: 'POST',
              headers: {
                'content-type': 'application/json; charset=UTF-8',
                'affiliate-program-type': '1'
              },
              credentials: 'include',
              body: JSON.stringify({
                operationName: "batchGetProductOfferLink",
                query: 'query batchGetProductOfferLink($sourceCaller:SourceCaller!,$productOfferLinkParams:[ProductOfferLinkParam!]!,$advancedLinkParams:AdvancedLinkParams){productOfferLinks(productOfferLinkParams:$productOfferLinkParams,sourceCaller:$sourceCaller,advancedLinkParams:$advancedLinkParams){itemId shopId productOfferLink}}',
                variables: {
                  sourceCaller: "WEB_SITE_CALLER",
                  productOfferLinkParams: [{
                    itemId: String(itemId),
                    shopId: shopId || 0,
                    trace: '{"trace_id":"0.ext.100","list_type":100}'
                  }],
                  advancedLinkParams: { subId1: subId, subId2: "", subId3: "", subId4: "", subId5: "" }
                }
              })
            }).then(r => r.json()),

            // 2. Lấy thông tin sản phẩm  
            fetch(`/api/v3/offer/product?item_id=${itemId}`, {
              method: 'GET',
              credentials: 'include',
              headers: {
                'accept': 'application/json, text/plain, */*',
                'affiliate-program-type': '1'
              }
            }).then(r => r.json()).catch(() => null)
          ]);

          // Parse product data
          let productData = null;
          if (productRes && productRes.code === 0 && productRes.data) {
            const item = productRes.data.batch_item_for_item_card_full;
            if (item) {
              productData = {
                name: item.name || '',
                image: formatImage(item.image),
                price: formatPrice(item.price_min || item.price),
                sold: item.historical_sold_text || item.sold_text || '',
                cashback: productRes.data.commission || '',
              };
            }
          }

          // Parse link
          if (linkRes.data?.productOfferLinks?.length > 0) {
            return {
              success: true,
              data: linkRes.data.productOfferLinks[0].productOfferLink,
              productData
            };
          } else {
            return { success: false, error: 'Shopee error: ' + JSON.stringify(linkRes) };
          }
        }
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
    args: [itemId, shopId, subId, originalUrl, isShopeeFood]
  });

  return results?.[0]?.result || { success: false, error: 'executeScript failed' };
}

// ─── Core: Handle generate_link from server ───
async function handleGenerateLink(data) {
  const { extensionEnabled } = await chrome.storage.local.get(['extensionEnabled']);
  if (extensionEnabled === false) {
    remoteLog('Extension is disabled. Skipping.');
    return;
  }

  const { itemId, shopId, requestId, userId, originalUrl } = data;

  // Deduplication check
  if (processedTasks.has(requestId)) {
    remoteLog(`Task ${requestId} already processed. Skipping duplicate.`);
    return;
  }
  processedTasks.add(requestId);

  // Keep max 100 requests in memory to avoid memory leak
  if (processedTasks.size > 100) {
    const iterator = processedTasks.values();
    const firstOut = iterator.next().value;
    processedTasks.delete(firstOut);
  }

  remoteLog(`Processing: itemId=${itemId}, shopId=${shopId}, reqId=${requestId}`);

  try {
    const tab = await getAffiliateTab();
    if (!tab || !tab.id) {
      remoteLog('Failed to get affiliate tab', 'ERROR');
      return;
    }

    const subId = generateSubId();
    remoteLog(`Executing in page context (tab ${tab.id})...`);

    const isShopeeFood = originalUrl && (originalUrl.includes('shopeefood') || originalUrl.includes('spf.shopee.vn'));

    // Chạy fetch TRỰC TIẾP trong page — giống F12 console
    const response = await executeInPage(tab.id, itemId, shopId, subId, originalUrl, isShopeeFood);
    remoteLog(`Result: ${JSON.stringify(response).substring(0, 200)}`);

    if (response && response.success) {
      sendResultToServer({
        link: response.data,
        productData: response.productData || null,
        requestId,
        subId,
        originalUrl,
        userId
      });
    } else {
      remoteLog(`Generation failed: ${response?.error || 'Unknown'}`, 'ERROR');
    }
  } catch (err) {
    remoteLog(`handleGenerateLink error: ${err.message}`, 'ERROR');
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
remoteLog('Extension Live Background started (executeScript mode).');
