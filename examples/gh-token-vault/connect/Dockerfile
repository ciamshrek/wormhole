FROM node:24-alpine

WORKDIR /connect
COPY package.json ./
RUN npm install
COPY connect.ts ./

CMD ["node", "connect.ts"]
