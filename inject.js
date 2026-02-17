// MAIN world script — chạy trong context của trang affiliate.shopee.vn
// fetch() ở đây dùng phiên bản đã được SDK patch (giống F12 console)

// ─── Helper: Format price từ Shopee (chia 100000) ───
function formatPrice(rawPrice) {
  if (!rawPrice) return '';
  const price = parseInt(rawPrice) / 100000;
  return price.toLocaleString('vi-VN') + '₫';
}

// ─── Helper: Format image URL ───
function formatImageUrl(imageId) {
  if (!imageId) return '';
  return `https://down-bs-vn.img.susercontent.com/${imageId}.webp`;
}

// ─── Fetch product data từ affiliate API ───
async function getProductData(itemId) {
  try {
    const res = await fetch(`/api/v3/offer/product?item_id=${itemId}`, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'affiliate-program-type': '1'
      }
    });

    if (!res.ok) {
      console.log('[AFL-MAIN] Product API returned:', res.status);
      return null;
    }

    const json = await res.json();

    if (json.code !== 0 || !json.data) {
      console.log('[AFL-MAIN] Product API error:', json.msg);
      return null;
    }

    const item = json.data.batch_item_for_item_card_full;
    if (!item) return null;

    return {
      name: item.name || '',
      image: formatImageUrl(item.image),
      price: formatPrice(item.price_min || item.price),
      sold: item.historical_sold_text || item.sold_text || '',
      cashback: json.data.commission || '',
    };
  } catch (e) {
    console.error('[AFL-MAIN] Product data fetch error:', e);
    return null;
  }
}

// ─── Main listener ───
window.addEventListener('message', async (event) => {
  if (event.data?.type !== 'AFL_TASK') return;

  const { requestId, itemId, shopId } = event.data;
  console.log('[AFL-MAIN] Processing:', itemId, shopId);

  try {
    // Gọi song song: tạo link + lấy data sản phẩm
    const [linkResult, productData] = await Promise.all([
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
            advancedLinkParams: { subId1: "", subId2: "", subId3: "", subId4: "", subId5: "" }
          }
        })
      }).then(r => r.json()),

      // 2. Lấy thông tin sản phẩm
      getProductData(itemId)
    ]);

    console.log('[AFL-MAIN] Link response:', linkResult);
    console.log('[AFL-MAIN] Product data:', productData);

    if (linkResult.data?.productOfferLinks?.length > 0) {
      window.postMessage({
        type: 'AFL_RESULT',
        requestId,
        result: {
          success: true,
          data: linkResult.data.productOfferLinks[0].productOfferLink,
          productData: productData
        }
      }, '*');
    } else {
      window.postMessage({
        type: 'AFL_RESULT',
        requestId,
        result: { success: false, error: 'Shopee error: ' + JSON.stringify(linkResult) }
      }, '*');
    }
  } catch (e) {
    window.postMessage({
      type: 'AFL_RESULT',
      requestId,
      result: { success: false, error: e.message }
    }, '*');
  }
});

console.log('[AFL-MAIN] Inject script loaded ✅');
