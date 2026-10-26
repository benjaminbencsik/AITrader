FROM node:22-alpine
WORKDIR /app
COPY server ./server
COPY public ./public
COPY scripts ./scripts
COPY package.json ./
ENV HOST=0.0.0.0 PORT=8080 DATA_DIR=/data
VOLUME /data
EXPOSE 8080
CMD ["node", "server/index.js"]
