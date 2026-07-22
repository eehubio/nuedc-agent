# 第一阶段构建镜像：真实 gcc 语法/类型/最小链接验证
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      gcc-arm-none-eabi binutils-arm-none-eabi libnewlib-arm-none-eabi \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .
# 用法：docker run -e BASE_URL -e ADMIN_API_KEY image npm run build:runner
CMD ["npx", "tsx", "scripts/build-runner.mts"]
