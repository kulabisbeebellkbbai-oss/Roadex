const PROJECT = '[A-Za-z0-9][A-Za-z0-9._:-]{0,159}';
const MESSAGE = '[A-Za-z0-9][A-Za-z0-9._:-]{0,159}';
const ROUTE = new RegExp(`^/api/projects/${PROJECT}/human-thread/messages(?:/(history|${MESSAGE}/respond))?$`);

export function isAvailableProjectHumanThreadTranscriptRoute(
  method: string | undefined,
  pathname: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.ROADEX_PROJECT_HUMAN_THREAD_ENABLED !== 'true' || !ROUTE.test(pathname)) return false;
  if (method === 'GET') return pathname.endsWith('/messages') || pathname.endsWith('/messages/history');
  return method === 'POST' && /\/messages\/[A-Za-z0-9][A-Za-z0-9._:-]{0,159}\/respond$/.test(pathname);
}

export function isAvailableProjectHumanThreadQuestionRoute(
  method: string | undefined,
  pathname: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.ROADEX_PROJECT_HUMAN_THREAD_ENABLED === 'true'
    && method === 'POST'
    && pathname === '/api/internal/overseer/project-human-thread/questions';
}
