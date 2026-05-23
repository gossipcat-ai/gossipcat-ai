import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { GeistSans } from 'geist/font/sans';
import { App } from './App';
import './globals.css';

document.documentElement.classList.add(GeistSans.variable);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
