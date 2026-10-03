FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV DATA_DIR=/data NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
