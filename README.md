# DockerOCR Backend

A production-ready OCR (Optical Character Recognition) REST API powered by [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR), Flask, and Docker.

[![Docker](https://img.shields.io/badge/Docker-Ready-blue?logo=docker)](https://www.docker.com/)
[![Python](https://img.shields.io/badge/Python-3.9-green?logo=python)](https://www.python.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

## Features

- 🔍 **Accurate OCR** - Uses PaddleOCR v2.7 with angle classification for robust text detection
- 📊 **Table Structure Detection** - OpenCV morphology-based table/grid detection
- 📝 **Verbatim Logging** - Real-time step-by-step processing logs returned in API response
- 🚀 **Production Ready** - Gunicorn WSGI server, health checks, graceful shutdowns
- 🔒 **Secure** - Non-root Docker user, file validation, CORS configuration
- 📦 **Easy Deployment** - Single script setup, Docker containerized
- 📊 **Detailed Output** - Returns text, confidence scores, bounding boxes, and table structure

## OCR Processing Pipeline

The OCR endpoint processes images through a 6-step pipeline. Each step is logged with timing information and returned in the API response for full transparency.

### Step 1: Read File Bytes
**Tool:** Python `file.read()`

Reads the uploaded file into memory and validates it's not empty.

```
[STEP 1/6] Read 16250883 bytes (15.50MB) in 0.03s
```

### Step 2: Decode Image
**Tool:** OpenCV `cv2.imdecode()`

Converts raw bytes into a NumPy array (BGR color format) for processing.

```
[STEP 2/6] Decoded image: 4032x3024 pixels in 0.58s
```

### Step 3: Detect Table Structure
**Tool:** OpenCV Morphology Operations

Uses adaptive thresholding and morphological operations to detect horizontal and vertical lines that form table grids:

1. Convert to grayscale
2. Apply adaptive threshold (Gaussian, inverted)
3. Detect horizontal lines with `cv2.morphologyEx()` using a wide rectangular kernel (40×1)
4. Detect vertical lines with a tall rectangular kernel (1×40)
5. Combine masks and find contours
6. Filter contours by area to identify table cells

```
[STEP 3/6] Table detection complete: 7 cells, 109 contours in 0.33s
```

### Step 4: PaddleOCR Text Recognition
**Tool:** [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) `ocr.ocr(img, cls=True)`

Runs the PaddleOCR deep learning model with:
- **Detection Model**: Identifies text regions (bounding boxes)
- **Recognition Model**: Reads text from each region
- **Angle Classification** (`cls=True`): Corrects rotated text (180°)

This is the most time-intensive step (~10-30s on CPU for large images).

```
[STEP 4/6] PaddleOCR complete in 19.00s
```

### Step 5: Build Table Structure
**Tool:** Custom Python clustering algorithm (column-first approach)

Organizes detected text blocks into a structured table using a **column-first** algorithm that preserves multi-line text blocks:

#### 5a. Detect Column Boundaries (X-Gap Analysis)
1. Collect all X-start positions from text blocks
2. Sort positions and calculate gaps between consecutive values
3. Identify "large" gaps (> 2/3 of the largest gap) as column boundaries
4. This detects visually separate columns (e.g., sheets of paper side by side)

```
[DEBUG] X gaps (largest 5): [838, 743, 729, 708, 28], threshold: 549px
[DEBUG] Column boundaries (5): [83, 956, 1738, 2497, 3271]
```

#### 5b. Assign Blocks to Columns
Each text block is assigned to its column based on X position relative to detected boundaries.

```
[DEBUG] Blocks per column: [25, 26, 27, 26, 27]
```

#### 5c. Cluster Blocks into Cards (Y-Gap Analysis)
Within each column, text blocks are clustered into "cards" (logical groups like product descriptions):

1. Sort blocks by Y position (top to bottom)
2. Calculate vertical gaps between consecutive blocks
3. Gaps larger than 1.5× median text height indicate a new card
4. This keeps multi-line items together (e.g., "Canadian Solar 370-395W Solar Panels (90,284 Units / 34.456MW) Solar Energy Unused")

```
[DEBUG] Y gap threshold for card separation: 78px (median_height=52)
[DEBUG] Cards per column: [6, 6, 5, 5, 5]
```

#### 5d. Build Table Grid
The final table is constructed where each row contains the Nth card from each column:
- Row 0 = 1st card from each column
- Row 1 = 2nd card from each column
- etc.

```
[STEP 5/6] Detected 5 columns x 6 rows (max cards per column)
```

#### 5e. OCR Text Cleaning (Post-Processing)
After building the table, each cell's text is cleaned using multiple techniques:

**Tool 1: Dictionary-Based Corrections**
- Fixes common OCR misrecognitions: `Enerqy` → `Energy`, `10Ok` → `100k`
- Industry-specific corrections for solar equipment terminology

**Tool 2: Regex Pattern Matching**
- Fixes spacing around special characters: `Frames&Temper` → `Frames & Temper`
- Adds space before common words: `Unusedwith` → `Unused with`
- Separates merged words: `WSolar` → `W Solar`, `PVModules` → `PV Modules`
- Handles acronyms: `(SESolar` → `(SE) Solar`
- Number-word separation: `928Panels` → `928 Panels`

```
[STEP 5/6] Applied OCR text cleaning (spacing fixes, dictionary corrections)
```

### Step 6: Format Output
**Tool:** Python string/JSON formatting

Builds the final response:
- Structured table data with row/column assignments
- Tab-separated text output (row per line)
- Confidence scores per block and overall average
- All processing logs

```
[STEP 6/6] Output formatted in 0.00s
[COMPLETE] OCR finished: 131 text blocks, 6 rows, avg confidence: 96.14% (total: 12.45s)
```

### Example Log Output

When you call the `/ocr` endpoint, the response includes a `logs` array with all processing steps:

```json
{
  "success": true,
  "text": "...",
  "confidence": 0.9615,
  "logs": [
    {"timestamp": "12:05:38", "level": "info", "message": "[STEP 1/6] Reading uploaded file bytes..."},
    {"timestamp": "12:05:38", "level": "info", "message": "[STEP 1/6] Read 1820581 bytes (1.74MB) in 0.00s"},
    {"timestamp": "12:05:38", "level": "info", "message": "[STEP 2/6] Decoding image with OpenCV..."},
    {"timestamp": "12:05:38", "level": "info", "message": "[STEP 2/6] Decoded image: 4032x3024 pixels in 0.13s"},
    {"timestamp": "12:05:38", "level": "info", "message": "[STEP 3/6] Detecting table structure with OpenCV morphology..."},
    {"timestamp": "12:05:38", "level": "info", "message": "[STEP 3/6] Table detection complete: 8 cells, 113 contours in 0.16s"},
    {"timestamp": "12:05:38", "level": "info", "message": "[STEP 4/6] Running PaddleOCR text recognition (this may take 10-30s)..."},
    {"timestamp": "12:05:50", "level": "success", "message": "[STEP 4/6] PaddleOCR complete in 12.15s"},
    {"timestamp": "12:05:50", "level": "info", "message": "[STEP 5/6] Building table structure from 131 text blocks..."},
    {"timestamp": "12:05:50", "level": "info", "message": "[DEBUG] X gaps (largest 5): [838, 743, 729, 709, 28], threshold: 549px"},
    {"timestamp": "12:05:50", "level": "info", "message": "[DEBUG] Column boundaries (5): [83, 956, 1738, 2498, 3271]"},
    {"timestamp": "12:05:50", "level": "info", "message": "[DEBUG] Blocks per column: [25, 26, 27, 26, 27]"},
    {"timestamp": "12:05:50", "level": "info", "message": "[DEBUG] Y gap threshold for card separation: 78px (median_height=52)"},
    {"timestamp": "12:05:50", "level": "info", "message": "[DEBUG] Cards per column: [6, 6, 5, 5, 5]"},
    {"timestamp": "12:05:50", "level": "info", "message": "[STEP 5/6] Detected 5 columns x 6 rows (max cards per column)"},
    {"timestamp": "12:05:50", "level": "info", "message": "[STEP 5/6] Grid assignment complete: 6 rows x 5 columns"},
    {"timestamp": "12:05:50", "level": "info", "message": "[STEP 5/6] Applied OCR text cleaning (spacing fixes, dictionary corrections)"},
    {"timestamp": "12:05:50", "level": "info", "message": "[STEP 6/6] Formatting output..."},
    {"timestamp": "12:05:50", "level": "info", "message": "[STEP 6/6] Output formatted in 0.00s"},
    {"timestamp": "12:05:50", "level": "success", "message": "[COMPLETE] OCR finished: 131 text blocks, 6 rows, avg confidence: 96.15% (total: 12.45s)"}
  ]
}
```

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

| Component | Tool | Purpose |
|-----------|------|---------|
| **OCR Engine** | [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) v2.7.3 | Deep learning text detection & recognition |
| **Image Processing** | [OpenCV](https://opencv.org/) (cv2) | Image decoding, table structure detection via morphology |
| **Numerical Computing** | [NumPy](https://numpy.org/) | Array operations, image buffer handling |
| **Web Framework** | [Flask](https://flask.palletsprojects.com/) 3.0 | REST API endpoints |
| **WSGI Server** | [Gunicorn](https://gunicorn.org/) 21.2 | Production HTTP server with worker management |
| **Container** | [Docker](https://www.docker.com/) + Python 3.9-slim | Isolated, reproducible deployment |
| **Rotation Detection** | [Tesseract OSD](https://github.com/tesseract-ocr/tesseract) | Orientation & script detection for skewed images |

## License

MIT License - See [LICENSE](LICENSE) for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

