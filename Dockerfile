FROM node:22-alpine

RUN apk add --no-cache iptables ca-certificates bash shadow

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY src/ ./src/
COPY handler.ts tsconfig.json ./
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
