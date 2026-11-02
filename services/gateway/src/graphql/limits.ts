import type { ApolloServerPlugin } from '@apollo/server';
import {
  type ASTVisitor,
  type FragmentDefinitionNode,
  GraphQLError,
  type GraphQLSchema,
  Kind,
  type OperationDefinitionNode,
  type SelectionSetNode,
  type ValidationContext,
} from 'graphql';
import { type ComplexityEstimatorArgs, getComplexity, simpleEstimator } from 'graphql-query-complexity';
import { problemError } from './errors.js';

/** Contrato `gateway.graphql`, TRANSPORTE: profundidad máxima 10 y complejidad máxima 1000. */
export const MAX_DEPTH = 10;
export const MAX_COMPLEXITY = 1000;

/** Profundidad de un documento (los fragmentos se expanden; un ciclo de fragmentos ya lo rechaza graphql-js). */
export function depthLimit(max = MAX_DEPTH) {
  return (context: ValidationContext): ASTVisitor => {
    const fragments = new Map<string, FragmentDefinitionNode>();
    for (const definition of context.getDocument().definitions) if (definition.kind === Kind.FRAGMENT_DEFINITION) fragments.set(definition.name.value, definition);
    const depthOf = (set: SelectionSetNode | undefined, depth: number, seen: Set<string>): number => {
      if (!set) return depth;
      let deepest = depth;
      for (const selection of set.selections) {
        if (selection.kind === Kind.FIELD) {
          // Los campos de introspección (__typename, __schema) no cuentan.
          if (selection.name.value.startsWith('__')) continue;
          deepest = Math.max(deepest, depthOf(selection.selectionSet, depth + 1, seen));
        } else if (selection.kind === Kind.INLINE_FRAGMENT) {
          deepest = Math.max(deepest, depthOf(selection.selectionSet, depth, seen));
        } else {
          const name = selection.name.value;
          if (seen.has(name)) continue;
          deepest = Math.max(deepest, depthOf(fragments.get(name)?.selectionSet, depth, new Set([...seen, name])));
        }
      }
      return deepest;
    };
    return {
      OperationDefinition(node: OperationDefinitionNode) {
        const depth = depthOf(node.selectionSet, 0, new Set());
        if (depth > max) context.reportError(new GraphQLError(`La consulta tiene profundidad ${depth}; el máximo es ${max}.`, { nodes: [node] }));
      },
    };
  };
}

/** Una lista con `limit` cuesta `limit` veces lo que se pide de cada elemento. */
const limitEstimator = ({ args, childComplexity }: ComplexityEstimatorArgs): number | void => {
  const limit = args['limit'];
  if (typeof limit === 'number' && limit > 0) return 1 + limit * Math.max(childComplexity, 1);
};

/** La complejidad se calcula con las variables ya conocidas (por eso es un plugin y no una regla de validación). */
export function complexityPlugin(schema: () => GraphQLSchema, max = MAX_COMPLEXITY): ApolloServerPlugin {
  return {
    async requestDidStart() {
      return {
        async didResolveOperation({ request, document }) {
          const complexity = getComplexity({ schema: schema(), query: document, variables: request.variables ?? {}, ...(request.operationName ? { operationName: request.operationName } : {}), estimators: [limitEstimator, simpleEstimator({ defaultComplexity: 1 })] });
          if (complexity > max) {
            const error = problemError({ status: 400, code: 'VALIDATION_FAILED', title: `La consulta tiene complejidad ${complexity}; el máximo es ${max}.` });
            // `extensions.http` fija el status HTTP (Apollo lo quita de la respuesta): el documento se rechaza con 400.
            throw new GraphQLError(error.message, { extensions: { ...error.extensions, http: { status: 400 } } });
          }
        },
      };
    },
  };
}
