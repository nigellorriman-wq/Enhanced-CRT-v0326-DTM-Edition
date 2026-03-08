import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

console.log("APP VERSION 3.0 - SETTINGS & DTM INTEGRATED");
const container = document.getElementById('root');

if (container) {
  try {
    const root = createRoot(container);
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );
  } catch (err) {
    console.error("main.tsx: Render failed:", err);
  }
}
