/** Circuit breaker por MS.G: vive en `@ecoairlines/shared` (V2.12) porque también lo usan los MS de respuesta hacia el ESB. */
export { CircuitBreaker, type CircuitState, isUnavailable } from '@ecoairlines/shared/clients/circuit-breaker.js';
