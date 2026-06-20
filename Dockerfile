FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV PORT=4000
EXPOSE 4000

CMD ["node", "server.js"]
