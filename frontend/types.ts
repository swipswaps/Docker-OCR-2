export type ExtractionMode = 'layout' | 'json';
export type OcrEngine = 'docker' | 'tesseract';

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
}

export interface ProcessingState {
  isProcessing: boolean;
  progressMessage: string;
}

export interface DockerHealth {
  status: 'healthy' | 'unhealthy' | 'checking';
  version?: string;
  details?: string;
}

export interface OCRResponse {
  text: string;
  confidence?: number;
  processing_time?: number;
  structure?: any;
}

declare global {
  interface Window {
    heic2any?: (options: { blob: Blob; toType: string; quality?: number }) => Promise<Blob | Blob[]>;
    exifr?: {
        orientation: (file: File | Blob) => Promise<number | undefined>;
    };
  }
}
