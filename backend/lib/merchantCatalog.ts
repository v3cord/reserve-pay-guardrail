import { CatalogProduct } from './types';

export const CURRENT_CATALOG_VERSION = '2026.09.v1';

export const CATALOG_PRODUCTS: Record<string, CatalogProduct> = {
  'swiggy-dinner-650': {
    id: 'swiggy-dinner-650',
    productId: 'swiggy-dinner-650',
    name: 'Dinner for 2 (Swiggy)',
    merchantId: 'mer_swiggy_01',
    merchantName: 'Swiggy',
    merchant: 'Swiggy',
    mcc: '5812',
    category: 'Food & Dining',
    unitPricePaise: 65000,
    pricePaise: 65000,
    currency: 'INR',
    catalogVersion: CURRENT_CATALOG_VERSION,
  },
  'dinner-two-650': {
    id: 'dinner-two-650',
    productId: 'dinner-two-650',
    name: 'Dinner for 2',
    merchantId: 'mer_swiggy_01',
    merchantName: 'Swiggy',
    merchant: 'Swiggy',
    mcc: '5812',
    category: 'Food & Dining',
    unitPricePaise: 65000,
    pricePaise: 65000,
    currency: 'INR',
    catalogVersion: CURRENT_CATALOG_VERSION,
  },
  'swiggy-instamart-groceries-350': {
    id: 'swiggy-instamart-groceries-350',
    productId: 'swiggy-instamart-groceries-350',
    name: 'Daily Groceries Basket',
    merchantId: 'mer_swiggy_instamart_01',
    merchantName: 'Swiggy Instamart',
    merchant: 'Swiggy Instamart',
    mcc: '5411',
    category: 'Groceries',
    unitPricePaise: 35000,
    pricePaise: 35000,
    currency: 'INR',
    catalogVersion: CURRENT_CATALOG_VERSION,
  },
  'amazon-fresh-groceries-500': {
    id: 'amazon-fresh-groceries-500',
    productId: 'amazon-fresh-groceries-500',
    name: 'Amazon Fresh Organic Basket',
    merchantId: 'mer_amazon_fresh_01',
    merchantName: 'Amazon Fresh',
    merchant: 'Amazon Fresh',
    mcc: '5411',
    category: 'Groceries',
    unitPricePaise: 50000,
    pricePaise: 50000,
    currency: 'INR',
    catalogVersion: CURRENT_CATALOG_VERSION,
  },
  'amazon-electronics-2500': {
    id: 'amazon-electronics-2500',
    productId: 'amazon-electronics-2500',
    name: 'Wireless Noise Cancelling Headphones',
    merchantId: 'mer_amazon_01',
    merchantName: 'Amazon',
    merchant: 'Amazon',
    mcc: '5732',
    category: 'Electronics',
    unitPricePaise: 250000,
    pricePaise: 250000,
    currency: 'INR',
    catalogVersion: CURRENT_CATALOG_VERSION,
  },
  'bestbuy-gadget-1200': {
    id: 'bestbuy-gadget-1200',
    productId: 'bestbuy-gadget-1200',
    name: 'Smart Home Hub',
    merchantId: 'mer_bestbuy_01',
    merchantName: 'BestBuy',
    merchant: 'BestBuy',
    mcc: '5732',
    category: 'Electronics',
    unitPricePaise: 120000,
    pricePaise: 120000,
    currency: 'INR',
    catalogVersion: CURRENT_CATALOG_VERSION,
  },
  'uber-ride-450': {
    id: 'uber-ride-450',
    productId: 'uber-ride-450',
    name: 'Airport Premier Ride',
    merchantId: 'mer_uber_01',
    merchantName: 'Uber',
    merchant: 'Uber',
    mcc: '4121',
    category: 'Travel',
    unitPricePaise: 45000,
    pricePaise: 45000,
    currency: 'INR',
    catalogVersion: CURRENT_CATALOG_VERSION,
  },
  'zara-shirt-1800': {
    id: 'zara-shirt-1800',
    productId: 'zara-shirt-1800',
    name: 'Classic Linen Shirt',
    merchantId: 'mer_zara_01',
    merchantName: 'Zara',
    merchant: 'Zara',
    mcc: '5651',
    category: 'Clothing',
    unitPricePaise: 180000,
    pricePaise: 180000,
    currency: 'INR',
    catalogVersion: CURRENT_CATALOG_VERSION,
  },
  'expensive-dinner-1400': {
    id: 'expensive-dinner-1400',
    productId: 'expensive-dinner-1400',
    name: '5-Course Gourmet Tasting Menu',
    merchantId: 'mer_gourmet_01',
    merchantName: 'Gourmet Bistro',
    merchant: 'Gourmet Bistro',
    mcc: '5812',
    category: 'Food & Dining',
    unitPricePaise: 140000,
    pricePaise: 140000,
    currency: 'INR',
    catalogVersion: CURRENT_CATALOG_VERSION,
  },
  'unapproved-merchant-item': {
    id: 'unapproved-merchant-item',
    productId: 'unapproved-merchant-item',
    name: 'Forbidden Virtual Chips',
    merchantId: 'mer_unapproved_99',
    merchantName: 'DarkWebGoods',
    merchant: 'DarkWebGoods',
    mcc: '7995',
    category: 'Gambling',
    unitPricePaise: 50000,
    pricePaise: 50000,
    currency: 'INR',
    catalogVersion: CURRENT_CATALOG_VERSION,
  },
  'amazon-headphones-5000': {
    id: 'amazon-headphones-5000',
    productId: 'amazon-headphones-5000',
    name: 'Studio Monitor Pro Headphones',
    merchantId: 'mer_amazon_01',
    merchantName: 'Amazon',
    merchant: 'Amazon',
    mcc: '5732',
    category: 'Electronics',
    unitPricePaise: 500000,
    pricePaise: 500000,
    currency: 'INR',
    catalogVersion: CURRENT_CATALOG_VERSION,
  },
};

export function resolveCatalogProduct(productId: string): CatalogProduct | null {
  if (!productId) return null;
  const cleanId = productId.trim().toLowerCase();
  return CATALOG_PRODUCTS[cleanId] || null;
}

export function getAllCatalogProducts(): CatalogProduct[] {
  return Object.values(CATALOG_PRODUCTS);
}

export function findCatalogProductBySearch(query: string): CatalogProduct | null {
  if (!query) return null;
  const lower = query.toLowerCase();
  for (const product of Object.values(CATALOG_PRODUCTS)) {
    if (
      product.productId.toLowerCase().includes(lower) ||
      product.merchantName.toLowerCase().includes(lower) ||
      product.category.toLowerCase().includes(lower)
    ) {
      return product;
    }
  }
  return null;
}
