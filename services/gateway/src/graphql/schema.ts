import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApolloServerPlugin } from '@apollo/server';
import { makeExecutableSchema } from '@graphql-tools/schema';
import type { ApolloDriverConfig } from '@nestjs/apollo';
import { ApolloDriver } from '@nestjs/apollo';
import { Logger } from '@nestjs/common';
import type { Request } from 'express';
import { buildSchema, GraphQLEnumType, type GraphQLSchema, isObjectType } from 'graphql';
import { isValidId, newCorrelationId } from '@ecoairlines/shared';
import { GRAPHQL_PATH } from '../http.js';
import type { GatewayRuntime } from '../runtime.js';
import { authenticateUser, type GqlContext, MsClient } from './context.js';
import { applyDirectives } from './directives.js';
import { formatError, problemError, setProblemCodes } from './errors.js';
import { complexityPlugin, depthLimit } from './limits.js';
import { createResolvers } from './resolvers.js';
import { scalarResolvers } from './scalars.js';
import { bookingEventsSubscriber } from './subscriptions.js';

export const GATEWAY_SDL = 'gateway.graphql';

const enumValues = (schema: GraphQLSchema, name: string) => {
  const type = schema.getType(name);
  if (!(type instanceof GraphQLEnumType)) throw new Error(`gateway.graphql no define el enum ${name}`);
  return new Set(type.getValues().map((value) => value.name));
};

/**
 * Esquema ejecutable del gateway a partir de `contract/gateway.graphql` (esquema primero, PLAN.md §4.4): el SDL del contrato,
 * los escalares, los resolvers y las directivas. Al arrancar se comprueba que cada campo de Query, Mutation y Subscription
 * tenga su resolver y su `@public`/`@auth`.
 */
export function buildGatewaySchema(runtime: GatewayRuntime): GraphQLSchema {
  const sdl = readFileSync(join(runtime.files.dir, GATEWAY_SDL), 'utf8');
  const plain = buildSchema(sdl);
  setProblemCodes(enumValues(plain, 'ProblemCode'));
  const { searchLimit } = runtime.config.security.rateLimit;
  const resolvers = createResolvers({
    scopes: enumValues(plain, 'Scope'),
    events: enumValues(plain, 'WebhookEventType'),
    bookingEvents: bookingEventsSubscriber(enumValues(plain, 'WebhookEventType'), runtime.config.subscriptionPollMs) as never,
    // Mismo límite que la fachada REST (PLAN.md §4.4): por X-Device-Fingerprint.
    checkSearchLimit: (fingerprint) => {
      const wait = fingerprint ? runtime.limiter.hit(`search:fp:${fingerprint}`, searchLimit) : undefined;
      if (wait !== undefined) throw problemError({ status: 429, code: 'RATE_LIMIT_EXCEEDED', title: 'Demasiadas búsquedas.', detail: `Reintente en ${wait} s.`, retryAfter: wait });
    },
  });
  const executable = makeExecutableSchema({ typeDefs: sdl, resolvers: { ...scalarResolvers, ...resolvers } });
  const unresolved: string[] = [];
  for (const root of [executable.getQueryType(), executable.getMutationType(), executable.getSubscriptionType()]) {
    if (!root || !isObjectType(root)) continue;
    for (const field of Object.values(root.getFields())) if (!field.resolve && !field.subscribe) unresolved.push(`${root.name}.${field.name}`);
  }
  if (unresolved.length) throw new Error(`gateway.graphql: campos sin resolver: ${unresolved.join(', ')}`);
  return applyDirectives(executable);
}

/** HTTP `401` (con `WWW-Authenticate`) si falta o no sirve el token en una operación protegida (contrato, TRANSPORTE). */
const unauthenticatedStatus: ApolloServerPlugin<GqlContext> = {
  async requestDidStart() {
    return {
      async willSendResponse({ response }) {
        const body = response.body;
        if (body.kind === 'single' && body.singleResult.errors?.some((error) => error.extensions?.['code'] === 'UNAUTHENTICATED')) {
          response.http.status = 401;
          response.http.headers.set('www-authenticate', 'Bearer');
        }
      },
    };
  },
};

type WsContext = { connectionParams?: Record<string, unknown>; extra?: { request?: { socket?: { remoteAddress?: string } } } };

/** Contexto de una operación: HTTP (`{ req }`) o una suscripción por graphql-ws (`connectionParams`). */
export function contextFactory(runtime: GatewayRuntime) {
  return async (arg: { req?: Request } & WsContext): Promise<GqlContext> => {
    if (arg && 'connectionParams' in arg) {
      const params = arg.connectionParams ?? {};
      const text = (name: string) => (typeof params[name] === 'string' ? (params[name] as string) : undefined);
      const authorization = text('authorization') ?? text('Authorization');
      const fingerprint = text('x-device-fingerprint');
      const incoming = text('x-correlation-id');
      const ip = arg.extra?.request?.socket?.remoteAddress;
      const auth = await authenticateUser(authorization, runtime.verifier);
      return { ...auth, ...(fingerprint ? { fingerprint } : {}), ...(ip ? { ip } : {}), correlationId: isValidId(incoming) ? incoming : newCorrelationId(), ms: new MsClient(runtime.upstreams, { ...(auth.token ? { token: auth.token } : {}), ...(fingerprint ? { fingerprint } : {}), ...(ip ? { ip } : {}) }) };
    }
    const request = arg.req!;
    const fingerprint = request.header('x-device-fingerprint');
    const ip = request.ip;
    const auth = await authenticateUser(request.header('authorization'), runtime.verifier);
    return { ...auth, ...(fingerprint ? { fingerprint } : {}), ...(ip ? { ip } : {}), ms: new MsClient(runtime.upstreams, { ...(auth.token ? { token: auth.token } : {}), ...(fingerprint ? { fingerprint } : {}), ...(ip ? { ip } : {}) }) };
  };
}

export function graphqlOptions(runtime: GatewayRuntime, schema: GraphQLSchema): ApolloDriverConfig {
  const logger = new Logger('GraphQL');
  return {
    driver: ApolloDriver,
    path: GRAPHQL_PATH,
    schema,
    // Sin la página de pruebas (carga scripts de un CDN); la introspección solo en desarrollo.
    graphiql: false,
    introspection: runtime.config.introspection,
    csrfPrevention: true,
    includeStacktraceInErrorResponses: false,
    // Los errores ya son ProblemDetails (errors.ts) y el status lo decide `unauthenticatedStatus`.
    autoTransformHttpErrors: false,
    preserveHttpStatusForExecutionErrors: false,
    validationRules: [depthLimit()],
    formatError: (formatted) => formatError(formatted, (message) => logger.error(message)),
    plugins: [complexityPlugin(() => schema), unauthenticatedStatus],
    context: contextFactory(runtime),
    subscriptions: {
      'graphql-ws': {
        path: GRAPHQL_PATH,
        // Sin un token de usuario válido no se abre la conexión (4403); los scopes los exige `@auth` en `subscribe`.
        onConnect: async (ctx: { connectionParams?: Record<string, unknown> }) => {
          const authorization = ctx.connectionParams?.['authorization'] ?? ctx.connectionParams?.['Authorization'];
          return !!(await authenticateUser(typeof authorization === 'string' ? authorization : undefined, runtime.verifier)).claims;
        },
      },
    },
  } as ApolloDriverConfig;
}

