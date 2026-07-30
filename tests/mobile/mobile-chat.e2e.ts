import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('main.app-shell')).toHaveClass(/layout-mobile/);
});

test('keeps the conversation within the mobile viewport', async ({ page }) => {
  const shell = page.locator('main.app-shell');
  const transcript = page.locator('.transcript');
  const composer = page.locator('.prompt-row');

  await expect(page.getByRole('button', { name: 'Open navigation and controls' })).toBeVisible();
  await expect(page.locator('.mobile-title').first()).toBeVisible();
  await expect(transcript).toBeVisible();
  await expect(composer).toBeVisible();

  const layout = await page.evaluate(() => {
    const shellElement = document.querySelector<HTMLElement>('main.app-shell');
    const transcriptElement = document.querySelector<HTMLElement>('.transcript');
    const composerElement = document.querySelector<HTMLElement>('.prompt-row');
    if (!shellElement || !transcriptElement || !composerElement) throw new Error('Mobile chat shell is incomplete.');
    const transcriptStyle = getComputedStyle(transcriptElement);
    const composerRect = composerElement.getBoundingClientRect();
    return {
      bodyHeight: document.body.getBoundingClientRect().height,
      bodyWidth: document.body.getBoundingClientRect().width,
      composerBottom: composerRect.bottom,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      shellHeight: shellElement.getBoundingClientRect().height,
      transcriptClientHeight: transcriptElement.clientHeight,
      transcriptOverflowY: transcriptStyle.overflowY,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };
  });

  expect(layout.bodyHeight).toBeLessThanOrEqual(layout.viewportHeight + 1);
  expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
  expect(layout.shellHeight).toBeLessThanOrEqual(layout.viewportHeight + 1);
  expect(layout.composerBottom).toBeLessThanOrEqual(layout.viewportHeight + 1);
  expect(layout.overflowX).toBeLessThanOrEqual(0);
  expect(layout.transcriptClientHeight).toBeGreaterThan(0);
  expect(layout.transcriptOverflowY).toBe('auto');

  await transcript.evaluate((element) => {
    for (let index = 0; index < 40; index += 1) {
      const message = document.createElement('div');
      message.className = `message ${index % 2 === 0 ? 'assistant' : 'user'}`;
      message.textContent = `Local mobile history fixture ${index}`;
      element.append(message);
    }
  });

  const history = await transcript.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    const bottom = element.scrollTop;
    element.scrollTop = 0;
    return {
      bottom,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      top: element.scrollTop,
    };
  });

  expect(history.scrollHeight).toBeGreaterThan(history.clientHeight);
  expect(history.bottom).toBeGreaterThan(0);
  expect(history.top).toBe(0);
  await expect(shell).toHaveClass(/mobile-view-chat/);
  await expect.poll(() => page.evaluate(() => document.body.getBoundingClientRect().height))
    .toBeLessThanOrEqual(layout.viewportHeight + 1);
});

test('wraps long file addresses inside chat bubbles', async ({ page }) => {
  const transcript = page.locator('.transcript');
  const path = '/home/god/Documents/Codex Workspace/Roadex/src/features/mobile/conversations/components/ExtremelyLongUnbrokenFileAddressThatMustRemainReadableOnMobileScreens.tsx';

  await transcript.evaluate((element, filePath) => {
    const message = document.createElement('div');
    message.className = 'message assistant';
    const text = document.createElement('p');
    text.dataset.testid = 'long-file-address';
    text.textContent = filePath;
    message.append(text);
    element.append(message);
  }, path);

  const measurements = await page.locator('[data-testid="long-file-address"]').evaluate((text) => {
    const bubble = text.closest<HTMLElement>('.message');
    const transcriptElement = text.closest<HTMLElement>('.transcript');
    if (!bubble || !transcriptElement) throw new Error('Long-path fixture is outside the transcript.');
    const textRect = text.getBoundingClientRect();
    const bubbleRect = bubble.getBoundingClientRect();
    const style = getComputedStyle(text);
    return {
      bubbleRight: bubbleRect.right,
      lineHeight: Number.parseFloat(style.lineHeight),
      textHeight: textRect.height,
      textRight: textRect.right,
      transcriptClientWidth: transcriptElement.clientWidth,
      transcriptScrollWidth: transcriptElement.scrollWidth,
    };
  });

  expect(measurements.textRight).toBeLessThanOrEqual(measurements.bubbleRight + 1);
  expect(measurements.textHeight).toBeGreaterThan(measurements.lineHeight);
  expect(measurements.transcriptScrollWidth).toBeLessThanOrEqual(measurements.transcriptClientWidth);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => document.documentElement.clientWidth),
  );
});

test('exposes controls and information views through the mobile drawer', async ({ page }) => {
  const menu = page.getByRole('button', { name: 'Open navigation and controls' });
  const drawer = page.getByRole('complementary', { name: 'Roadex navigation' });

  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await expect(drawer).toBeVisible();

  for (const label of ['Sessions', 'Projects', 'Security', 'Devices']) {
    const control = drawer.getByRole('button', { name: label });
    await expect(control).toBeVisible();
    expect((await control.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  }

  await expect(page.getByTestId('project-selector')).toBeVisible();
  await expect(page.getByTestId('thread-selector')).toBeVisible();

  await drawer.getByRole('button', { name: 'Security' }).click();
  await expect(page.locator('main.app-shell')).toHaveClass(/mobile-view-security/);
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('heading', { name: 'Security checks' })).toBeVisible();

  await menu.click();
  await drawer.getByRole('button', { name: 'Devices' }).click();
  await expect(page.locator('main.app-shell')).toHaveClass(/mobile-view-devices/);
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('heading', { name: 'Latest events' })).toBeVisible();

  await menu.click();
  await drawer.getByRole('button', { name: 'Sessions' }).click();
  await expect(page.locator('main.app-shell')).toHaveClass(/mobile-view-chat/);
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.transcript')).toBeVisible();
});

test('keeps desktop conversation history in a fixed scroll viewport', async ({ page }) => {
  await page.getByTestId('layout-toggle').click();
  await expect(page.locator('main.app-shell')).toHaveClass(/layout-desktop/);
  const transcript = page.locator('.transcript');
  const before = await page.evaluate(() => ({
    bodyHeight: document.body.getBoundingClientRect().height,
    transcriptHeight: document.querySelector<HTMLElement>('.transcript')?.getBoundingClientRect().height ?? 0,
  }));
  await transcript.evaluate((element) => {
    for (let index = 0; index < 60; index += 1) {
      const message = document.createElement('div');
      message.className = 'message assistant';
      message.textContent = `Desktop history fixture ${index}`;
      element.append(message);
    }
  });
  const after = await transcript.evaluate((element) => ({
    clientHeight: element.clientHeight,
    overflowY: getComputedStyle(element).overflowY,
    scrollHeight: element.scrollHeight,
  }));
  expect(after.overflowY).toBe('auto');
  expect(after.scrollHeight).toBeGreaterThan(after.clientHeight);
  expect(after.clientHeight).toBeLessThanOrEqual(before.transcriptHeight + 1);
  expect(await page.evaluate(() => document.body.getBoundingClientRect().height))
    .toBeLessThanOrEqual(before.bodyHeight + 1);
});

test('restores the selected owned thread after reload', async ({ page }) => {
  const sessions = ['session-first', 'session-selected'].map((id, index) => ({
    id,
    userId: 'owner',
    workspace: { id: 'roadex', name: 'Roadex', root: '/srv/roadex' },
    lifecycle: index === 0 ? 'ready' : 'blocked',
    runnerMode: 'codex',
    transport: 'sse',
    deviceBridge: 'disabled',
    gates: [],
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
  }));
  await page.route('**/api/bootstrap', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      user: { id: 'owner', displayName: 'Owner', authMode: 'protected-gateway', roles: ['user'] },
      workspaces: [sessions[0].workspace],
      sessions,
      auditEvents: [],
      streamPreview: [],
      managedThreads: [],
      deviceBridgePolicy: {
        state: 'disabled',
        approvedFoundation: true,
        operations: ['esp32.flash'],
        requestIntakeEnabled: false,
        descriptorObservationEnabled: false,
        operationsEnabled: false,
        writeEnabled: false,
        reason: 'disabled',
      },
      deviceInventoryBindingRefs: [],
      serialVerificationProfiles: [],
      bleVerificationProfiles: [],
      usbDeviceProfiles: [],
    }),
  }));
  await page.route('**/api/sessions', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ sessions: [] }),
  }));
  await page.route('**/api/sessions/*/stream*', (route) => route.fulfill({
    contentType: 'text/event-stream',
    body: '',
  }));
  await page.route('**/api/sessions/session-selected/reopen', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      reopened: true,
      session: { ...sessions[1], lifecycle: 'ready' },
      auditEvent: {
        id: 'audit-recover',
        actorId: 'owner',
        action: 'session.recover',
        resourceId: 'session-selected',
        outcome: 'allowed',
        detail: 'Recovered stopped session without starting a runner.',
        createdAt: '2026-07-30T00:01:00.000Z',
      },
    }),
  }));
  await page.route('**/api/sessions/session-first/close', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      closed: true,
      auditEvent: {
        id: 'audit-close',
        actorId: 'owner',
        action: 'session.close',
        resourceId: 'session-first',
        outcome: 'allowed',
        detail: 'Archived unused thread.',
        createdAt: '2026-07-30T00:02:00.000Z',
      },
    }),
  }));
  await page.evaluate(() => window.localStorage.setItem('roadex-selected-session', 'session-selected'));
  await page.reload();
  await page.getByRole('button', { name: 'Open navigation and controls' }).click();
  await expect(page.getByTestId('thread-selector')).toHaveValue('roadex:session-selected');
  const recover = page.getByRole('button', { name: /Recover thread/ });
  await expect(recover).toBeVisible();
  await recover.click();
  await expect(recover).toHaveCount(0);

  const unusedArchive = page.getByRole('button', { name: 'Archive thread on-first' });
  await unusedArchive.click();
  await expect(unusedArchive).toHaveCount(0);

  await page.evaluate(() => window.localStorage.setItem('roadex-selected-session', 'session-other-owner'));
  await page.reload();
  await page.getByRole('button', { name: 'Open navigation and controls' }).click();
  await expect(page.getByTestId('thread-selector')).toHaveValue('roadex:session-first');
});
