FROM node:18-alpine

WORKDIR /app

# Копируем package.json
COPY package*.json ./

# Используем npm install вместо npm ci
RUN npm install --omit=dev

# Копируем весь код
COPY . .

# Создаем папку для логов
RUN mkdir -p /app/logs

# Переменные окружения
ENV NODE_ENV=production
ENV PORT=10000

# Expose порт
EXPOSE 10000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:10000', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Запуск бота
CMD ["node", "bot.js"]
