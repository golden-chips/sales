# GOLDEN ERP web — built once, served by nginx, which also proxies /api to the API container.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ARG VITE_API_BASE=""
ENV VITE_API_BASE=$VITE_API_BASE
# company code for a server that serves one company (e.g. erp.golden-chips.ly): users then sign in with email + password only
ARG VITE_DEFAULT_TENANT=""
ENV VITE_DEFAULT_TENANT=$VITE_DEFAULT_TENANT
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
