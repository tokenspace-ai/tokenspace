import React from "react";
import { ErrorMessage } from "./error-message";

type ErrorBoundaryProps = {
  children: React.ReactNode;
  onError?: (error: Error) => void;
  renderError?: (error: Error) => React.ReactNode;
  name: string;
};

type ErrorBoundaryState = {
  error?: Error;
};

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {};
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error(error, errorInfo);
    (window as any).__lastError = error;
    // reportErrorToServer(error, this.props.name);
  }

  render() {
    if (this.state.error) {
      return this.props.renderError ? (
        this.props.renderError(this.state.error)
      ) : (
        <ErrorMessage error={this.state.error} />
      );
    }
    return this.props.children;
  }
}
