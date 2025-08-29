#!/usr/bin/env bash
# This is for apple M2 development, maybe can be used on other platforms
set -e

apt-get update && apt-get install -y \
    chromium \
    chromium-common \
    chromium-driver \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    wget \
    unzip \
    && rm -rf /var/lib/apt/lists/*
    
# 驗證
chromium --version
