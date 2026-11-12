# Imagen de cualquier servicio NestJS del monorepo (V2.2). Se construye desde la raíz del repositorio:
#   docker build -f infra/docker/node-service.Dockerfile --build-arg SERVICE_DIR=services/externos/booking-simulado .
# Etapa 1 instala las dependencias del servicio y de packages/shared, y compila ambos. Etapa 2 solo copia lo necesario y
# corre como usuario sin privilegios.
FROM node:26.12.1-alpine AS build
ARG SERVICE_DIR
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY ${SERVICE_DIR}/package.json ${SERVICE_DIR}/
RUN npm ci --no-audit --no-fund --workspace packages/shared --workspace ${SERVICE_DIR} --include-workspace-root=false
COPY packages/shared packages/shared
COPY ${SERVICE_DIR} ${SERVICE_DIR}
# TypeScript es dependencia de desarrollo de la raíz (que no se instala aquí): se usa la misma versión del repositorio.
RUN npm exec --yes --package=typescript@6.0.3 -- tsc -b ${SERVICE_DIR} \
 && npm prune --omit=dev --workspace packages/shared --workspace ${SERVICE_DIR} --include-workspace-root=false

FROM node:26.12.1-alpine
ARG SERVICE_DIR
ENV NODE_ENV=production SERVICE_DIR=${SERVICE_DIR}
WORKDIR /repo
COPY --from=build /repo/node_modules node_modules
COPY --from=build /repo/packages/shared/package.json packages/shared/
COPY --from=build /repo/packages/shared/dist packages/shared/dist
COPY --from=build /repo/${SERVICE_DIR}/package.json ${SERVICE_DIR}/
COPY --from=build /repo/${SERVICE_DIR}/dist ${SERVICE_DIR}/dist
# Los contratos que el servicio lee en tiempo de ejecución (p. ej. booking-inventory.proto para gRPC).
COPY contract contract
USER node
CMD ["sh", "-c", "node --enable-source-maps ${SERVICE_DIR}/dist/main.js"]
