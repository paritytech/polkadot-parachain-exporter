FROM docker.io/node:16-bullseye-slim

RUN apt-get update && \
    apt-get install -y curl jq lsb-release tini

RUN groupadd --gid 10001 nonroot && \
    useradd  --home-dir /app \
             --create-home \
             --shell /bin/bash \
             --gid nonroot \
             --groups nonroot \
             --uid 10000 nonroot

COPY . /app
WORKDIR /app
RUN yarn install && \
    yarn build

USER 10000:10001
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["yarn", "start"]
