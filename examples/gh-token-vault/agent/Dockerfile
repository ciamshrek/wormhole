FROM node:24-alpine

RUN apk add --no-cache github-cli \
      --repository=https://dl-cdn.alpinelinux.org/alpine/edge/community

WORKDIR /agent
COPY package.json ./
RUN npm install
COPY agent.ts ./

RUN apk add --no-cache ca-certificates
CMD ["/etc/mwh/wormhole-ca-init.sh", "npx", "tsx", "agent.ts"]
