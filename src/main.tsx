import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { RoadexErrorBoundary } from './RoadexErrorBoundary';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RoadexErrorBoundary>
      <App />
    </RoadexErrorBoundary>
  </StrictMode>,
);
