import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// Rule #3: Verify version to prevent stale cache
declare global {
  interface Window {
    __DOCKEROCR_VERIFY_VERSION__?: () => string;
  }
}

if (typeof window.__DOCKEROCR_VERIFY_VERSION__ !== 'function') {
  console.warn('Cache mismatch detected (missing version check), reloading...');
  window.location.reload();
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
