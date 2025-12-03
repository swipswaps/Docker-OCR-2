# Receipts OCR

A receipt scanning and data extraction tool with PostgreSQL storage. Built with React, TypeScript, Vite, and PaddleOCR.

## Features

- **Receipt Image Upload**: Drag & drop or click to upload receipt images
- **HEIC Support**: Automatic conversion of iPhone HEIC images to JPEG
- **EXIF Rotation**: Automatic orientation correction based on EXIF data
- **Dual OCR Engines**:
  - **PaddleOCR** (Docker backend): High-accuracy deep learning OCR
  - **Tesseract.js** (browser fallback): Works offline when backend unavailable
- **Receipt Parsing**: Extracts store name, items, prices, tax, and total
- **PostgreSQL Storage**: Save and retrieve receipts from database
- **Export Formats**: View raw OCR text and structured data

## Quick Start

### Frontend Only (Tesseract.js)

```bash
cd receipts-ocr
npm install
npm run dev
```

Open http://localhost:5173 - works without backend using browser-based OCR.

### Full Stack (PaddleOCR + PostgreSQL)

```bash
cd receipts-ocr
docker-compose up -d
npm run dev
```

This starts:
- PostgreSQL on port 5432
- PaddleOCR backend on port 5001
- Vite dev server on port 5173

## Architecture

```
receipts-ocr/
├── src/
│   ├── App.tsx              # Main React component
│   ├── App.css              # Styles
│   ├── types.ts             # TypeScript interfaces
│   └── services/
│       └── ocrService.ts    # OCR and API functions
├── backend/
│   ├── app.py               # Flask + PaddleOCR API
│   ├── Dockerfile           # Backend container
│   └── requirements.txt     # Python dependencies
└── docker-compose.yml       # Full stack orchestration
```

## Tech Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| Frontend | React 19 + TypeScript | UI framework |
| Build | Vite | Fast dev server and bundler |
| OCR (Docker) | PaddleOCR | Deep learning text recognition |
| OCR (Browser) | Tesseract.js | Offline fallback |
| Image Processing | heic2any, exifr | HEIC conversion, EXIF rotation |
| Database | PostgreSQL | Receipt storage |
| Backend | Flask + Gunicorn | REST API |
| Icons | Lucide React | UI icons |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Backend health check |
| `/ocr` | POST | Process receipt image |
| `/receipts` | GET | List all receipts |
| `/receipts` | POST | Save receipt |
| `/receipts/:id` | GET | Get receipt with items |
| `/receipts/:id` | DELETE | Delete receipt |

## Based On

This project uses patterns from [Docker-OCR-2](https://github.com/swipswaps/Docker-OCR-2) as documented in the `llm_notes/` folder:

- HEIC handling (heic2any already applies EXIF rotation)
- PaddleOCR configuration for CPU optimization
- OCR text cleaning with dictionary and regex patterns
- Gunicorn logging configuration
