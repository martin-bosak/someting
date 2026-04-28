FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ARG BUILD_COMMAND="npm run build"
RUN sh -lc "$BUILD_COMMAND"

FROM caddy:2-alpine
COPY --from=build /app/dist /srv
EXPOSE 8080
CMD ["caddy", "file-server", "--listen", ":8080", "--root", "/srv"]
