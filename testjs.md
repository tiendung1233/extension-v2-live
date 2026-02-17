async function getShopeeAffiliateProduct(itemId) {
  const url = `https://affiliate.shopee.vn/api/v3/offer/product?item_id=${itemId}`;

  const response = await fetch(url, {
    method: "GET",
    credentials: "include", // bắt buộc để gửi cookie đăng nhập
    headers: {
      "accept": "application/json, text/plain, */*",
      "affiliate-program-type": "1",
      "af-ac-enc-dat": "2b562e1d3bed3b38",
      "af-ac-enc-sz-token": "+DNTPi2bGUJbt+EKwtYIaA==|nXQ90C0ye0xcqhQPwzl883KnF4Xb15pwITnYd6RcL2cziMmyGyFkqEwHbBXidcH9Heajz7jXqQyKE6cj5lXi|j9TomHMdXRrQcwdh|08|3",
      "csrf-token": "FQMaVCRh-e6wBZ4EqzJhjgyZinLn1wktgZ_g"
    }
  });

  if (!response.ok) {
    throw new Error("Request failed: " + response.status);
  }

  const data = await response.json();
  return data;
}

// sử dụng
getShopeeAffiliateProduct("25807921512")
  .then(data => console.log("Product data:", data))
  .catch(err => console.error(err));