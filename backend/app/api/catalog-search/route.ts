import { NextResponse } from 'next/server';
import { searchCatalog, getAllCatalogProducts, getCatalogVersion } from '../../../lib/merchantCatalog';
import { authenticateRequest } from '../../../lib/auth';

export async function GET(request: Request) {
  const auth = await authenticateRequest(request, {
    allowedRoles: ['admin', 'service', 'agent', 'demo_user', 'ADMIN_ROLE', 'AGENT_ROLE'],
  });

  if (!auth.authenticated || !auth.context) {
    return NextResponse.json(
      { error: auth.error || 'Unauthorized' },
      { status: auth.statusCode || 401 }
    );
  }

  const url = new URL(request.url);
  const query = url.searchParams.get('q') || '';
  const category = url.searchParams.get('category') || undefined;
  const maxPrice = url.searchParams.get('maxPrice');
  const maxPricePaise = maxPrice ? Math.round(parseFloat(maxPrice) * 100) : undefined;

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
