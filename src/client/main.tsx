import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

class ErrorBoundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { console.error('River Room interface error:', error); }
  render() {
    if (this.state.failed) return <main className="fatal"><h1>The table view needs a refresh.</h1><p>Your saved chips and ledger remain on the server.</p><button onClick={() => location.reload()}>Reload River Room</button></main>;
    return this.props.children;
  }
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><App /></ErrorBoundary></React.StrictMode>);
