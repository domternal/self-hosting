FROM node:22.23.2-alpine3.24@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node package.json index.mjs ./
USER node
EXPOSE 1260
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=5s --timeout=2s --start-period=5s --retries=10 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:1260/health',{signal:AbortSignal.timeout(1000)}).then((r)=>process.exit(r.status===200?0:1),()=>process.exit(1))"]
CMD ["node", "index.mjs"]
