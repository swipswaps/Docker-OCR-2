#!/bin/bash
echo "🚀 Setting up DockerOCR Backend..."

# 1. Create requirements.txt
echo "Creating requirements.txt..."
cat <<EOF > requirements.txt
flask==3.0.0
flask-cors==4.0.0
paddlepaddle>=2.6.0
paddleocr>=2.7.0.3
opencv-python-headless==4.8.1.78
numpy<2.0.0
EOF

# 2. Create Dockerfile
echo "Creating Dockerfile..."
cat <<EOF > Dockerfile
FROM python:3.9-slim

RUN apt-get update && apt-get install -y \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    libgeos-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

EXPOSE 5000

CMD ["python", "app.py"]
EOF

# 3. Create app.py
echo "Creating app.py..."
cat <<EOF > app.py
from flask import Flask, request, jsonify
from flask_cors import CORS
from paddleocr import PaddleOCR
import os
import cv2
import numpy as np
import traceback

app = Flask(__name__)
CORS(app)

# Initialize PaddleOCR
print("Initializing PaddleOCR engine...")
try:
    ocr = PaddleOCR(use_angle_cls=True, lang='en')
    print("PaddleOCR initialized successfully.")
except Exception as e:
    print(f"Failed to initialize PaddleOCR: {e}")
    traceback.print_exc()
    ocr = None

@app.route('/health', methods=['GET'])
def health():
    if ocr is None:
        return jsonify({"status": "unhealthy", "service": "paddleocr", "error": "Engine failed to init"}), 503
    return jsonify({"status": "healthy", "service": "paddleocr"}), 200

@app.route('/ocr', methods=['POST'])
def process_ocr():
    try:
        if ocr is None:
             return jsonify({"error": "PaddleOCR engine not initialized"}), 500

        if 'file' not in request.files:
            return jsonify({"error": "No file uploaded"}), 400
        
        file = request.files['file']
        mode = request.form.get('mode', 'layout')
        
        # Read image
        img_bytes = file.read()
        nparr = np.frombuffer(img_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        
        if img is None:
            return jsonify({"error": "Failed to decode image"}), 400
        
        # Run OCR
        # Note: cls=True removed to avoid kwargs conflict in some versions. 
        # Classification is handled by use_angle_cls=True at init.
        result = ocr.ocr(img)
        
        # Parse results
        extracted_text = []
        blocks = []
        confidence_sum = 0
        count = 0
        
        if result and result[0]:
            for line in result[0]:
                # line structure: [[box], [text, confidence]]
                text = line[1][0]
                conf = line[1][1]
                box = line[0]
                
                extracted_text.append(text)
                blocks.append({
                    "text": text,
                    "confidence": conf,
                    "bbox": box
                })
                confidence_sum += conf
                count += 1
                
        avg_conf = confidence_sum / count if count > 0 else 0
        
        return jsonify({
            "text": "\n".join(extracted_text),
            "confidence": avg_conf,
            "blocks": blocks
        })
    except Exception as e:
        print(f"Error processing OCR: {e}")
        traceback.print_exc()
        return jsonify({"error": str(e), "trace": traceback.format_exc()}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
EOF

# 4. Create .dockerignore
echo "Creating .dockerignore..."
cat <<EOF > .dockerignore
node_modules
dist
.git
EOF

echo "✅ Files created successfully."
echo "🐳 Building Docker image (swipswaps/paddleocr)... This may take a few minutes."
docker build -t swipswaps/paddleocr .

echo "🧹 Cleaning up port 5000..."
# Stop by name
docker stop dockerocr-backend 2>/dev/null || true
docker rm dockerocr-backend 2>/dev/null || true

# Stop ANY container using port 5000
CONF_ID=$(docker ps -q --filter "publish=5000")
if [ ! -z "$CONF_ID" ]; then
  echo "Found conflicting container $CONF_ID. Stopping..."
  docker stop $CONF_ID
  docker rm $CONF_ID
fi

# Stop host process if running
if command -v fuser &> /dev/null; then
    fuser -k -n tcp 5000 2>/dev/null || true
fi

# Wait for socket release
sleep 2

echo "▶️  Running Docker container..."
docker run -d -p 5000:5000 --name dockerocr-backend swipswaps/paddleocr

echo "🎉 Done! Backend is running on http://localhost:5000"
