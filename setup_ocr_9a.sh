#!/bin/bash
# =============================================================================
# DockerOCR Backend Setup Script
# Version: 2.0.0
#
# This script sets up and deploys a production-ready PaddleOCR REST API
# with best practices for security, reliability, and performance.
# =============================================================================

set -euo pipefail  # Exit on error, undefined vars, pipe failures

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------
readonly IMAGE_NAME="swipswaps/paddleocr"
readonly CONTAINER_NAME="dockerocr-backend"
readonly PORT=5000
readonly HEALTH_TIMEOUT=90
readonly HEALTH_INTERVAL=5

# Colors for output
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly NC='\033[0m' # No Color

# -----------------------------------------------------------------------------
# Helper Functions
# -----------------------------------------------------------------------------
log_info() { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_success() { echo -e "${GREEN}✅ $1${NC}"; }
log_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
log_error() { echo -e "${RED}❌ $1${NC}" >&2; }

check_requirements() {
    log_info "Checking requirements..."

    if ! command -v docker &> /dev/null; then
        log_error "Docker is not installed. Please install Docker first."
        exit 1
    fi

    if ! docker info &> /dev/null; then
        log_error "Docker daemon is not running. Please start Docker."
        exit 1
    fi

    log_success "Docker is available"
}

cleanup_port() {
    log_info "Cleaning up port ${PORT}..."

    # Stop container by name if exists
    if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        log_info "Stopping existing container: ${CONTAINER_NAME}"
        docker stop "${CONTAINER_NAME}" 2>/dev/null || true
        docker rm "${CONTAINER_NAME}" 2>/dev/null || true
    fi

    # Stop any container using the port
    local conflict_id
    conflict_id=$(docker ps -q --filter "publish=${PORT}" 2>/dev/null || echo "")
    if [ -n "$conflict_id" ]; then
        log_warning "Found container using port ${PORT}: $conflict_id"
        docker stop "$conflict_id" 2>/dev/null || true
        docker rm "$conflict_id" 2>/dev/null || true
    fi

    # Give the port time to be released
    sleep 2
    log_success "Port ${PORT} is clear"
}

wait_for_health() {
    log_info "Waiting for service to be healthy (timeout: ${HEALTH_TIMEOUT}s)..."

    local elapsed=0
    while [ $elapsed -lt $HEALTH_TIMEOUT ]; do
        # Check if container is still running
        if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
            log_error "Container stopped unexpectedly. Check logs with: docker logs ${CONTAINER_NAME}"
            return 1
        fi

        # Check health endpoint
        if curl -sf "http://localhost:${PORT}/health" > /dev/null 2>&1; then
            log_success "Service is healthy!"
            return 0
        fi

        sleep $HEALTH_INTERVAL
        elapsed=$((elapsed + HEALTH_INTERVAL))
        echo -n "."
    done

    echo ""
    log_warning "Health check timed out. Service may still be initializing."
    log_info "Check container logs: docker logs ${CONTAINER_NAME}"
    return 1
}

# -----------------------------------------------------------------------------
# Main Setup
# -----------------------------------------------------------------------------
main() {
    echo ""
    echo "======================================================================"
    echo "  🚀 DockerOCR Backend Setup"
    echo "======================================================================"
    echo ""

    check_requirements

    # 1. Create requirements.txt
    log_info "Creating requirements.txt..."
    cat <<'EOF' > requirements.txt
# DockerOCR Backend Dependencies
# Pinned versions for reproducible builds

# Web framework
flask==3.0.0
flask-cors==4.0.0
gunicorn==21.2.0

# PaddleOCR and dependencies
paddlepaddle==2.6.2
paddleocr==2.7.3
opencv-python-headless==4.8.1.78

# NumPy 2.x compatibility issues with PaddlePaddle
numpy>=1.21.0,<2.0.0
EOF
    log_success "requirements.txt created"

    # 2. Create Dockerfile
    log_info "Creating Dockerfile..."
    cat <<'EOF' > Dockerfile
# DockerOCR Backend - Production Dockerfile
# Uses multi-stage build, non-root user, and gunicorn for production

FROM python:3.9-slim AS base

# Prevent Python from writing pyc files and buffering stdout/stderr
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Install system dependencies required by PaddleOCR and OpenCV
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    libgeos-dev \
    curl \
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
CMD ["gunicorn", \
     "--bind", "0.0.0.0:5000", \
     "--workers", "1", \
     "--timeout", "120", \
     "--graceful-timeout", "30", \
     "--access-logfile", "-", \
     "--error-logfile", "-", \
     "--capture-output", \
     "app:app"]
EOF
    log_success "Dockerfile created"

    # 3. Create .dockerignore
    log_info "Creating .dockerignore..."
    cat <<'EOF' > .dockerignore
# Version control
.git
.gitignore

# Development files
*.md
*.sh
.vscode/
.idea/

# Python cache
__pycache__/
*.py[cod]
*$py.class
.pytest_cache/
.mypy_cache/

# Virtual environments
venv/
.venv/
env/

# OS files
.DS_Store
Thumbs.db

# Node (if any frontend)
node_modules/
dist/
EOF
    log_success ".dockerignore created"

    # 4. Build Docker image
    echo ""
    log_info "Building Docker image: ${IMAGE_NAME}..."
    log_info "This may take 5-10 minutes on first build..."
    echo ""

    if docker build -t "${IMAGE_NAME}" .; then
        log_success "Docker image built successfully"
    else
        log_error "Failed to build Docker image"
        exit 1
    fi

    # 5. Clean up and run
    cleanup_port

    echo ""
    log_info "Starting container: ${CONTAINER_NAME}..."

    docker run -d \
        -p "${PORT}:5000" \
        --name "${CONTAINER_NAME}" \
        --restart unless-stopped \
        --memory="2g" \
        --cpus="2" \
        "${IMAGE_NAME}"

    log_success "Container started"

    # 6. Wait for health check
    echo ""
    if wait_for_health; then
        echo ""
        echo "======================================================================"
        echo -e "  ${GREEN}🎉 DockerOCR Backend is ready!${NC}"
        echo "======================================================================"
        echo ""
        echo "  Endpoints:"
        echo "    - Health:  http://localhost:${PORT}/health"
        echo "    - OCR:     http://localhost:${PORT}/ocr (POST with 'file' field)"
        echo ""
        echo "  Commands:"
        echo "    - View logs:     docker logs -f ${CONTAINER_NAME}"
        echo "    - Stop:          docker stop ${CONTAINER_NAME}"
        echo "    - Restart:       docker restart ${CONTAINER_NAME}"
        echo ""
        echo "  Test with:"
        echo "    curl -X POST -F 'file=@test.png' http://localhost:${PORT}/ocr"
        echo ""
    else
        echo ""
        log_warning "Container started but health check didn't pass yet."
        log_info "The service may still be initializing (downloading models)."
        log_info "Check status with: docker logs -f ${CONTAINER_NAME}"
    fi
}

# Run main function
main "$@"
