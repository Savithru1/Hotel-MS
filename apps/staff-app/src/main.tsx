import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { AppProviders, AppRoutes } from './App';
import { createApiClient } from './api/client';
import './index.css';

// Same-origin in development (Vite proxies /api and /socket.io to the backend). In production
// set VITE_API_URL when the API is on another origin; the backend must then allow this origin.
const client = createApiClient({ baseUrl: import.meta.env.VITE_API_URL ?? '' });

const root = document.getElementById('root');
if (!root) throw new Error('The page has no #root element');

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <AppProviders client={client}>
        <AppRoutes />
      </AppProviders>
    </BrowserRouter>
  </StrictMode>,
);
