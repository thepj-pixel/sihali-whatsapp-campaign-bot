FROM node:20-slim

# Install git for dependencies
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency definitions
COPY package*.json ./

# Install packages
RUN npm install

# Copy application source
COPY . .

# Hugging Face Spaces default port
ENV PORT=7860
EXPOSE 7860

CMD ["node", "server.js"]
