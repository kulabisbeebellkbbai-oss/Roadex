import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RoadexErrorBoundary, RoadexErrorFallback } from '../src/RoadexErrorBoundary';

describe('Roadex error boundary', () => {
  it('moves to the recovery state after a render error', () => {
    expect(RoadexErrorBoundary.getDerivedStateFromError()).toEqual({ hasError: true });
  });

  it('renders an accessible recovery surface without privileged actions', () => {
    const html = renderToStaticMarkup(<RoadexErrorFallback />);

    expect(html).toContain('Roadex could not display this page');
    expect(html).toContain('Reload Roadex');
    expect(html).toContain('The latest project state may be incomplete');
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('No project action was submitted');
    expect(html).not.toContain('Create project thread');
    expect(html).not.toContain('Replace thread');
    expect(html).not.toContain('Approve');
  });
});
