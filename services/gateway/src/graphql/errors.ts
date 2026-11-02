import { STATUS_CODES } from 'node:http';
import type { GraphQLFormattedError } from 'graphql';
import { GraphQLError } from 'graphql';
import { currentCorrelation, type InvalidParam } from '@ecoairlines/shared';
import { GRAPHQL_PATH } from '../http.js';

/**
 * Errores de GraphQL (contrato `gateway.graphql`, ERRORES): cada error replica el ProblemDetails v2 en `extensions` (`code` del
 * enum `ProblemCode`, `status` HTTP equivalente, `type`, `title`, `detail`, `instance`, `correlation_id`, `timestamp`,
 * `invalidParams` y `retryAfter`); `message` = `title`. La respuesta HTTP es `200` aunque haya errores de negocio.
 */
export interface Problem {
  status: number;
  code?: string;
  type?: string;
  title?: string;
  detail?: string;
  invalidParams?: InvalidParam[];
  retryAfter?: number;
}

/** Valores del enum `ProblemCode` (se cargan del esquema al arrancar). */
let problemCodes = new Set<string>();
export const setProblemCodes = (codes: Iterable<string>) => {
  problemCodes = new Set(codes);
};

const OWN_TYPE = /^urn:ecoairlines:problema:([A-Z][A-Z0-9_]*)$/;

function genericCode(status: number): string {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMIT_EXCEEDED';
  if (status === 503) return 'PROVIDER_UNAVAILABLE';
  if (status >= 500) return 'INTERNAL_ERROR';
  return 'VALIDATION_FAILED';
}

/**
 * El `code` del enum `ProblemCode`: el del contrato v2 si está en el enum (`UNAUTHORIZED` del REST se llama `UNAUTHENTICATED`
 * en GraphQL); un código propio que el MS publicó en `type` (`urn:ecoairlines:problema:EMAIL_ALREADY_REGISTERED`) recupera su
 * nombre; cualquier otro, el genérico del status.
 */
export function graphqlCode(problem: Problem): string {
  if (problem.code === 'UNAUTHORIZED') return 'UNAUTHENTICATED';
  const own = problem.type ? OWN_TYPE.exec(problem.type)?.[1] : undefined;
  if (own && problemCodes.has(own)) return own;
  if (problem.code && problemCodes.has(problem.code)) return problem.code;
  return genericCode(problem.status);
}

export function problemError(problem: Problem): GraphQLError {
  const title = problem.title || STATUS_CODES[problem.status] || 'Error';
  return new GraphQLError(title, {
    extensions: {
      code: graphqlCode(problem),
      status: problem.status,
      type: problem.type || 'about:blank',
      title,
      ...(problem.detail ? { detail: problem.detail } : {}),
      instance: GRAPHQL_PATH,
      correlation_id: currentCorrelation()?.correlationId,
      timestamp: new Date().toISOString(),
      ...(problem.invalidParams?.length ? { invalidParams: problem.invalidParams.map(({ name, reason }) => ({ name, reason })) } : {}),
      ...(problem.retryAfter !== undefined ? { retryAfter: problem.retryAfter } : {}),
    },
  });
}

export const unauthenticated = (title: string) => problemError({ status: 401, code: 'UNAUTHENTICATED', title });
export const forbidden = (title: string) => problemError({ status: 403, code: 'FORBIDDEN', title });
export const invalidInput = (invalidParams: InvalidParam[]) => problemError({ status: 400, code: 'VALIDATION_FAILED', title: 'Los argumentos no cumplen el contrato.', invalidParams });

/** Errores de Apollo y de graphql-js que no son de negocio: el documento no se pudo leer o no cumple el esquema. */
const DOCUMENT_ERRORS = new Set(['GRAPHQL_PARSE_FAILED', 'GRAPHQL_VALIDATION_FAILED', 'BAD_USER_INPUT', 'BAD_REQUEST', 'OPERATION_RESOLUTION_FAILURE', 'PERSISTED_QUERY_NOT_SUPPORTED', 'PERSISTED_QUERY_NOT_FOUND']);

/**
 * `formatError` de Apollo: un error nuestro (ya tiene `status`) sale tal cual; uno del documento pasa a `VALIDATION_FAILED`
 * (`400`); cualquier otro es un error no controlado: `INTERNAL_ERROR` sin detalles (no se filtran mensajes internos).
 */
export function formatError(formatted: GraphQLFormattedError, log: (message: string) => void): GraphQLFormattedError {
  const extensions = formatted.extensions ?? {};
  const base = { ...(formatted.locations ? { locations: formatted.locations } : {}), ...(formatted.path ? { path: formatted.path } : {}) };
  if (typeof extensions['status'] === 'number' && typeof extensions['code'] === 'string' && problemCodes.has(extensions['code'])) {
    const { stacktrace: _stacktrace, ...rest } = extensions;
    return { message: formatted.message, ...base, extensions: rest };
  }
  const document = typeof extensions['code'] === 'string' && DOCUMENT_ERRORS.has(extensions['code']);
  if (!document) log(`Error no controlado en GraphQL: ${formatted.message}`);
  const problem = document
    ? problemError({ status: 400, code: 'VALIDATION_FAILED', title: formatted.message })
    : problemError({ status: 500, code: 'INTERNAL_ERROR', title: 'Error interno.' });
  return { message: problem.message, ...base, extensions: problem.extensions };
}
