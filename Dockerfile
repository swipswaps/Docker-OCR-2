# DockerOCR Backend - Production Dockerfile
# Uses multi-stage build, non-root user, and gunicorn for production

FROM python:3.9-slim AS base

# Prevent Python from writing pyc files and buffering stdout/stderr
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Install system dependencies required by PaddleOCR, OpenCV, and Tesseract OSD
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    libgeos-dev \
    curl \
    tesseract-ocr \
    tesseract-ocr-osd \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Create non-root user for security
RUN groupadd --gid 1000 appgroup \
    && useradd --uid 1000 --gid appgroup --shell /bin/bash --create-home appuser

WORKDIR /app

# Install Python dependencies first (better layer caching)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY app.py .

# Create PaddleOCR cache directory with proper permissions
# Models will be downloaded on first run
RUN mkdir -p /home/appuser/.paddleocr \
    && chown -R appuser:appgroup /home/appuser/.paddleocr \
    && chown -R appuser:appgroup /app

# Switch to non-root user
USER appuser

# Set PaddleOCR home to user's home directory
ENV HOME=/home/appuser

# Expose the application port
EXPOSE 5000

# Health check - verify the service is responding
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=5 \
    CMD curl --fail http://localhost:5000/health || exit 1

# Production server with gunicorn
# - 1 worker (PaddleOCR is memory-intensive, single worker is safer)
# - 120s timeout for long OCR operations
# - graceful timeout for clean shutdowns
# - log-level info to show app logs
CMD ["gunicorn", \
     "--bind", "0.0.0.0:5000", \
     "--workers", "1", \
     "--timeout", "120", \
     "--graceful-timeout", "30", \
     "--log-level", "info", \
     "--access-logfile", "-", \
     "--error-logfile", "-", \
     "--capture-output", \
     "app:app"]
