export function assetURL(path){
  const embedded=globalThis.dhEmbeddedAssets?.[path.split('?')[0]];
  if(embedded)return embedded;
  // Resolve bundled resources relative to this module for subpath deployments.
  return path.startsWith('/static/')?new URL(path.slice(8),import.meta.url).href:path;
}
