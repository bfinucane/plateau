import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import * as echarts from 'echarts';
import App from './App';
import './styles.css';

// Exposed for the headless verification harnesses, which need to probe map
// registration. Harmless in production and useful when debugging in devtools.
(window as unknown as { __ECHARTS__?: typeof echarts }).__ECHARTS__ = echarts;

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
