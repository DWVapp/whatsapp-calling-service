FROM --platform=linux/amd64 node:18-bullseye

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @mapbox/node-pre-gyp

WORKDIR /app

# Copy only package.json (not package-lock.json): a lockfile generated on
# another platform (e.g. macOS-arm64) makes npm skip the linux @roamhq/wrtc
# binary — the cross-platform optional-dependency bug. Resolving fresh here
# installs @roamhq/wrtc-linux-x64 for this image.
COPY package.json ./

RUN npm install

# Fail the build early (not at runtime) if the native wrtc binary is missing.
RUN node -e "require('@roamhq/wrtc'); console.log('wrtc native binary OK')"

COPY . .

EXPOSE 19000

CMD ["node", "server.js"]
