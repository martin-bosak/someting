FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci
COPY . .
ARG BUILD_COMMAND=""
RUN if [ -n "$BUILD_COMMAND" ]; then sh -lc "$BUILD_COMMAND"; fi
ENV START_COMMAND="npm start"
EXPOSE 8080
CMD ["sh", "-lc", "$START_COMMAND"]
