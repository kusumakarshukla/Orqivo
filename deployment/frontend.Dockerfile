FROM node:24-slim AS dependencies
WORKDIR /workspace
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY artifacts/api-server/package.json ./artifacts/api-server/package.json
COPY artifacts/mockup-sandbox/package.json ./artifacts/mockup-sandbox/package.json
COPY artifacts/windows-automation-portal/package.json ./artifacts/windows-automation-portal/package.json
COPY lib/api-client-react/package.json ./lib/api-client-react/package.json
COPY lib/api-spec/package.json ./lib/api-spec/package.json
COPY lib/api-zod/package.json ./lib/api-zod/package.json
COPY lib/db/package.json ./lib/db/package.json
COPY scripts/package.json ./scripts/package.json
RUN pnpm install --frozen-lockfile

FROM dependencies AS development
COPY lib ./lib
COPY artifacts/windows-automation-portal ./artifacts/windows-automation-portal
ENV BASE_PATH=/
EXPOSE 3000
CMD ["pnpm", "--filter", "@workspace/windows-automation-portal", "run", "dev"]

FROM dependencies AS build
COPY lib ./lib
COPY artifacts/windows-automation-portal ./artifacts/windows-automation-portal
RUN PORT=5173 BASE_PATH=/ pnpm --filter @workspace/windows-automation-portal run build

FROM nginx:1.27-alpine AS production
COPY --from=build /workspace/artifacts/windows-automation-portal/dist/public /usr/share/nginx/html
COPY deployment/nginx/default.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
