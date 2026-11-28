# Hosted task store. From the repository root, first bundle, then build:
#   bun build packages/harnessy-core/src/jarvis/tasks/service-main.ts \
#     --outfile packages/harnessy-core/tasks-service/tasks-service.js \
#     --target=node --packages=bundle
#   docker build -f packages/harnessy-core/tasks-service/Dockerfile \
#     -t harnessy-tasks:local packages/harnessy-core/tasks-service
FROM node:22-alpine
RUN addgroup -S harnessy && adduser -S harnessy -G harnessy
WORKDIR /app
COPY tasks-service.js /app/tasks-service.js
RUN mkdir -p /data && chown -R harnessy:harnessy /data /app
USER harnessy
ENV HOST=0.0.0.0
ENV PORT=8787
ENV TASKS_FILE=/data/tasks.json
# Priority batches are off by default. To enable them, explicitly set
# TASKS_ENABLE_PRIORITY_BATCH=1 in the VPS service configuration.
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "tasks-service.js"]
