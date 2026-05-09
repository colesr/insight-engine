FROM python:3.11-slim

WORKDIR /app

RUN pip install --no-cache-dir fastapi uvicorn[standard] requests aiohttp pandas numpy

COPY . .

# Copy the last known-good app version into static/
RUN cp app_v30.js static/app_v30.js && cp app_v31.js static/app_v31.js

EXPOSE 7860

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "7860", "--workers", "2"]
