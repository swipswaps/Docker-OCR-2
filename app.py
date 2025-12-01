"""
DockerOCR Backend - PaddleOCR REST API Service

A production-ready Flask API for optical character recognition using PaddleOCR.
Includes Tesseract OSD for rotation detection.
"""
import logging
import sys
import base64
import tempfile
import subprocess
import os
import time
import threading

from flask import Flask, request, jsonify
from flask_cors import CORS
from paddleocr import PaddleOCR
import cv2
import numpy as np

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------
MAX_CONTENT_LENGTH = 16 * 1024 * 1024  # 16 MB max file size
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tiff', 'tif'}
ALLOWED_MIMETYPES = {
    'image/png', 'image/jpeg', 'image/gif', 'image/bmp',
    'image/webp', 'image/tiff'
}

# Configure logging - use stderr so gunicorn captures it with --capture-output
# Create handler explicitly for reliable output
handler = logging.StreamHandler(sys.stderr)
handler.setLevel(logging.INFO)
handler.setFormatter(logging.Formatter('[%(asctime)s] [%(levelname)7s] %(message)s', datefmt='%Y-%m-%d %H:%M:%S'))

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)
logger.addHandler(handler)
# Prevent duplicate logs from root logger
logger.propagate = False

# -----------------------------------------------------------------------------
# Flask Application Setup
# -----------------------------------------------------------------------------
app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = MAX_CONTENT_LENGTH

# CORS configuration - adjust origins for production
CORS(app, resources={r"/*": {"origins": "*"}}, methods=["GET", "POST", "OPTIONS"])


# -----------------------------------------------------------------------------
# PaddleOCR Initialization
# -----------------------------------------------------------------------------
def init_ocr_engine():
    """Initialize PaddleOCR with optimized settings for production."""
    logger.info("Initializing PaddleOCR engine...")
    try:
        # CPU-optimized settings from working DockerOCR project
        # CRITICAL: use_angle_cls=False to avoid "could not execute a primitive" on some CPUs
        engine = PaddleOCR(
            use_angle_cls=False,     # Disabled - causes CPU issues; rotation handled by Tesseract OSD
            lang='en',
            use_gpu=False,
            show_log=False,
            enable_mkldnn=False,     # Disable MKL-DNN to avoid CPU instruction issues
            cpu_threads=1,           # Single thread to avoid race conditions
            use_tensorrt=False,      # Disable TensorRT
            use_mp=False,            # Disable multiprocessing
            # Higher detection limits for high-resolution images (e.g., phone photos)
            det_limit_side_len=2560, # Increased from 960 to handle 4K images
            det_limit_type='max',
            det_db_thresh=0.3,       # Lower threshold to detect more text regions
            det_db_box_thresh=0.5,   # Box confidence threshold
            rec_batch_num=6,         # Recognition batch size
        )
        logger.info("PaddleOCR initialized successfully.")
        return engine
    except Exception as e:
        logger.exception("Failed to initialize PaddleOCR: %s", e)
        return None


ocr = init_ocr_engine()


# -----------------------------------------------------------------------------
# Helper Functions
# -----------------------------------------------------------------------------
def allowed_file(filename: str) -> bool:
    """Check if file extension is allowed."""
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


def validate_image_file(file) -> tuple[bool, str]:
    """
    Validate uploaded file is a legitimate image.
    Returns (is_valid, error_message).
    """
    if not file or file.filename == '':
        return False, "No file selected"

    if not allowed_file(file.filename):
        return False, f"File type not allowed. Allowed: {', '.join(ALLOWED_EXTENSIONS)}"

    # Check MIME type
    if file.content_type and file.content_type not in ALLOWED_MIMETYPES:
        return False, f"Invalid MIME type: {file.content_type}"

    return True, ""


# Thread-local storage for collecting logs during a request
request_logs = threading.local()


def emit_log(message: str, level: str = 'info'):
    """Emit a log message to stderr and collect for response."""
    timestamp = time.strftime('%H:%M:%S')
    logger.info(message)
    # Collect log for response
    if hasattr(request_logs, 'logs'):
        request_logs.logs.append({
            'timestamp': timestamp,
            'level': level,
            'message': message
        })


# -----------------------------------------------------------------------------
# API Routes
# -----------------------------------------------------------------------------


@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint for container orchestration."""
    if ocr is None:
        return jsonify({
            "status": "unhealthy",
            "service": "paddleocr",
            "error": "Engine failed to initialize"
        }), 503

    return jsonify({
        "status": "healthy",
        "service": "paddleocr",
        "version": "1.0.0"
    }), 200


@app.route('/detect-rotation', methods=['POST'])
def detect_rotation():
    """
    Detect image orientation using Tesseract OSD (Orientation and Script Detection).

    This endpoint analyzes an image and returns the detected orientation angle,
    which can be used to correct rotated images before OCR processing.

    Request:
        - JSON with 'image' field containing base64-encoded image data

    Response:
        - JSON with orientation, confidence, and correction angle
    """
    try:
        logger.info("Rotation detection request received")

        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({'error': 'No image data provided'}), 400

        # Extract base64 image data
        image_data = data['image']

        # Remove data URL prefix if present
        if ',' in image_data:
            image_data = image_data.split(',')[1]

        # Decode base64
        img_bytes = base64.b64decode(image_data)
        logger.info("Decoded %d bytes for rotation detection", len(img_bytes))

        # Save to temporary file for Tesseract
        with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp:
            tmp.write(img_bytes)
            tmp_path = tmp.name

        try:
            # Run Tesseract OSD (Orientation and Script Detection)
            logger.info("Running Tesseract OSD...")
            result = subprocess.run(
                ['tesseract', tmp_path, 'stdout', '--psm', '0'],
                capture_output=True,
                text=True,
                timeout=30
            )

            osd_output = result.stdout
            logger.info("Tesseract OSD output: %s", osd_output[:200] if osd_output else "empty")

            # Parse orientation from OSD output
            orientation = 0
            rotate = 0
            confidence = 0.0
            script = 'Unknown'

            for line in osd_output.split('\n'):
                if 'Orientation in degrees:' in line:
                    orientation = int(line.split(':')[1].strip())
                elif 'Rotate:' in line:
                    rotate = int(line.split(':')[1].strip())
                elif 'Orientation confidence:' in line:
                    confidence = float(line.split(':')[1].strip())
                elif 'Script:' in line:
                    script = line.split(':')[1].strip()

            logger.info("Detected: orientation=%d°, rotate=%d°, confidence=%.2f",
                       orientation, rotate, confidence)

            return jsonify({
                'success': True,
                'orientation': orientation,
                'rotate': rotate,
                'confidence': confidence,
                'script': script,
                'raw_output': osd_output
            })

        finally:
            # Clean up temp file
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)

    except subprocess.TimeoutExpired:
        logger.error("Tesseract OSD timed out")
        return jsonify({'error': 'Tesseract OSD timed out'}), 500
    except FileNotFoundError:
        logger.error("Tesseract not installed")
        return jsonify({
            'error': 'Tesseract not installed in container',
            'success': False,
            'orientation': 0,
            'confidence': 0
        }), 500
    except Exception as e:
        logger.exception("Rotation detection failed")
        return jsonify({'error': str(e)}), 500


@app.route('/ocr', methods=['POST'])
def process_ocr():
    """
    Process an uploaded image and extract text using OCR.

    Request:
        - Form data with 'file' field containing an image

    Response:
        - JSON with extracted text, confidence score, block details, and logs
    """
    # Initialize log collection for this request
    request_logs.logs = []

    if ocr is None:
        return jsonify({"error": "PaddleOCR engine not initialized"}), 503

    # Validate file presence
    if 'file' not in request.files:
        return jsonify({"error": "No file uploaded. Use 'file' form field."}), 400

    file = request.files['file']

    # Validate file
    is_valid, error_msg = validate_image_file(file)
    if not is_valid:
        return jsonify({"error": error_msg}), 400

    try:
        step_start = time.time()
        total_start = time.time()

        # Step 1: Read file bytes
        emit_log("[STEP 1/6] Reading uploaded file bytes...")
        img_bytes = file.read()
        if len(img_bytes) == 0:
            return jsonify({"error": "Empty file uploaded"}), 400
        emit_log(f"[STEP 1/6] Read {len(img_bytes)} bytes ({len(img_bytes)/1024/1024:.2f}MB) in {time.time() - step_start:.2f}s")

        # Step 2: Decode image
        step_start = time.time()
        emit_log("[STEP 2/6] Decoding image with OpenCV...")
        nparr = np.frombuffer(img_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if img is None:
            return jsonify({"error": "Failed to decode image. File may be corrupted."}), 400

        img_h, img_w = img.shape[:2]
        emit_log(f"[STEP 2/6] Decoded image: {img_w}x{img_h} pixels in {time.time() - step_start:.2f}s")

        # Step 3: Detect table structure using OpenCV
        step_start = time.time()
        emit_log("[STEP 3/6] Detecting table structure with OpenCV morphology...")
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

        # Detect horizontal and vertical lines for table structure
        thresh = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                        cv2.THRESH_BINARY_INV, 11, 2)

        # Detect horizontal lines
        horizontal_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (40, 1))
        horizontal_lines = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, horizontal_kernel, iterations=2)

        # Detect vertical lines
        vertical_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, 40))
        vertical_lines = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, vertical_kernel, iterations=2)

        # Combine lines to find table grid
        table_mask = cv2.add(horizontal_lines, vertical_lines)

        # Find contours for potential cells
        contours, _ = cv2.findContours(table_mask, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)

        # Extract cell bounding boxes (filter by size)
        img_h, img_w = img.shape[:2]
        min_cell_area = (img_w * img_h) * 0.001  # At least 0.1% of image
        max_cell_area = (img_w * img_h) * 0.5    # At most 50% of image

        cells = []
        for cnt in contours:
            x, y, w, h = cv2.boundingRect(cnt)
            area = w * h
            if min_cell_area < area < max_cell_area and w > 30 and h > 20:
                cells.append((x, y, x + w, y + h))

        emit_log(f"[STEP 3/6] Table detection complete: {len(cells)} cells, {len(contours)} contours in {time.time() - step_start:.2f}s")

        # Step 4: Run PaddleOCR
        step_start = time.time()
        emit_log("[STEP 4/6] Running PaddleOCR text recognition (this may take 10-30s)...")
        result = ocr.ocr(img, cls=True)
        emit_log(f"[STEP 4/6] PaddleOCR complete in {time.time() - step_start:.2f}s", 'success')

        # Parse results
        raw_blocks = []
        confidence_sum = 0.0
        count = 0

        if result and result[0]:
            for line in result[0]:
                box = line[0]
                text = line[1][0]
                conf = float(line[1][1])

                # Post-process text: add spaces between letters and numbers
                # e.g., "Canadian Solar370-395wSolar" -> "Canadian Solar 370-395w Solar"
                import re
                # Add space between lowercase letter followed by digit
                text = re.sub(r'([a-z])(\d)', r'\1 \2', text)
                # Add space between digit followed by lowercase letter (not unit prefix like k, M, w)
                text = re.sub(r'(\d)([a-zA-Z])(?![kKmMwWvVaA])', r'\1 \2', text)
                # Add space between lowercase letter followed by uppercase
                text = re.sub(r'([a-z])([A-Z])', r'\1 \2', text)
                # Add space after closing parenthesis followed by letter
                text = re.sub(r'\)([a-zA-Z])', r') \1', text)
                # Clean up multiple spaces
                text = re.sub(r'\s+', ' ', text).strip()

                # Calculate bounding box metrics
                x_min = min(box[0][0], box[3][0])
                x_max = max(box[1][0], box[2][0])
                y_min = min(box[0][1], box[1][1])
                y_max = max(box[2][1], box[3][1])
                y_center = (y_min + y_max) / 2
                x_center = (x_min + x_max) / 2

                raw_blocks.append({
                    "text": text,
                    "confidence": round(conf, 4),
                    "bbox": box,
                    "_y_min": y_min,
                    "_y_max": y_max,
                    "_y": y_center,
                    "_x_min": x_min,
                    "_x_max": x_max,
                    "_x": x_center,
                    "_width": x_max - x_min,
                    "_height": y_max - y_min
                })
                confidence_sum += conf
                count += 1

        # Step 5: Build table structure
        step_start = time.time()
        emit_log(f"[STEP 5/6] Building table structure from {count} text blocks...")
        blocks = []
        table_rows = []

        if raw_blocks:
            # Cluster blocks into rows based on Y position
            raw_blocks.sort(key=lambda b: b["_y"])

            # Calculate median height for row clustering
            heights = [b["_height"] for b in raw_blocks]
            median_height = sorted(heights)[len(heights)//2] if heights else 30
            row_threshold = median_height * 0.7

            # Group into rows
            rows = []
            current_row = [raw_blocks[0]]
            for b in raw_blocks[1:]:
                # Check if this block is on same row (Y overlap or close Y)
                last_y = current_row[-1]["_y"]
                if abs(b["_y"] - last_y) < row_threshold:
                    current_row.append(b)
                else:
                    rows.append(current_row)
                    current_row = [b]
            rows.append(current_row)

            # Sort blocks within each row by X position
            for row in rows:
                row.sort(key=lambda b: b["_x_min"])

            # Detect columns using all X positions
            all_x_starts = sorted([b["_x_min"] for b in raw_blocks])

            # Find column boundaries by clustering X starts
            col_boundaries = []
            if all_x_starts:
                widths = [b["_width"] for b in raw_blocks]
                median_width = sorted(widths)[len(widths)//2] if widths else 100
                gap_threshold = median_width * 0.3  # Tighter threshold

                col_boundaries = [all_x_starts[0]]
                for x in all_x_starts[1:]:
                    # Check if this X is far enough from last boundary
                    is_new_col = True
                    for bx in col_boundaries:
                        if abs(x - bx) < gap_threshold:
                            is_new_col = False
                            break
                    if is_new_col:
                        col_boundaries.append(x)
                col_boundaries.sort()

            num_cols = len(col_boundaries)
            emit_log(f"[STEP 5/6] Detected {len(rows)} rows and {num_cols} columns in {time.time() - step_start:.2f}s")

            # Step 6: Build structured table data
            step_start = time.time()
            emit_log("[STEP 6/6] Formatting output...")
            for row_idx, row in enumerate(rows):
                row_data = [""] * num_cols
                row_confidences = [0.0] * num_cols

                for block in row:
                    # Find which column this block belongs to
                    col_idx = 0
                    for i, col_x in enumerate(col_boundaries):
                        if block["_x_min"] >= col_x - gap_threshold:
                            col_idx = i

                    # Append text to cell (handle multiple text blocks in same cell)
                    if row_data[col_idx]:
                        row_data[col_idx] += " " + block["text"]
                    else:
                        row_data[col_idx] = block["text"]
                    row_confidences[col_idx] = max(row_confidences[col_idx], block["confidence"])

                table_rows.append({
                    "row": row_idx,
                    "cells": row_data,
                    "confidences": row_confidences
                })

                # Also add individual blocks for backward compatibility
                for col_idx, cell_text in enumerate(row_data):
                    if cell_text:
                        blocks.append({
                            "text": cell_text,
                            "confidence": row_confidences[col_idx],
                            "row": row_idx,
                            "col": col_idx
                        })

            # Build text output - row by row with tab separation
            extracted_text = []
            for row in table_rows:
                row_text = "\t".join(row["cells"])
                extracted_text.append(row_text)

        avg_conf = round(confidence_sum / count, 4) if count > 0 else 0.0

        emit_log(f"[STEP 6/6] Output formatted in {time.time() - step_start:.2f}s")
        total_time = time.time() - total_start
        emit_log(f"[COMPLETE] OCR finished: {count} text blocks, {len(table_rows)} rows, avg confidence: {avg_conf * 100:.2f}% (total: {total_time:.2f}s)", 'success')

        # Get collected logs for response
        collected_logs = getattr(request_logs, 'logs', [])

        return jsonify({
            "success": True,
            "text": "\n".join(extracted_text),
            "confidence": avg_conf,
            "block_count": count,
            "blocks": blocks,
            "table": table_rows,
            "columns": len(col_boundaries) if 'col_boundaries' in dir() else 0,
            "logs": collected_logs
        })

    except Exception as e:
        emit_log(f"[ERROR] OCR failed: {str(e)}", 'error')
        logger.exception("Error processing OCR request")
        # Get collected logs for error response
        collected_logs = getattr(request_logs, 'logs', [])
        return jsonify({
            "error": "Internal server error during OCR processing",
            "details": str(e) if app.debug else None,
            "logs": collected_logs
        }), 500


@app.errorhandler(413)
def request_entity_too_large(_error):
    """Handle file too large error."""
    max_mb = MAX_CONTENT_LENGTH // (1024 * 1024)
    return jsonify({
        "error": f"File too large. Maximum size is {max_mb} MB"
    }), 413


# -----------------------------------------------------------------------------
# Application Entry Point
# -----------------------------------------------------------------------------
if __name__ == '__main__':
    # Development server only - use gunicorn in production
    logger.warning("Running with Flask dev server. Use gunicorn for production!")
    app.run(host='0.0.0.0', port=5000, debug=False)
