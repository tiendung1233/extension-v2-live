importScripts('config.js');

// ─── Alarms: Keep-Alive + Polling ───
chrome.alarms.create('keepAlive', { periodInMinutes: 0.25 });
chrome.alarms.create('pollTasks', { periodInMinutes: 0.1 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    chrome.runtime.getPlatformInfo(() => { });
  } else if (alarm.name === 'pollTasks') {
    pollForTasks();
  }
});

// Map requestId → pending request context
const pendingRequests = new Map();

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
  console.log('[BG-LIVE] Polling via chrome.alarms (every ~6s)...');
  remoteLog('Extension Live started polling (alarm-based).');
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
