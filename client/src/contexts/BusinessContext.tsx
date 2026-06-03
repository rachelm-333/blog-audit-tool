/**
 * BusinessContext — Layer 14 Agency Multi-Client Feature
 *
 * Stores the currently selected businessId in localStorage so it persists
 * across page navigations and refreshes. All business-scoped pages read
 * from this context instead of URL params.
 *
 * Usage:
 *   const { selectedBusinessId, setSelectedBusinessId } = useBusinessContext();
 */
import { createContext, useContext, useState, useEffect, useCallback } from "react";

const STORAGE_KEY = "iaudit_selected_business_id";

interface BusinessContextValue {
  selectedBusinessId: string | null;
  setSelectedBusinessId: (id: string | null) => void;
}

const BusinessContext = createContext<BusinessContextValue>({
  selectedBusinessId: null,
  setSelectedBusinessId: () => {},
});

export function BusinessProvider({ children }: { children: React.ReactNode }) {
  const [selectedBusinessId, setSelectedBusinessIdState] = useState<string | null>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  });

  const setSelectedBusinessId = useCallback((id: string | null) => {
    setSelectedBusinessIdState(id);
    try {
      if (id) {
        localStorage.setItem(STORAGE_KEY, id);
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // localStorage may be unavailable in some environments
    }
  }, []);

  // Sync across tabs
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        setSelectedBusinessIdState(e.newValue ?? null);
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  return (
    <BusinessContext.Provider value={{ selectedBusinessId, setSelectedBusinessId }}>
      {children}
    </BusinessContext.Provider>
  );
}

export function useBusinessContext(): BusinessContextValue {
  return useContext(BusinessContext);
}
