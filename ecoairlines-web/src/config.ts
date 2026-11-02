/** URLs configurables con variables de Vite (ver `.env.example`). */
/** GraphQL del gateway (D23): la ÚNICA forma en que la web accede al sistema. */
export const GRAPHQL_URL = (import.meta.env.VITE_GRAPHQL_URL as string | undefined) ?? 'http://localhost:8088/api/graphql';
/** Payment API simulada (D7, D49): la tarjeta va del navegador a la pasarela; a EcoAirlines solo llega la referencia del pago. */
export const PAYMENT_API_URL = (import.meta.env.VITE_PAYMENT_API_URL as string | undefined) ?? 'http://localhost:4010';
/** Clave PÚBLICA de la pasarela (`pk_test_…`): está pensada para el navegador. La secreta (`sk_test_…`) nunca llega aquí. */
export const PAYMENT_PUBLIC_KEY = (import.meta.env.VITE_PAYMENT_PUBLIC_KEY as string | undefined) ?? 'pk_test_dev_solo_local_ecoairlines_0001';

export const BRAND = {
  name: 'EcoAirlines',
  tagline: 'Vuela a donde sueñas, cuidando el planeta',
} as const;
