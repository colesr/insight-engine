FROM python:3.11-slim

WORKDIR /app

RUN pip install --no-cache-dir fastapi uvicorn[standard] requests aiohttp pandas numpy

COPY . .

# Copy feature-complete working app versions into static/
RUN cp app_v32.js static/app_v32.js && cp app_v33.js static/app_v33.js

EXPOSE 7860

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "7860", "--workers", "2"]
