import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './globals.css';

// Geist self-host: see @font-face block in globals.css — the woff2 is vendored
// at src/assets/fonts (OFL 1.1) rather than pulled from the geist npm package.

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
