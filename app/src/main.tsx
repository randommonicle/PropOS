/**
 * @file main.tsx
 * @description Application entry point.
 * Responsible for: mounting the React root and importing global styles.
 * NOT responsible for: any application logic.
 */
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
