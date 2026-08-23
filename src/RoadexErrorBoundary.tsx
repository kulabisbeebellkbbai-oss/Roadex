import { Component, type ErrorInfo, type ReactNode } from 'react';

type RoadexErrorBoundaryProps = {
  children: ReactNode;
};

type RoadexErrorBoundaryState = {
  hasError: boolean;
};

export function RoadexErrorFallback() {
  return (
    <main className="app-error-boundary" role="alert" aria-live="assertive">
      <h1>Roadex could not display this page</h1>
      <p>The interface encountered an unexpected display error. The latest project state may be incomplete; check its status before retrying an action.</p>
      <button type="button" onClick={() => window.location.reload()}>Reload Roadex</button>
    </main>
  );
}

export class RoadexErrorBoundary extends Component<RoadexErrorBoundaryProps, RoadexErrorBoundaryState> {
  state: RoadexErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): RoadexErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Roadex render failure', error, info.componentStack);
  }

  render(): ReactNode {
    return this.state.hasError ? <RoadexErrorFallback /> : this.props.children;
  }
}
