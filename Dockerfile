FROM node:18
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
# Порт 10000 стандартный для Render
EXPOSE 10000
CMD ["node", "index.js"]
