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

app = Flask(__name__)
CORS(app)

# Initialize PaddleOCR
print("Initializing PaddleOCR engine...")
ocr = PaddleOCR(use_angle_cls=True, lang='en')

@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "healthy", "service": "paddleocr"}), 200

@app.route('/ocr', methods=['POST'])
def process_ocr():
    if 'file' not in request.files:
        return jsonify({"error": "No file uploaded"}), 400

    file = request.files['file']
    mode = request.form.get('mode', 'layout')

    # Read image
    img_bytes = file.read()
    nparr = np.frombuffer(img_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    # Run OCR
    result = ocr.ocr(img, cls=True)

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

echo "▶️  Running Docker container..."
# Stop existing if running
docker stop dockerocr-backend 2>/dev/null || true
docker rm dockerocr-backend 2>/dev/null || true
docker run -d -p 5000:5000 --name dockerocr-backend swipswaps/paddleocr

echo "🎉 Done! Backend is running on http://localhost:5000"
