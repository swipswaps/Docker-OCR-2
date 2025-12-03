import React, { useRef, useState } from 'react';
import { Upload, FileText, Image as ImageIcon, AlertCircle } from 'lucide-react';

interface FileUploadProps {
  onFileSelect: (file: File) => void;
  isProcessing: boolean;
}

export const FileUpload: React.FC<FileUploadProps> = ({ onFileSelect, isProcessing }) => {
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!isProcessing) setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (isProcessing) return;

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      validateAndProcess(e.dataTransfer.files[0]);
    }
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      validateAndProcess(e.target.files[0]);
    }
  };

  const validateAndProcess = (file: File) => {
    setError(null);
    if (!file.type.startsWith('image/')) {
      setError("Please upload an image file (JPG, PNG, WEBP).");
      return;
    }
    if (file.size > 10 * 1024 * 1024) { // 10MB limit
      setError("File size too large. Please upload an image under 10MB.");
      return;
    }
    onFileSelect(file);
  };

  return (
    <div
      className={`relative border-2 border-dashed rounded-xl p-8 transition-all duration-300 ease-in-out text-center cursor-pointer group
        ${isDragging
          ? 'border-blue-500 bg-blue-500/10'
          : 'border-slate-700 hover:border-slate-500 hover:bg-slate-800/50 bg-slate-800/20'
        }
        ${isProcessing ? 'opacity-50 cursor-not-allowed' : ''}
      `}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={() => !isProcessing && fileInputRef.current?.click()}
    >
      <input
        type="file"
        ref={fileInputRef}
        className="hidden"
        accept="image/*"
        onChange={handleFileInput}
        disabled={isProcessing}
      />

      <div className="flex flex-col items-center justify-center space-y-4">
        <div className={`p-4 rounded-full transition-colors ${isDragging ? 'bg-blue-500/20 text-blue-400' : 'bg-slate-700 text-slate-400 group-hover:bg-slate-600 group-hover:text-slate-200'}`}>
          <Upload size={32} />
        </div>

        <div>
          <h3 className="text-lg font-semibold text-slate-200">
            {isDragging ? 'Drop it here!' : 'Click or drag to upload'}
          </h3>
          <p className="text-sm text-slate-500 mt-1">
            Supports high-res images, handwritten notes, and tables.
          </p>
        </div>

        {error && (
          <div className="flex items-center text-red-400 text-sm bg-red-400/10 px-3 py-1.5 rounded-md mt-2">
            <AlertCircle size={16} className="mr-2" />
            {error}
          </div>
        )}
      </div>
    </div>
  );
};
