import React from 'react';
import { X, RotateCw, RotateCcw } from 'lucide-react';

interface DocumentViewerProps {
  imageSrc: string;
  onClear: () => void;
  onRotate?: (direction: 'left' | 'right') => void;
  isProcessing?: boolean;
}

export const DocumentViewer: React.FC<DocumentViewerProps> = ({
    imageSrc,
    onClear,
    onRotate,
    isProcessing = false
}) => {
  return (
    <div className="flex flex-col h-full bg-slate-800 rounded-xl overflow-hidden border border-slate-700 shadow-xl relative">
      {/* Loading Overlay */}
      {isProcessing && (
        <div className="absolute inset-0 bg-slate-900/60 z-20 flex items-center justify-center backdrop-blur-sm">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-400"></div>
        </div>
      )}

      <div className="flex items-center justify-between p-3 border-b border-slate-700 bg-slate-900/50 z-10">
        <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">Original Document</span>

        <div className="flex items-center space-x-1">
             {onRotate && (
                <>
                    <button
                        onClick={() => !isProcessing && onRotate('left')}
                        disabled={isProcessing}
                        className="p-1.5 hover:bg-slate-700 text-slate-400 hover:text-blue-400 rounded-lg transition-colors disabled:opacity-50"
                        title="Rotate 90° CCW"
                    >
                        <RotateCcw size={16} />
                    </button>
                    <button
                        onClick={() => !isProcessing && onRotate('right')}
                        disabled={isProcessing}
                        className="p-1.5 hover:bg-slate-700 text-slate-400 hover:text-blue-400 rounded-lg transition-colors disabled:opacity-50"
                        title="Rotate 90° CW"
                    >
                        <RotateCw size={16} />
                    </button>
                    <div className="w-px h-4 bg-slate-700 mx-1"></div>
                </>
             )}
            <button
                onClick={onClear}
                disabled={isProcessing}
                className="p-1.5 hover:bg-red-500/20 hover:text-red-400 text-slate-500 rounded-lg transition-colors"
                title="Remove image"
            >
                <X size={16} />
            </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-4 flex items-center justify-center bg-slate-900/30">
        <img
          src={imageSrc}
          alt="Uploaded document"
          className="max-w-full max-h-full object-contain shadow-lg rounded-md transition-transform duration-300"
        />
      </div>
    </div>
  );
};
