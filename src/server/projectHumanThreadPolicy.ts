const PROJECT = '[A-Za-z0-9][A-Za-z0-9._:-]{0,159}';
const EXACT_ROUTE = new RegExp(`^/api/projects/${PROJECT}/human-thread(?:/(?:history|create|adopt|recover|replace))?$`);
const CSRF = /^[A-Za-z0-9._~-]{16,256}$/;

export function projectHumanThreadEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ROADEX_PROJECT_HUMAN_THREAD_ENABLED === 'true';
}

export function isAvailableProjectHumanThreadRoute(
  method: string | undefined,
  pathname: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!projectHumanThreadEnabled(env) || !EXACT_ROUTE.test(pathname)) return false;
  if (method === 'GET') return !/(?:create|adopt|recover|replace)$/.test(pathname);
  return method === 'POST' && /(?:create|adopt|recover|replace)$/.test(pathname);
}

export function validProjectHumanThreadCsrf(value: string | string[] | undefined): boolean {
  return typeof value === 'string' && CSRF.test(value);
}
