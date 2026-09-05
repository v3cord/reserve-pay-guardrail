import { NextResponse } from 'next/server';
import { searchCatalog, getAllCatalogProducts, getCatalogVersion } from '../../../lib/merchantCatalog';
import { authenticateRequest } from '../../../lib/auth';

export async function GET(request: Request) {
  // Allow demo browsing: check auth if provided, but don't hard block catalog read
  const auth = await authenticateRequest(request, {
    allowedRoles: ['admin', 'service', 'agent', 'demo_user', 'ADMIN_ROLE', 'AGENT_ROLE'],
  });

  const url = new URL(request.url);
  const query = url.searchParams.get('q') || '';
  const category = url.searchParams.get('category') || undefined;
  const maxPriceRaw = url.searchParams.get('maxPrice');
  
  let maxPricePaise: number | undefined;
  if (maxPriceRaw) {
    const val = parseFloat(maxPriceRaw);
    if (!isNaN(val) && val > 0) {
      // If <= 1000, value is in rupees (e.g. 800 -> 80000 paise)
      // If > 1000, value is already in paise (e.g. 80000)
      maxPricePaise = val <= 1000 ? Math.round(val * 100) : Math.round(val);
    }
  }

  const results = query || category || maxPricePaise !== undefined
    ? searchCatalog(query, { category, maxPricePaise })
    : getAllCatalogProducts();

  return NextResponse.json({
    catalogVersion: getCatalogVersion(),
    count: results.length,
    products: results.map((p) => ({
      productId: p.productId,
      name: p.name,
      merchantId: p.merchantId,
      merchantName: p.merchantName,
      category: p.category,
      mcc: p.mcc,
      priceRupees: (p.unitPricePaise / 100).toFixed(2),
      unitPricePaise: p.unitPricePaise,
      currency: p.currency,
      catalogVersion: p.catalogVersion,
    })),
  });
}
