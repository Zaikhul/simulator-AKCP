FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/akcp/package.json packages/akcp/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/akcpsim/package.json apps/akcpsim/package.json
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY packages packages
COPY apps apps
COPY config config
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV API_HOST=0.0.0.0
EXPOSE 3000
CMD ["node", "apps/api/src/index.js"]
