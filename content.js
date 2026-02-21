// ISOLATED world content script
// Cầu nối: popup/background <-> inject.js (MAIN world) qua postMessage

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'GENERATE_LINK') return;

  const requestId = msg.requestId || ('afl_' + Date.now());
  console.log('[AFL] Forwarding to MAIN world:', msg.itemId, 'reqId:', requestId);
  console.log('[AFL] Security headers from BG:', Object.keys(msg.securityHeaders || {}));

  // Lắng nghe kết quả từ inject.js
  const handler = (event) => {
    if (event.data?.type === 'AFL_RESULT' && event.data?.requestId === requestId) {
      window.removeEventListener('message', handler);
      console.log('[AFL] Got result:', event.data.result);
      sendResponse(event.data.result);
    }
  };
  window.addEventListener('message', handler);

  // Timeout 15s
  setTimeout(() => {
    window.removeEventListener('message', handler);
    sendResponse({ success: false, error: 'Timeout 15s' });
  }, 15000);

  // Gửi task đến inject.js (MAIN world) qua postMessage — include security headers
  window.postMessage({
    type: 'AFL_TASK',
    requestId,
    itemId: msg.itemId,
    shopId: msg.shopId,
    securityHeaders: msg.securityHeaders || {}
  }, '*');

  return true; // giữ sendResponse async
});

// Listen for WAKE_UP_POLLING from the React dashboard
window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || typeof event.data !== 'object') return;

  if (event.data.type === 'WAKE_UP_POLLING') {
    console.log('[AFL] WAKE_UP_POLLING received from page, forwarding to background');
    chrome.runtime.sendMessage({ type: 'WAKE_UP_POLLING' }).catch(err => {
      console.warn('[AFL] Could not wake up background worker:', err);
    });
  }
});

console.log('[AFL] Content script (ISOLATED) loaded ✅');
