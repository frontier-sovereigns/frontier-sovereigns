import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './style.css';
import './accessibility.css';
const AssetGallery = React.lazy(() => import('./AssetGallery'));

createRoot(document.getElementById('root')!).render(<React.StrictMode>{window.location.pathname === '/asset-gallery' ? <React.Suspense fallback={<p className="gallery-loading">Preparing the original asset gallery…</p>}><AssetGallery onClose={() => { window.location.href = '/'; }}/></React.Suspense> : <App />}</React.StrictMode>);
