export type Platform = 'google' | 'apple';

/**
 * Build a route for a specific platform
 */
export function getPlatformRoute(platform: Platform, path: string = ''): string {
  const basePath = `/dashboard/${platform}`;
  if (!path) return basePath;
  return `${basePath}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Get the product detail route for a platform
 */
export function getProductDetailRoute(platform: Platform, sku: string): string {
  return getPlatformRoute(platform, `/products/${encodeURIComponent(sku)}`);
}

/**
 * Get the subscription detail route for a platform
 */
export function getSubscriptionDetailRoute(platform: Platform, id: string): string {
  return getPlatformRoute(platform, `/subscriptions/${encodeURIComponent(id)}`);
}

/**
 * Get the products list route for a platform
 */
export function getProductsRoute(platform: Platform): string {
  return getPlatformRoute(platform, '/products');
}

/**
 * Get the subscriptions list route for a platform
 */
export function getSubscriptionsRoute(platform: Platform): string {
  return getPlatformRoute(platform, '/subscriptions');
}

/**
 * Switch the current route to another platform
 * E.g., /dashboard/google/products -> /dashboard/apple/products
 */
export function switchPlatformRoute(pathname: string, toPlatform: Platform): string {
  // Match /dashboard/google/... or /dashboard/apple/...
  const match = pathname.match(/^\/dashboard\/(google|apple)(\/.*)?$/);
  if (match) {
    const subPath = match[2] || '';
    return `/dashboard/${toPlatform}${subPath}`;
  }
  // If not a platform-specific route, just go to platform root
  return getPlatformRoute(toPlatform);
}

/**
 * Extract the platform from a pathname
 * Returns null if not in a platform-specific route
 */
export function getPlatformFromPath(pathname: string): Platform | null {
  const match = pathname.match(/^\/dashboard\/(google|apple)/);
  if (match) {
    return match[1] as Platform;
  }
  return null;
}

/**
 * Check if a pathname is a platform-specific route
 */
export function isPlatformRoute(pathname: string): boolean {
  return /^\/dashboard\/(google|apple)/.test(pathname);
}
