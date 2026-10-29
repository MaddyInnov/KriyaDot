// SPDX-License-Identifier: Apache-2.0
// White-label brand provider (enterprise pack).
//
// Fetches GET /api/brand (via the same loopback-token bootstrap the rest of
// the web shell uses — the token is read from sessionStorage key
// 'kriyadot:api-token' when present; the fetch is best-effort and falls back
// to the built-in KriyaDot brand) and applies:
//   - document.title + a data-brand-name attribute (name/tagline)
//   - the logo URL exposed via React context for header components
//   - the primary color as CSS variables: --brand-primary (and the theme's
//     --accent alias) on :root
//
// Mount near the root layout:
//   import { BrandProvider } from '@/components/brand-provider';
//   <BrandProvider>{children}</BrandProvider>
// Consumers read it with useBrand().

'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export interface Brand {
  name: string;
  tagline: string;
  logoDataUrl?: string;
  logoUrl?: string;
  primaryColor: string;
}

const FALLBACK_BRAND: Brand = {
  name: 'KriyaDot',
  tagline: 'Your all-in-one AI agent',
  primaryColor: '#6d3fc4',
};

const BrandContext = createContext<Brand>(FALLBACK_BRAND);

export function useBrand(): Brand {
  return useContext(BrandContext);
}

function applyBrand(brand: Brand): void {
  if (typeof document === 'undefined') return;
  document.title = brand.name;
  document.documentElement.dataset.brandName = brand.name;
  document.documentElement.style.setProperty('--brand-primary', brand.primaryColor);
  document.documentElement.style.setProperty('--accent', brand.primaryColor);
}

export function BrandProvider({ children }: { children: ReactNode }) {
  const [brand, setBrand] = useState<Brand>(FALLBACK_BRAND);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = (() => {
          try {
            return sessionStorage.getItem('kriyadot:api-token') ?? '';
          } catch {
            return '';
          }
        })();
        const res = await fetch('/api/brand', {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) return;
        const data = (await res.json()) as { brand?: Brand };
        if (!cancelled && data.brand) {
          setBrand(data.brand);
          applyBrand(data.brand);
        }
      } catch {
        // Brand fetch is best-effort: the fallback brand stays.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const logo = brand.logoDataUrl ?? brand.logoUrl;

  return (
    <BrandContext.Provider value={brand}>
      <span data-brand={brand.name} hidden>
        {logo ? <img src={logo} alt={brand.name} /> : null}
      </span>
      {children}
    </BrandContext.Provider>
  );
}

export default BrandProvider;
