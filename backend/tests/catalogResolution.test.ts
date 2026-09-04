import { describe, it, expect } from 'vitest';
import {
  resolveCatalogProduct,
  getAllCatalogProducts,
  findCatalogProductBySearch,
  searchCatalog,
  getCatalogVersion,
  CURRENT_CATALOG_VERSION,
} from '../lib/merchantCatalog';

describe('catalogResolution – resolveCatalogProduct', () => {
  it('returns product for valid productId', () => {
    const p = resolveCatalogProduct('swiggy-dinner-650');
    expect(p).not.toBeNull();
    expect(p?.productId).toBe('swiggy-dinner-650');
    expect(p?.merchantName).toBe('Swiggy');
    expect(p?.unitPricePaise).toBe(65000);
  });

  it('is case-insensitive', () => {
    const p = resolveCatalogProduct('SWIGGY-DINNER-650');
    expect(p).not.toBeNull();
  });

  it('returns null for unknown productId', () => {
    expect(resolveCatalogProduct('nonexistent-product')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(resolveCatalogProduct('')).toBeNull();
  });
});

describe('catalogResolution – getAllCatalogProducts', () => {
  it('returns all products', () => {
    const all = getAllCatalogProducts();
    expect(all.length).toBeGreaterThan(0);
  });

  it('every product has required fields', () => {
    for (const p of getAllCatalogProducts()) {
      expect(p.productId).toBeTruthy();
      expect(p.merchantId).toBeTruthy();
      expect(p.merchantName).toBeTruthy();
      expect(p.mcc).toMatch(/^\d{4}$/);
      expect(p.category).toBeTruthy();
      expect(p.unitPricePaise).toBeGreaterThan(0);
      expect(p.currency).toBe('INR');
      expect(p.catalogVersion).toBe(CURRENT_CATALOG_VERSION);
    }
  });
});

describe('catalogResolution – getCatalogVersion', () => {
  it('returns current catalog version string', () => {
    expect(getCatalogVersion()).toBe(CURRENT_CATALOG_VERSION);
    expect(typeof getCatalogVersion()).toBe('string');
  });
});

describe('catalogResolution – findCatalogProductBySearch', () => {
  it('finds by merchant name', () => {
    const p = findCatalogProductBySearch('swiggy');
    expect(p).not.toBeNull();
    expect(p?.merchantName.toLowerCase()).toContain('swiggy');
  });

  it('finds by category', () => {
    const p = findCatalogProductBySearch('Electronics');
    expect(p?.category).toBe('Electronics');
  });

  it('returns null for empty query', () => {
    expect(findCatalogProductBySearch('')).toBeNull();
  });
});

describe('catalogResolution – searchCatalog', () => {
  it('returns all products for empty query with no filters', () => {
    const results = searchCatalog('');
    expect(results.length).toBe(getAllCatalogProducts().length);
  });

  it('ranks name matches above category matches', () => {
    const results = searchCatalog('dinner');
    expect(results.length).toBeGreaterThan(0);
    // First result should be a dinner product
    expect(results[0].name?.toLowerCase()).toContain('dinner');
  });

  it('filters by category', () => {
    const results = searchCatalog('', { category: 'Electronics' });
    expect(results.every((p) => p.category === 'Electronics')).toBe(true);
  });

  it('filters by maxPricePaise', () => {
    const max = 50000; // ₹500
    const results = searchCatalog('', { maxPricePaise: max });
    expect(results.every((p) => p.unitPricePaise <= max)).toBe(true);
  });

  it('returns empty array when no products match filter', () => {
    const results = searchCatalog('', { maxPricePaise: 1 }); // impossibly low
    expect(results).toHaveLength(0);
  });

  it('combines query and price filter', () => {
    const results = searchCatalog('food', { maxPricePaise: 100000 });
    expect(results.every((p) => p.unitPricePaise <= 100000)).toBe(true);
  });
});

describe('catalogResolution – catalog version consistency', () => {
  it('all products share the same catalogVersion', () => {
    const versions = getAllCatalogProducts().map((p) => p.catalogVersion);
    const unique = new Set(versions);
    expect(unique.size).toBe(1);
    expect([...unique][0]).toBe(CURRENT_CATALOG_VERSION);
  });

  it('all productIds are unique', () => {
    const ids = getAllCatalogProducts().map((p) => p.productId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
