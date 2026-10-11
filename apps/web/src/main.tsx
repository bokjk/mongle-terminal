import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { registerNotificationWorker } from './push';
// Browser views of a PC can show its phone notifications; the PC app has its own window.
void registerNotificationWorker();
createRoot(document.getElementById('root')!).render(<App />);
