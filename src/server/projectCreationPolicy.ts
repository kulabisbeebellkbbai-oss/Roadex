function enabled(value: string | undefined): boolean {
  return value === 'true';
}

export function projectCreationRequestEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return enabled(env.ROADEX_PROJECT_CREATION_REQUEST_ENABLED);
}

export function projectCreationConfirmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return enabled(env.ROADEX_PROJECT_CREATION_CONFIRM_ENABLED);
}

export function projectCreationExecutionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return enabled(env.ROADEX_PROJECT_CREATION_EXECUTION_ENABLED);
}

export function isAvailableProjectCreationRoute(
  method: string | undefined,
  pathname: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (method === 'POST' && pathname === '/api/project-creation/proposals') {
    return projectCreationRequestEnabled(env);
  }
  if (
    method === 'GET'
    && /^\/api\/project-creation\/proposals\/[A-Za-z0-9_-]{1,128}$/.test(pathname)
  ) {
    return projectCreationRequestEnabled(env);
  }
  if (
    method === 'POST'
    && /^\/api\/project-creation\/proposals\/[A-Za-z0-9_-]{1,128}\/(?:challenge|confirm)$/.test(pathname)
  ) {
    return projectCreationConfirmEnabled(env);
  }
  if (
    method === 'POST'
    && /^\/api\/project-creation\/proposals\/[A-Za-z0-9_-]{1,128}\/revoke$/.test(pathname)
  ) {
    return projectCreationRequestEnabled(env);
  }
  return false;
}
