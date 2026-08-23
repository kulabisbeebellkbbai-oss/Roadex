const PROJECT = '[A-Za-z0-9][A-Za-z0-9._:-]{0,159}';
const ROUTE = new RegExp(`^/api/projects/${PROJECT}/human-thread/conversation(?:/messages)?$`);
const CSRF = /^[A-Za-z0-9._~-]{16,256}$/;

export function isAvailableProjectHumanThreadConversationRoute(
  method: string | undefined,
  pathname: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.ROADEX_PROJECT_HUMAN_THREAD_ENABLED !== 'true' || !ROUTE.test(pathname)) return false;
  if (method === 'GET') return pathname.endsWith('/conversation');
  return method === 'POST' && pathname.endsWith('/conversation/messages');
}

export function validProjectHumanThreadConversationCsrf(value: string | string[] | undefined): boolean {
  return typeof value === 'string' && CSRF.test(value);
}
