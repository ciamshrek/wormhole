FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install

COPY client.ts ./

CMD ["npx", "tsx", "client.ts"]
