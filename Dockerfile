FROM node:24-bookworm-slim AS web-build

WORKDIR /app/app

COPY app/package.json app/package-lock.json ./
RUN npm ci

COPY app/ ./
RUN npm run build

FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . ./
COPY --from=web-build /app/public ./public

CMD ["npm", "start"]
