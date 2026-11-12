import { getDirective, MapperKind, mapSchema } from '@graphql-tools/utils';
import {
  defaultFieldResolver,
  getNamedType,
  type GraphQLArgument,
  type GraphQLFieldConfig,
  type GraphQLInputField,
  
  type GraphQLInputType,
  GraphQLList,
  GraphQLNonNull,
  type GraphQLSchema,
  isInputObjectType,
} from 'graphql';
import type { InvalidParam } from '@ecoairlines/shared';
import { type GqlContext, requireUser } from './context.js';
import { invalidInput } from './errors.js';

/**
 * Directivas de `gateway.graphql`:
 * - `@auth(scopes)`: token de usuario con TODOS los scopes (los valores del enum `Scope`, p. ej. `FLIGHTS_READ` = `flights:read`).
 * - `@public`: sin autenticación.
 * - `@constraint`: `pattern`, `minimum`, `maximum`, `minItems`, `maxItems` de argumentos y campos de input, validados antes del
 *   resolver; el error lleva los nombres de GraphQL (`input.passengers[0].documentNumber`).
 * - `@idempotent`: la mutation tiene `idempotencyKey: UUID!` (se comprueba al arrancar; el resolver la envía como `Idempotency-Key`).
 * Al arrancar se exige que cada campo de Query, Mutation y Subscription declare `@public` o `@auth`.
 */
export const scopeOf = (value: string) => value.toLowerCase().replace('_', ':');

interface Constraint {
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}

type Checker = (value: unknown, path: string, problems: InvalidParam[]) => void;

function constraintOf(schema: GraphQLSchema, node: GraphQLArgument | GraphQLInputField): Constraint | undefined {
  return getDirective(schema, node, 'constraint')?.[0] as Constraint | undefined;
}

/** Arma (una vez) el validador de un tipo de input, con las restricciones del argumento o del campo que lo contiene. */
function checkerFor(schema: GraphQLSchema, type: GraphQLInputType, constraint: Constraint | undefined, cache: Map<string, Checker>): Checker {
  const inner = type instanceof GraphQLNonNull ? type.ofType : type;
  if (inner instanceof GraphQLList) {
    const item = checkerFor(schema, inner.ofType, undefined, cache);
    return (value, path, problems) => {
      if (!Array.isArray(value)) return;
      if (constraint?.minItems !== undefined && value.length < constraint.minItems) problems.push({ name: path, reason: `al menos ${constraint.minItems} elemento(s)` });
      if (constraint?.maxItems !== undefined && value.length > constraint.maxItems) problems.push({ name: path, reason: `como máximo ${constraint.maxItems} elemento(s)` });
      value.forEach((entry, index) => item(entry, `${path}[${index}]`, problems));
    };
  }
  if (isInputObjectType(inner)) {
    // Los tipos de input pueden ser recursivos: se registra antes de armar sus campos.
    const cached = cache.get(inner.name);
    if (cached) return cached;
    const fields: [string, Checker][] = [];
    const checker: Checker = (value, path, problems) => {
      if (!value || typeof value !== 'object') return;
      for (const [name, check] of fields) check((value as Record<string, unknown>)[name], `${path}.${name}`, problems);
    };
    cache.set(inner.name, checker);
    for (const field of Object.values((inner).getFields())) fields.push([field.name, checkerFor(schema, field.type, constraintOf(schema, field), cache)]);
    return checker;
  }
  if (!constraint) return () => undefined;
  const pattern = constraint.pattern ? new RegExp(constraint.pattern, 'u') : undefined;
  return (value, path, problems) => {
    if (value === null || value === undefined) return;
    if (pattern && typeof value === 'string' && !pattern.test(value)) problems.push({ name: path, reason: `no cumple el patrón ${constraint.pattern}` });
    if (typeof value === 'number') {
      if (constraint.minimum !== undefined && value < constraint.minimum) problems.push({ name: path, reason: `mínimo ${constraint.minimum}` });
      if (constraint.maximum !== undefined && value > constraint.maximum) problems.push({ name: path, reason: `máximo ${constraint.maximum}` });
    }
  };
}

const ROOTS = ['Query', 'Mutation', 'Subscription'];

export function applyDirectives(schema: GraphQLSchema): GraphQLSchema {
  const cache = new Map<string, Checker>();
  const problems: string[] = [];
  const mapped = mapSchema(schema, {
    [MapperKind.OBJECT_FIELD]: (field: GraphQLFieldConfig<unknown, GqlContext>, fieldName, typeName) => {
      const auth = getDirective(schema, field, 'auth')?.[0] as { scopes: string[] } | undefined;
      const isPublic = !!getDirective(schema, field, 'public')?.length;
      const idempotent = !!getDirective(schema, field, 'idempotent')?.length;
      if (ROOTS.includes(typeName) && !auth && !isPublic) problems.push(`${typeName}.${fieldName} no declara @public ni @auth`);
      if (idempotent && !(field.args?.['idempotencyKey'] && field.args['idempotencyKey'].type instanceof GraphQLNonNull && getNamedType(field.args['idempotencyKey'].type).name === 'UUID')) {
        problems.push(`${typeName}.${fieldName} es @idempotent sin idempotencyKey: UUID!`);
      }
      const argumentCheckers = Object.entries(field.args ?? {}).map(([name, arg]) => [name, checkerFor(schema, arg.type, getDirective(schema, arg as unknown as GraphQLArgument, 'constraint')?.[0] as Constraint | undefined, cache)] as const);
      const scopes = (auth?.scopes ?? []).map(scopeOf);
      const guard = (args: Record<string, unknown>, context: GqlContext) => {
        if (auth) requireUser(context, scopes);
        const invalid: InvalidParam[] = [];
        for (const [name, check] of argumentCheckers) check(args[name], name, invalid);
        if (invalid.length) throw invalidInput(invalid);
      };
      const resolve = field.resolve ?? defaultFieldResolver;
      const wrapped: GraphQLFieldConfig<unknown, GqlContext> = {
        ...field,
        resolve: (source, args, context, info) => {
          // En una suscripción, la autorización ya ocurrió en `subscribe`; `resolve` solo entrega el evento.
          if (typeName !== 'Subscription') guard(args, context);
          return resolve(source, args, context, info);
        },
      };
      if (field.subscribe) {
        const subscribe = field.subscribe;
        wrapped.subscribe = (source, args, context, info) => {
          guard(args, context);
          return subscribe(source, args, context, info);
        };
      }
      return wrapped;
    },
  });
  if (problems.length) throw new Error(`gateway.graphql no cumple sus reglas:\n - ${problems.join('\n - ')}`);
  return mapped;
}
