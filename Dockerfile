# Dockerfile for ClapIA-Video

FROM node:20-alpine
WORKDIR /app

# Install build deps
COPY package.json package-lock.json* ./
RUN npm install --production

# Copy app
COPY . .

EXPOSE 3000
CMD ["npm", "start"]
