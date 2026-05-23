import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './globals.css';

// Geist self-host: see @font-face block in globals.css that references the
// woff2 via a relative path into node_modules/geist. The `geist` npm package's
// `geist/font/sans` JS entry calls next/font/local (Next.js-only) and the
// package's exports field blocks deep imports of the woff2 file, so we resolve
// it via Vite's CSS url() relative resolution instead.

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
