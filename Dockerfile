# Debian 12 (bookworm) ships glibc 2.36; @roamhq/wrtc's native binary requires
# GLIBC >= 2.34, so bullseye (glibc 2.31) fails to load it at runtime.
FROM node:18-bookworm

WORKDIR /app

# Copy only package.json (not a lockfile) and resolve fresh in the image.
COPY package.json ./

RUN npm install

# npm 10 non-deterministically skips the platform-specific optional dependency
# (npm/cli#4828): @roamhq/wrtc-<platform>-<arch> ends up recorded-but-not-installed,
# and `npm install <pkg>` then reports "up to date" without placing the binary.
# Bypass npm — download the matching binary tarball and extract it into node_modules.
RUN PKG="@roamhq/wrtc-$(node -p process.platform)-$(node -p process.arch)" && \
    V=$(node -p "require('@roamhq/wrtc/package.json').version") && \
    F=$(npm pack "$PKG@$V" 2>/dev/null | tail -1) && \
    mkdir -p "node_modules/$PKG" && \
    tar -xzf "$F" -C "node_modules/$PKG" --strip-components=1 && \
    rm -f "$F" && \
    test -f "node_modules/$PKG/wrtc.node"

COPY . .

EXPOSE 19000

CMD ["node", "server.js"]
