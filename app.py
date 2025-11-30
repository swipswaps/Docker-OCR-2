"""
DockerOCR Backend - PaddleOCR REST API Service

A production-ready Flask API for optical character recognition using PaddleOCR.
"""
import logging
import sys

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

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    stream=sys.stdout
)
logger = logging.getLogger(__name__)

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
        engine = PaddleOCR(
            use_angle_cls=True,
            lang='en',
            use_gpu=False,
            show_log=False,
            # Performance tuning (per PaddleOCR docs)
            det_limit_side_len=960,  # Max side length for detection
            det_limit_type='max',
            rec_batch_num=6,         # Recognition batch size
            cls_batch_num=6,         # Classification batch size
            # Model paths are auto-downloaded on first run
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


@app.route('/ocr', methods=['POST'])
def process_ocr():
    """
    Process an uploaded image and extract text using OCR.

    Request:
        - Form data with 'file' field containing an image

    Response:
        - JSON with extracted text, confidence score, and block details
    """
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
        # Read and decode image
        img_bytes = file.read()
        if len(img_bytes) == 0:
            return jsonify({"error": "Empty file uploaded"}), 400

        nparr = np.frombuffer(img_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if img is None:
            return jsonify({"error": "Failed to decode image. File may be corrupted."}), 400

        logger.info("Processing image: %s (%d bytes)", file.filename, len(img_bytes))

        # Run OCR
        result = ocr.ocr(img, cls=True)

        # Parse results
        extracted_text = []
        blocks = []
        confidence_sum = 0.0
        count = 0

        if result and result[0]:
            for line in result[0]:
                # line structure: [[box], (text, confidence)]
                box = line[0]
                text = line[1][0]
                conf = float(line[1][1])

                extracted_text.append(text)
                blocks.append({
                    "text": text,
                    "confidence": round(conf, 4),
                    "bbox": box
                })
                confidence_sum += conf
                count += 1

        avg_conf = round(confidence_sum / count, 4) if count > 0 else 0.0

        logger.info("OCR complete: %d text blocks, avg confidence: %.2f", count, avg_conf)

        return jsonify({
            "success": True,
            "text": "\n".join(extracted_text),
            "confidence": avg_conf,
            "block_count": count,
            "blocks": blocks
        })

    except Exception as e:
        logger.exception("Error processing OCR request")
        # Don't expose full traceback in production
        return jsonify({
            "error": "Internal server error during OCR processing",
            "details": str(e) if app.debug else None
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
