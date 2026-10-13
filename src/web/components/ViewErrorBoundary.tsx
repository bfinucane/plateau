/**
 * Error boundary for the view canvas.
 *
 * A render error in one visualisation must not tear down the whole application.
 * Without this, an invalid chart option (for example a `map` series referencing
 * unregistered geometry) unmounts the entire React tree and the user sees a
 * blank page with no way back.
 *
 * Class component because React only supports error boundaries through
 * `componentDidCatch` / `getDerivedStateFromError`.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Changing this resets the boundary, so fixing the view recovers it. */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

export class ViewErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surfaced in the browser console for debugging; the UI stays usable.
    console.error('View failed to render:', error, info.componentStack);
  }

  componentDidUpdate(previous: Props): void {
    // Clear the error when the view definition changes, so the user can simply
    // pick a different mark type to recover.
    if (this.state.error && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="view-message view-error">
          <strong>This view could not be drawn.</strong>
          <p>{this.state.error.message}</p>
          <p className="view-error-hint">
            Try a different mark type, or remove the field that caused the problem. Your data and
            other sheets are unaffected.
          </p>
          <button
            type="button"
            className="button-secondary"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
