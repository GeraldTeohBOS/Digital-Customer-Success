FROM node:24-bookworm-slim
WORKDIR /app
COPY production/package.json production/package-lock.json production/
RUN npm --prefix production ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src/ src/
COPY visual/style.css visual/style.css
COPY production/*.mjs production/schema.sql production/
COPY production/public/ production/public/
ENV NODE_ENV=production PORT=8080
USER node
EXPOSE 8080
CMD ["node", "production/server.mjs"]
