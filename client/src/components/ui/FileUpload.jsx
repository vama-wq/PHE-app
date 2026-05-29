import { useRef, useState } from 'react';
import { Upload, FileText, Image, X } from 'lucide-react';

export default function FileUpload({ onFile, accept = '.pdf,.jpg,.jpeg,.png', label = 'Upload File', current }) {
  const ref = useRef();
  const [dragging, setDragging] = useState(false);
  const [selected, setSelected] = useState(null);

  const handle = (file) => {
    if (!file) return;
    setSelected(file);
    onFile(file);
  };

  const isPDF = (name) => name?.toLowerCase().endsWith('.pdf');

  return (
    <div>
      {current && !selected && (
        <div className="mb-2 flex items-center gap-2 text-sm text-gray-600 bg-gray-50 rounded-lg px-3 py-2">
          {isPDF(current) ? <FileText size={16} className="text-red-500" /> : <Image size={16} className="text-blue-500" />}
          <span className="truncate">{current}</span>
          <span className="text-xs text-green-600 ml-auto">Current file</span>
        </div>
      )}

      <div
        className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors
          ${dragging ? 'border-brand-500 bg-brand-50' : 'border-gray-300 hover:border-brand-400 hover:bg-gray-50'}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); handle(e.dataTransfer.files[0]); }}
        onClick={() => ref.current.click()}
      >
        <input ref={ref} type="file" accept={accept} className="hidden"
          onChange={(e) => handle(e.target.files[0])} />

        {selected ? (
          <div className="flex items-center justify-center gap-2 text-sm">
            {isPDF(selected.name) ? <FileText size={20} className="text-red-500" /> : <Image size={20} className="text-blue-500" />}
            <span className="text-gray-700 font-medium truncate max-w-xs">{selected.name}</span>
            <button className="text-gray-400 hover:text-red-500" onClick={(e) => { e.stopPropagation(); setSelected(null); onFile(null); }}>
              <X size={16} />
            </button>
          </div>
        ) : (
          <div>
            <Upload size={24} className="mx-auto mb-2 text-gray-400" />
            <p className="text-sm text-gray-600">{label}</p>
            <p className="text-xs text-gray-400 mt-1">Click or drag & drop · PDF, JPG, PNG</p>
          </div>
        )}
      </div>
    </div>
  );
}
