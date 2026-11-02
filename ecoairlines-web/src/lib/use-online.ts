import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void) {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/** `true` si el navegador cree tener conexión. Un `false` es seguro; un `true` no garantiza que el servidor responda. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, () => navigator.onLine);
}
