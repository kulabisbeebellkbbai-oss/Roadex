function enabled(value: string | undefined): boolean {
  return value === 'true';
}

export function appPublicationRequestEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return enabled(env.ROADEX_APP_PUBLICATION_REQUEST_ENABLED);
}

export function isAvailableAppPublicationRoute(
  method: string | undefined,
  pathname: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!appPublicationRequestEnabled(env)) return false;
  if (method === 'POST' && pathname === '/api/app-publication/requests') return true;
  return method === 'GET'
    && /^\/api\/app-publication\/requests\/[A-Za-z0-9_-]{1,128}$/.test(pathname);
}
