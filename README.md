# DockerOCR Backend

A production-ready OCR (Optical Character Recognition) REST API powered by [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR), Flask, and Docker.

[![Docker](https://img.shields.io/badge/Docker-Ready-blue?logo=docker)](https://www.docker.com/)
[![Python](https://img.shields.io/badge/Python-3.9-green?logo=python)](https://www.python.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

## Features

- 🔍 **Accurate OCR** - Uses PaddleOCR v2.7 with angle classification for robust text detection
- 🚀 **Production Ready** - Gunicorn WSGI server, health checks, graceful shutdowns
- 🔒 **Secure** - Non-root Docker user, file validation, CORS configuration
- 📦 **Easy Deployment** - Single script setup, Docker containerized
- 📊 **Detailed Output** - Returns text, confidence scores, and bounding boxes

## Quick Start

### Option 1: One-Command Setup

```bash
./setup_ocr_9a.sh
```

This script will:
1. Create all necessary files (`requirements.txt`, `Dockerfile`, `app.py`)
2. Build the Docker image
3. Start the container on port 5000
4. Wait for health check confirmation

### Option 2: Manual Setup

```bash
# Build the Docker image
docker build -t swipswaps/paddleocr .

# Run the container
docker run -d -p 5000:5000 --name dockerocr-backend swipswaps/paddleocr

# Wait ~2 minutes for model download on first run
```

## API Endpoints

### Health Check

```bash
curl http://localhost:5000/health
```

**Response:**
```json
{
  "status": "healthy",
  "service": "paddleocr",
  "version": "1.0.0"
}
```

### OCR Processing

```bash
curl -X POST -F "file=@image.png" http://localhost:5000/ocr
```

**Response:**
```json
{
  "success": true,
  "text": "Hello World!",
  "confidence": 0.95,
  "block_count": 1,
  "blocks": [
    {
      "text": "Hello World!",
      "confidence": 0.95,
      "bbox": [[20, 30], [150, 30], [150, 50], [20, 50]]
    }
  ]
}
```

### Supported Image Formats

- PNG, JPG, JPEG, GIF, BMP, WebP, TIFF

### File Size Limit

- Maximum: 16 MB

## Docker Commands

```bash
# View logs
docker logs -f dockerocr-backend

# Stop the service
docker stop dockerocr-backend

# Restart the service
docker restart dockerocr-backend

# Remove the container
docker rm -f dockerocr-backend
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `MAX_CONTENT_LENGTH` | 16 MB | Maximum upload file size |
| `WORKERS` | 1 | Gunicorn worker count |

## Project Structure

```
├── app.py              # Flask application with OCR endpoints
├── Dockerfile          # Production Docker configuration
├── requirements.txt    # Python dependencies
├── setup_ocr_9a.sh     # Automated setup script (latest)
├── setup_ocr_*.sh      # Previous setup script versions
└── .dockerignore       # Docker build exclusions
```

## Requirements

- Docker 20.10+
- ~2GB disk space (for PaddleOCR models)
- ~2GB RAM recommended

## First Run Note

⚠️ **First startup takes ~2 minutes** as PaddleOCR downloads required models (~15MB). Subsequent starts are instant.

## Error Handling

| Error | HTTP Code | Description |
|-------|-----------|-------------|
| No file uploaded | 400 | Missing `file` field in form data |
| Invalid file type | 400 | Unsupported image format |
| File too large | 413 | Exceeds 16 MB limit |
| Engine not ready | 503 | OCR engine still initializing |

## Tech Stack

- **OCR Engine**: [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) v2.7.3
- **Framework**: Flask 3.0
- **WSGI Server**: Gunicorn 21.2
- **Container**: Python 3.9-slim

## License

MIT License - See [LICENSE](LICENSE) for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

