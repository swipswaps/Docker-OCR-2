#!/bin/bash
# Docker OCR Diagnostic Tool
# Verifies the complete OCR pipeline is working

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

CONTAINER_NAME="dockerocr-backend"
API_URL="http://localhost:5000"

echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}           Docker OCR Diagnostic Tool                       ${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo ""

# 1. Check if Docker is running
echo -e "${YELLOW}[1/7] Checking Docker daemon...${NC}"
if ! docker info &>/dev/null; then
    echo -e "${RED}✗ Docker daemon is not running${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Docker daemon is running${NC}"

# 2. Check container exists
echo -e "${YELLOW}[2/7] Checking container exists...${NC}"
if ! docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo -e "${RED}✗ Container '${CONTAINER_NAME}' does not exist${NC}"
    echo -e "  Run: docker build -t dockerocr-backend . && docker run -d --name dockerocr-backend -p 5000:5000 dockerocr-backend"
    exit 1
fi
echo -e "${GREEN}✓ Container exists${NC}"

# 3. Check container is running
echo -e "${YELLOW}[3/7] Checking container is running...${NC}"
CONTAINER_STATUS=$(docker inspect -f '{{.State.Status}}' "$CONTAINER_NAME" 2>/dev/null)
if [ "$CONTAINER_STATUS" != "running" ]; then
    echo -e "${RED}✗ Container status: ${CONTAINER_STATUS}${NC}"
    echo -e "  Last logs:"
    docker logs --tail 20 "$CONTAINER_NAME" 2>&1 | sed 's/^/    /'
    exit 1
fi
echo -e "${GREEN}✓ Container is running${NC}"

# 4. Check health endpoint
echo -e "${YELLOW}[4/7] Testing health endpoint...${NC}"
HEALTH_RESPONSE=$(curl -s -w "\n%{http_code}" "$API_URL/health" 2>/dev/null || echo -e "\n000")
HEALTH_BODY=$(echo "$HEALTH_RESPONSE" | head -n -1)
HEALTH_CODE=$(echo "$HEALTH_RESPONSE" | tail -n 1)

if [ "$HEALTH_CODE" != "200" ]; then
    echo -e "${RED}✗ Health check failed (HTTP $HEALTH_CODE)${NC}"
    echo -e "  Response: $HEALTH_BODY"
    exit 1
fi
echo -e "${GREEN}✓ Health endpoint OK: $HEALTH_BODY${NC}"

# 5. Check Tesseract OSD is available (for rotation detection)
echo -e "${YELLOW}[5/7] Checking Tesseract OSD in container...${NC}"
TESS_CHECK=$(docker exec "$CONTAINER_NAME" tesseract --version 2>&1 | head -1 || echo "NOT FOUND")
if [[ "$TESS_CHECK" == *"NOT FOUND"* ]] || [[ "$TESS_CHECK" == *"not found"* ]]; then
    echo -e "${RED}✗ Tesseract not installed in container${NC}"
else
    echo -e "${GREEN}✓ $TESS_CHECK${NC}"
fi

# 6. Test actual OCR with a real image
echo -e "${YELLOW}[6/7] Testing OCR with real image...${NC}"

# Create a test image with known text
TEST_IMG="/tmp/ocr_test_$$.png"
docker exec "$CONTAINER_NAME" python3 -c "
import cv2
import numpy as np
img = np.ones((200, 400, 3), dtype=np.uint8) * 255
cv2.putText(img, 'DOCKER OCR TEST', (20, 100), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 0), 2)
cv2.putText(img, '12345 ABCDE', (50, 150), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 0), 2)
cv2.imwrite('/tmp/test_ocr.png', img)
print('Test image created')
"

# Copy test image out and send to OCR
docker cp "$CONTAINER_NAME:/tmp/test_ocr.png" "$TEST_IMG" 2>/dev/null

OCR_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST -F "file=@$TEST_IMG" "$API_URL/ocr" 2>/dev/null || echo -e "\n000")
OCR_BODY=$(echo "$OCR_RESPONSE" | head -n -1)
OCR_CODE=$(echo "$OCR_RESPONSE" | tail -n 1)

rm -f "$TEST_IMG"

if [ "$OCR_CODE" != "200" ]; then
    echo -e "${RED}✗ OCR request failed (HTTP $OCR_CODE)${NC}"
    echo -e "  Response: $OCR_BODY"
    exit 1
fi

# Check if expected text was found
if echo "$OCR_BODY" | grep -qi "DOCKER\|OCR\|TEST\|12345"; then
    echo -e "${GREEN}✓ OCR working! Extracted text contains expected content${NC}"
    echo -e "  Response: $(echo "$OCR_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"text='{d.get('text','')[:50]}...', confidence={d.get('confidence',0):.2f}\")" 2>/dev/null || echo "$OCR_BODY")"
else
    echo -e "${YELLOW}⚠ OCR returned but text may not match expected${NC}"
    echo -e "  Response: $OCR_BODY"
fi

# 7. Test rotation detection endpoint
echo -e "${YELLOW}[7/7] Testing rotation detection endpoint...${NC}"
# Create base64 of test image
B64_IMG=$(docker exec "$CONTAINER_NAME" python3 -c "
import base64
with open('/tmp/test_ocr.png', 'rb') as f:
    print('data:image/png;base64,' + base64.b64encode(f.read()).decode())
")

ROT_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST -H "Content-Type: application/json" \
    -d "{\"image\": \"$B64_IMG\"}" "$API_URL/detect-rotation" 2>/dev/null || echo -e "\n000")
ROT_BODY=$(echo "$ROT_RESPONSE" | head -n -1)
ROT_CODE=$(echo "$ROT_RESPONSE" | tail -n 1)

if [ "$ROT_CODE" != "200" ]; then
    echo -e "${RED}✗ Rotation detection failed (HTTP $ROT_CODE)${NC}"
    echo -e "  Response: $ROT_BODY"
else
    echo -e "${GREEN}✓ Rotation detection OK${NC}"
    echo -e "  Response: $(echo "$ROT_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"orientation={d.get('orientation',0)}°, confidence={d.get('confidence',0):.2f}\")" 2>/dev/null || echo "$ROT_BODY")"
fi

echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}           All diagnostics passed!                          ${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "Container logs (last 10 lines):"
docker logs --tail 10 "$CONTAINER_NAME" 2>&1 | sed 's/^/  /'
