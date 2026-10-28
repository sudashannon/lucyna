import React from 'react';
import { createRoot } from 'react-dom/client';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import '@fontsource-variable/inter';
import '@xterm/xterm/css/xterm.css';
import './app.css';
import './panels.css';
import './scrollbars.css';
import './knowledge.css';
import './markdown.css';
import './work-diagnostics.css';
import './brand.css';
import './pet-settings.css';
import { App } from './App';
i18n.use(initReactI18next).init({ lng: 'zh', fallbackLng: 'zh', interpolation: { escapeValue: false }, resources: { zh: { translation: {
  settings: { apiKey: { hideKey: '隐藏', showKey: '显示' } },
  contentHeader: { expandPanel: '展开工具面板', collapsePanel: '收起工具面板' },
  rightSidebar: { tabs: { controls: { showAria: '显示工具面板' } } },
} } } });
createRoot(document.getElementById('root')!).render(<App />);
