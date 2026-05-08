FROM python:3.11-slim

WORKDIR /app

RUN pip install --no-cache-dir fastapi uvicorn[standard] requests aiohttp pandas numpy

COPY . .

# Copy root JS files into static/ so they are served
RUN cp app_v34.js static/ && cp globe_patch.js static/ && cp coastline_loader.js static/

EXPOSE 7860

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "7860", "--workers", "2"]
