import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './style.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
)

// オフラインでも画面を開けるようにする(https のときだけ使える)
if ('serviceWorker' in navigator && window.isSecureContext && location.hostname !== '127.0.0.1') {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}) })
}
