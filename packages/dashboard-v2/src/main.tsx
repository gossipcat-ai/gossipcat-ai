import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './globals.css';

// Note: geist/font/sans requires next/font/local which is not available in Vite.
// The --font-sans chain in globals.css uses `var(--font-geist-sans, 'Geist')` —
// the literal 'Geist' fallback activates when --font-geist-sans is not set.
// Step 10 cleanup can revisit this once a Vite-compatible Geist loader is available.

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
