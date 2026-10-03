import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

/**
 * index.tsx
 * 
 * Entry point for the React application.
 * Injects global styles for map canvas and scrollbars.
 */

const GlobalStyles = () => (
  <style dangerouslySetInnerHTML={{ __html: `
    :root {
      --map-bg: #0d1117;
    }

    body {
      margin: 0;
      padding: 0;
      overflow: hidden; /* Prevent body scroll, map handles interaction */
      background-color: var(--map-bg);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    #root {
      width: 100vw;
      height: 100vh;
    }

    /* Ensure canvas takes up full container */
    canvas {
      display: block;
    }

    /* Simple scrollbar for control panels */
    .custom-scrollbar::-webkit-scrollbar {
      width: 6px;
    }

    .custom-scrollbar::-webkit-scrollbar-track {
      background: transparent;
    }

    .custom-scrollbar::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.1);
      border-radius: 3px;
    }

    .custom-scrollbar::-webkit-scrollbar-thumb:hover {
      background: rgba(255, 255, 255, 0.2);
    }
  `}} />
);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <GlobalStyles />
    <App />
  </React.StrictMode>
);