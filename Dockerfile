FROM node:24-alpine

ENV NODE_ENV=production \
    WB_PRIVATE_DATA=/data \
    WB_PRIVATE_BIND=0.0.0.0 \
    WB_PRIVATE_PORT=8792

WORKDIR /app
COPY package.json ./
COPY src ./src

RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 8792
CMD ["node", "src/index.js"]
