FROM alpine

RUN apk add --no-cache github-cli \
      --repository=https://dl-cdn.alpinelinux.org/alpine/edge/community

COPY run.sh /run.sh
RUN chmod +x /run.sh

CMD ["/run.sh"]
