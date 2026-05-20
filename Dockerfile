FROM python:3.11-slim

WORKDIR /app

RUN pip install --no-cache-dir fastapi uvicorn[standard] requests aiohttp pandas numpy feedparser vaderSentiment

COPY . .

RUN cp app_v31.js static/app_v31.js || true

EXPOSE 7860

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "7860", "--workers", "2"]
