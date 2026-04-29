/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Upload, FileText, Download, Loader2, CheckCircle2, AlertCircle, X, Image as ImageIcon, Table } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { getPdfDocument, getPageImage, cropImage } from './lib/pdfProcessor';
import { extractProductsFromPage } from './lib/gemini';

interface ProcessingState {
  status: 'idle' | 'loading' | 'processing' | 'completed' | 'error';
  message: string;
  progress: number;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'pdf' | 'converter' | 'renamer'>('pdf');
  const [file, setFile] = useState<File | null>(null);
  const [convFiles, setConvFiles] = useState<File[]>([]);
  const [renameFiles, setRenameFiles] = useState<File[]>([]);
  const [renameExcel, setRenameExcel] = useState<File | null>(null);
  const [targetExt, setTargetExt] = useState<'jpg' | 'png'>('jpg');
  const [state, setState] = useState<ProcessingState>({
    status: 'idle',
    message: '',
    progress: 0
  });
  const [extractedCount, setExtractedCount] = useState(0);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [quality, setQuality] = useState(0.7);
  const [scale, setScale] = useState(1.5);
  const [isOptimized, setIsOptimized] = useState(false);
  const [extractedItems, setExtractedItems] = useState<{ref: string, page: number}[]>([]);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const selectedFile = e.target.files[0];
      setFile(selectedFile);
      setState({ status: 'idle', message: '', progress: 0 });
      setErrorDetails(null);
      setExtractedItems([]);
      setExtractedCount(0);

      const sizeInMB = selectedFile.size / (1024 * 1024);
      if (sizeInMB > 50) {
        setQuality(0.5);
        setScale(1.2);
        setIsOptimized(true);
      } else if (sizeInMB > 20) {
        setQuality(0.6);
        setScale(1.3);
        setIsOptimized(true);
      } else {
        setQuality(0.7);
        setScale(1.5);
        setIsOptimized(false);
      }
    }
  };

  const onConvFilesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const filesArray = Array.from(e.target.files as FileList).filter(f => f.type.startsWith('image/') || f.name.match(/\.(avif|webp|heic)$/i));
      setConvFiles(filesArray);
      setState({ status: 'idle', message: '', progress: 0 });
      setErrorDetails(null);
    }
  };

  const onRenameFilesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setRenameFiles(Array.from(e.target.files as FileList));
      setState({ status: 'idle', message: '', progress: 0 });
      setErrorDetails(null);
    }
  };

  const onRenameExcelChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setRenameExcel(e.target.files[0]);
      setState({ status: 'idle', message: '', progress: 0 });
      setErrorDetails(null);
    }
  };

  const generateExcelTemplate = () => {
    if (renameFiles.length === 0) return;

    const data = renameFiles.map(f => {
      const lastDot = f.name.lastIndexOf('.');
      const nameWithoutExt = lastDot !== -1 ? f.name.substring(0, lastDot) : f.name;
      return [nameWithoutExt, ""]; 
    });

    data.unshift(["Nome Original", "Novo Nome"]);

    const worksheet = XLSX.utils.aoa_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Planilha de De-Para");
    XLSX.writeFile(workbook, "modelo_renomear_fotos.xlsx");
  };

  const processRenaming = async () => {
    if (renameFiles.length === 0 || !renameExcel) return;
    setState({ status: 'processing', message: 'Lendo Excel...', progress: 10 });

    try {
      // Read Excel
      const reader = new FileReader();
      const data = await new Promise<ArrayBuffer>((resolve) => {
        reader.onload = (e) => resolve(e.target?.result as ArrayBuffer);
        reader.readAsArrayBuffer(renameExcel);
      });

      const workbook = XLSX.read(data);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];

      // Create mapping: Map<originalNameWithoutExt, newName>
      const mapping = new Map<string, string>();
      rows.forEach(row => {
        if (row[0] && row[1]) {
          const original = String(row[0]).trim();
          const target = String(row[1]).trim();
          mapping.set(original, target);
        }
      });

      if (mapping.size === 0) {
        throw new Error("O arquivo Excel parece estar vazio ou sem colunas válidas.");
      }

      const zip = new JSZip();
      let renamedCount = 0;
      const missedFiles: string[] = [];

      for (let i = 0; i < renameFiles.length; i++) {
        const file = renameFiles[i];
        const progress = 10 + (i / renameFiles.length) * 85;
        setState({ 
          status: 'processing', 
          message: `Renomeando (${i + 1}/${renameFiles.length}): ${file.name}`, 
          progress 
        });

        const lastDot = file.name.lastIndexOf('.');
        const nameWithoutExt = lastDot !== -1 ? file.name.substring(0, lastDot) : file.name;
        const ext = lastDot !== -1 ? file.name.substring(lastDot) : '';

        // Match exactly
        let newName = mapping.get(nameWithoutExt);
        
        // If not found, check if Excel has extension in it (e.g. "image.jpg")
        if (!newName) {
          newName = mapping.get(file.name);
        }

        if (newName) {
          // Add extension if missing in mapping
          const finalName = newName.includes('.') ? newName : `${newName}${ext}`;
          zip.file(finalName, file);
          renamedCount++;
        } else {
          missedFiles.push(file.name);
        }
      }

      // Generate pendency report if there are missed files
      if (missedFiles.length > 0) {
        const reportData = missedFiles.map(name => [name]);
        reportData.unshift(["Arquivos Não Encontrados no Excel"]);
        
        const ws = XLSX.utils.aoa_to_sheet(reportData);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Pendências");
        
        const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
        zip.file("relatorio_pendencias.xlsx", wbout);
      }

      setState({ status: 'processing', message: 'Gerando arquivo ZIP...', progress: 95 });
      const content = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(content);
      const link = document.createElement('a');
      link.href = url;
      link.download = `fotos_renomeadas.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      setExtractedCount(renamedCount);
      setState({ status: 'completed', message: 'Renomeação concluída!', progress: 100 });
    } catch (err: any) {
      console.error(err);
      setState({ status: 'error', message: 'Erro ao renomear fotos.', progress: 0 });
      setErrorDetails(err.message);
    }
  };

  const processImageConversion = async () => {
    if (convFiles.length === 0) return;
    setExtractedCount(0);
    setState({ status: 'processing', message: 'Iniciando conversão...', progress: 0 });
    
    try {
      const zip = new JSZip();
      let processed = 0;

      for (const file of convFiles) {
        processed++;
        const progress = (processed / convFiles.length) * 100;
        setState({ 
          status: 'processing', 
          message: `Convertendo (${processed}/${convFiles.length}): ${file.name}`, 
          progress 
        });

        // Use createImageBitmap or Image() to load the file
        const blobUrl = URL.createObjectURL(file);
        try {
          const img = new Image();
          await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
            img.src = blobUrl;
          });

          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error("Canvas context failed");
          
          ctx.drawImage(img, 0, 0);
          
          const mimeType = targetExt === 'jpg' ? 'image/jpeg' : 'image/png';
          const convertedBlob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, mimeType, quality));
          
          if (convertedBlob) {
            const fileNameWithoutExt = file.name.substring(0, file.name.lastIndexOf('.')) || file.name;
            zip.file(`${fileNameWithoutExt}.${targetExt}`, convertedBlob);
            setExtractedCount(processed);
          }
        } finally {
          URL.revokeObjectURL(blobUrl);
        }
      }

      setState({ status: 'processing', message: 'Gerando arquivo ZIP...', progress: 95 });
      const content = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(content);
      const link = document.createElement('a');
      link.href = url;
      link.download = `fotos_convertidas.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      setState({ status: 'completed', message: 'Conversão concluída!', progress: 100 });
    } catch (err: any) {
      console.error(err);
      setState({ status: 'error', message: 'Erro na conversão das fotos.', progress: 0 });
      setErrorDetails(err.message);
    }
  };

  const processPdf = async () => {
    if (!file) return;
    setErrorDetails(null);
    setExtractedItems([]);
    setExtractedCount(0);

    try {
      setState({ status: 'loading', message: 'Abrindo PDF...', progress: 10 });
      const pdf = await getPdfDocument(file);
      const totalPages = pdf.numPages;
      
      const zip = new JSZip();
      let totalProducts = 0;
      
      setState({ status: 'processing', message: 'Iniciando análise...', progress: 20 });

      // Process pages in small batches to speed up while respecting rate limits
      const CONCURRENCY = 3; // Process 3 pages at a time
      const pageNumbers = Array.from({ length: totalPages }, (_, i) => i + 1);
      
      for (let i = 0; i < pageNumbers.length; i += CONCURRENCY) {
        const batch = pageNumbers.slice(i, i + CONCURRENCY);
        
        await Promise.all(batch.map(async (pageNum) => {
          try {
            setState(prev => ({ 
              ...prev, 
              message: `Analisando página ${pageNum} de ${totalPages}...`,
              progress: 20 + (pageNum / totalPages) * 70
            }));

            const pageImage = await getPageImage(pdf, pageNum, scale);
            const products = await extractProductsFromPage(pageImage);
            
            if (products && products.length > 0) {
              for (const product of products) {
                try {
                  const blob = await cropImage(pageImage, product.box_2d, quality);
                  const filename = `${product.reference.replace(/[^a-z0-9-]/gi, '_')}.jpg`;
                  zip.file(filename, blob);
                  totalProducts++;
                  setExtractedCount(prev => prev + 1);
                  setExtractedItems(prev => [{ref: product.reference, page: pageNum}, ...prev].slice(0, 50));
                } catch (err) {
                  console.error(`Erro ao recortar produto na pág ${pageNum}:`, product.reference, err);
                }
              }
            }
          } catch (pageError: any) {
            console.error(`Erro na página ${pageNum}:`, pageError);
            if (pageError.message?.includes('quota') || pageError.message?.includes('Safety')) {
              throw pageError;
            }
          }
        }));

        // Small delay between batches
        if (i + CONCURRENCY < pageNumbers.length) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      if (totalProducts === 0) {
        throw new Error("Nenhum produto com referência foi encontrado no catálogo. Verifique se o PDF segue o formato esperado.");
      }

      setState({ status: 'processing', message: 'Gerando arquivo ZIP...', progress: 95 });
      const content = await zip.generateAsync({ type: 'blob' });
      
      const url = URL.createObjectURL(content);
      const link = document.createElement('a');
      link.href = url;
      link.download = `fotos_catalogo_${file.name.replace('.pdf', '')}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      setState({ status: 'completed', message: 'Processamento concluído!', progress: 100 });
    } catch (error: any) {
      console.error(error);
      setErrorDetails(error.stack || error.message || String(error));
      setState({ 
        status: 'error', 
        message: error.message || 'Ocorreu um erro inesperado.', 
        progress: 0 
      });
    }
  };

  return (
    <div className="min-h-screen bg-[#F4F7F9] text-[#2D3748] font-sans selection:bg-red-100">
      {/* Header */}
      <header className="border-b border-gray-200 bg-white sticky top-0 z-20 shadow-sm">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-red-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-red-100">
              <FileText size={22} />
            </div>
            <div>
              <h1 className="font-bold text-xl tracking-tight text-gray-900">Catalogo Inteligente</h1>
              <p className="text-[10px] text-gray-400 font-medium uppercase tracking-wider">Ferramentas de Design</p>
            </div>
          </div>
          <div className="flex bg-gray-100 p-1 rounded-xl">
            <button 
              onClick={() => {
                setActiveTab('pdf');
                setState({ status: 'idle', message: '', progress: 0 });
              }}
              className={`px-4 py-2 text-xs font-bold rounded-lg transition-all ${activeTab === 'pdf' ? 'bg-white text-red-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
            >
              Extrator de PDF
            </button>
            <button 
              onClick={() => {
                setActiveTab('converter');
                setState({ status: 'idle', message: '', progress: 0 });
              }}
              className={`px-4 py-2 text-xs font-bold rounded-lg transition-all ${activeTab === 'converter' ? 'bg-white text-red-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
            >
              Conversor
            </button>
            <button 
              onClick={() => {
                setActiveTab('renamer');
                setState({ status: 'idle', message: '', progress: 0 });
              }}
              className={`px-4 py-2 text-xs font-bold rounded-lg transition-all ${activeTab === 'renamer' ? 'bg-white text-red-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
            >
              Renomeador
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-12">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* Left Column: Main Action */}
          <div className="lg:col-span-12 xl:col-span-7 space-y-8">
            <div className="space-y-3">
              <h2 className="text-4xl font-extrabold tracking-tight text-gray-900 leading-tight">
                {activeTab === 'pdf' && <>Extraia imagens e <span className="text-red-600">renomeie</span> automaticamente.</>}
                {activeTab === 'converter' && <>Converta formatos <span className="text-red-600">modernos</span> para JPG/PNG.</>}
                {activeTab === 'renamer' && <>Renomeie arquivos em <span className="text-red-600">lote</span> via Excel.</>}
              </h2>
            </div>

            {/* Upload Area */}
            <div className="bg-white rounded-3xl border border-gray-200 shadow-xl shadow-gray-200/50 overflow-hidden">
              <div className="p-8">
                {activeTab === 'pdf' ? (
                  /* PDF TAB CONTENT */
                  !file ? (
                    <label className="group relative flex flex-col items-center justify-center w-full h-72 border-2 border-dashed border-gray-200 rounded-2xl cursor-pointer hover:border-red-400 hover:bg-red-50/30 transition-all duration-500">
                      <div className="flex flex-col items-center justify-center pt-5 pb-6">
                        <div className="w-16 h-16 bg-gray-50 rounded-2xl flex items-center justify-center mb-5 group-hover:bg-red-100 group-hover:scale-110 group-hover:rotate-3 transition-all duration-500">
                          <Upload className="text-gray-400 group-hover:text-red-600" size={28} />
                        </div>
                        <p className="mb-2 text-base text-gray-800">
                          <span className="font-bold">Selecione o arquivo PDF</span> ou arraste aqui
                        </p>
                        <p className="text-xs text-gray-400 font-medium">Arquivos de até 50MB suportados</p>
                      </div>
                      <input type="file" className="hidden" accept="application/pdf" onChange={onFileChange} />
                    </label>
                  ) : (
                    <div className="space-y-6">
                      <div className="flex items-center justify-between p-5 bg-gray-50 rounded-2xl border border-gray-100">
                        <div className="flex items-center gap-4">
                          <div className="w-12 h-12 bg-red-50 rounded-xl flex items-center justify-center text-red-600 border border-red-100">
                            <FileText size={24} />
                          </div>
                          <div className="min-w-0">
                            <p className="font-bold text-gray-900 truncate max-w-[200px] sm:max-w-xs">
                              {file.name}
                            </p>
                            <p className="text-xs text-gray-500 font-medium">
                              {(file.size / (1024 * 1024)).toFixed(2)} MB • PDF
                            </p>
                          </div>
                        </div>
                        <button 
                          onClick={() => {
                            setFile(null);
                            setState({ status: 'idle', message: '', progress: 0 });
                            setErrorDetails(null);
                            setExtractedItems([]);
                          }}
                          className="p-2.5 hover:bg-red-50 hover:text-red-600 rounded-full transition-all text-gray-400"
                        >
                          <X size={20} />
                        </button>
                      </div>

                      {/* PDF Specific Logic (Quality, Process Button, etc.) - truncated for brevity if allowed, but I must follow instructions */}
                      {isOptimized && state.status === 'idle' && (
                        <div className="p-4 bg-blue-50 border border-blue-100 rounded-2xl flex items-start gap-3">
                          <div className="w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center text-blue-600 shrink-0">
                            <AlertCircle size={18} />
                          </div>
                          <p className="text-xs text-blue-800 font-medium">Detectamos um arquivo grande. Otimização ativa.</p>
                        </div>
                      )}

                      {state.status === 'idle' && (
                        <div className="p-5 bg-gray-50 rounded-2xl space-y-4">
                          <div className="flex items-center justify-between">
                            <label className="text-sm font-bold text-gray-800">Qualidade das Fotos</label>
                            <span className="text-xs font-bold bg-white px-2 py-1 rounded border border-gray-200">{Math.round(quality*100)}%</span>
                          </div>
                          <input type="range" min="0.1" max="1" step="0.1" value={quality} onChange={e => setQuality(parseFloat(e.target.value))} className="w-full accent-red-600" />
                        </div>
                      )}

                      <AnimatePresence mode="wait">
                        {state.status === 'idle' && (
                          <button onClick={processPdf} className="w-full py-5 bg-red-600 text-white font-bold rounded-2xl shadow-xl flex items-center justify-center gap-3">
                            Extrair e Renomear <Download size={20} />
                          </button>
                        )}
                        {/* Status indicators moved to global if possible, but keep here for now */}
                        {(state.status === 'loading' || state.status === 'processing') && (
                          <div className="space-y-4 py-4">
                            <div className="flex items-center justify-between text-sm font-bold">
                              <span>{state.message}</span>
                              <span className="text-red-600">{Math.round(state.progress)}%</span>
                            </div>
                            <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden"><div className="h-full bg-red-600" style={{width: `${state.progress}%`}} /></div>
                          </div>
                        )}
                        {state.status === 'completed' && <div className="p-8 bg-green-50 text-center rounded-3xl">Sucesso! {extractedCount} itens processados.</div>}
                        {state.status === 'error' && <div className="p-8 bg-red-50 text-center rounded-3xl">{state.message}</div>}
                      </AnimatePresence>
                    </div>
                  )
                ) : activeTab === 'converter' ? (
                  /* CONVERTER TAB CONTENT */
                  convFiles.length === 0 ? (
                    <label className="group relative flex flex-col items-center justify-center w-full h-72 border-2 border-dashed border-gray-200 rounded-2xl cursor-pointer hover:border-red-400 hover:bg-red-50/30 transition-all duration-500">
                      <div className="flex flex-col items-center justify-center pt-5 pb-6">
                        <div className="w-16 h-16 bg-gray-50 rounded-2xl flex items-center justify-center mb-5 group-hover:bg-red-100 group-hover:scale-110 group-hover:rotate-3 transition-all duration-500">
                          <Upload className="text-gray-400 group-hover:text-red-600" size={28} />
                        </div>
                        <p className="mb-2 text-base text-gray-800">
                          <span className="font-bold">Selecione Fotos ou Pastas</span>
                        </p>
                        <p className="text-xs text-gray-400 font-medium italic">AVIF, WebP, PNG, etc.</p>
                      </div>
                      {/* For simplicity we'll use standard multi-select. Directory selection is browser-dependent */}
                      <input type="file" className="hidden" multiple accept="image/*,.avif,.webp,.heic" onChange={onConvFilesChange} />
                    </label>
                  ) : (
                    <div className="space-y-6">
                      <div className="flex items-center justify-between p-5 bg-gray-50 rounded-2xl border border-gray-100">
                        <div className="flex items-center gap-4">
                          <div className="w-12 h-12 bg-red-50 rounded-xl flex items-center justify-center text-red-600 border border-red-100">
                            <CheckCircle2 size={24} />
                          </div>
                          <div>
                            <p className="font-bold text-gray-900">{convFiles.length} fotos selecionadas</p>
                            <p className="text-xs text-gray-500">Selecione o formato de saída e qualidade.</p>
                          </div>
                        </div>
                        <button onClick={() => setConvFiles([])} className="p-2.5 hover:bg-red-50 hover:text-red-600 rounded-full transition-all text-gray-400"><X size={20} /></button>
                      </div>

                      {state.status === 'idle' && (
                        <div className="grid grid-cols-2 gap-4">
                          <div className="p-5 bg-gray-50 rounded-2xl space-y-3">
                            <label className="text-sm font-bold text-gray-800">Formato Alvo</label>
                            <div className="flex gap-2">
                              {['jpg', 'png'].map(ext => (
                                <button 
                                  key={ext} 
                                  onClick={() => setTargetExt(ext as any)}
                                  className={`flex-1 py-2 text-xs font-bold rounded-lg border transition-all ${targetExt === ext ? 'bg-red-600 text-white border-red-600' : 'bg-white text-gray-600 border-gray-200 hover:border-red-300'}`}
                                >
                                  {ext.toUpperCase()}
                                </button>
                              ))}
                            </div>
                          </div>
                          <div className="p-5 bg-gray-50 rounded-2xl space-y-3">
                            <label className="text-sm font-bold text-gray-800">Qualidade</label>
                            <input type="range" min="0.1" max="1" step="0.1" value={quality} onChange={e => setQuality(parseFloat(e.target.value))} className="w-full accent-red-600" />
                            <p className="text-[10px] text-gray-400 text-center font-bold">{Math.round(quality*100)}%</p>
                          </div>
                        </div>
                      )}

                      <AnimatePresence mode="wait">
                        {state.status === 'idle' && (
                          <button onClick={processImageConversion} className="w-full py-5 bg-red-600 text-white font-bold rounded-2xl shadow-xl flex items-center justify-center gap-3">
                            Converter Todas <Download size={20} />
                          </button>
                        )}
                        {(state.status === 'processing') && (
                          <div className="space-y-4 py-4">
                            <div className="flex items-center justify-between text-sm font-bold">
                              <span>{state.message}</span>
                              <span className="text-red-600">{Math.round(state.progress)}%</span>
                            </div>
                            <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                              <div className="h-full bg-red-600 transition-all duration-300" style={{width: `${state.progress}%`}} />
                            </div>
                          </div>
                        )}
                        {state.status === 'completed' && <div className="p-8 bg-green-50 text-center rounded-3xl">Sucesso! {extractedCount} fotos convertidas.</div>}
                        {state.status === 'error' && <div className="p-8 bg-red-50 text-center rounded-3xl">{state.message}</div>}
                      </AnimatePresence>
                    </div>
                  )
                ) : (
                  /* RENAMER TAB CONTENT */
                  <div className="space-y-8">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      {/* Photos Selection */}
                      <div className="space-y-4">
                        <label className="text-xs font-bold uppercase tracking-widest text-gray-400">1. Selecione as Fotos</label>
                        {renameFiles.length === 0 ? (
                          <label className="flex flex-col items-center justify-center w-full h-48 border-2 border-dashed border-gray-200 rounded-2xl cursor-pointer hover:border-red-400 hover:bg-red-50/30 transition-all">
                            <Upload className="text-gray-300 mb-2" size={24} />
                            <span className="text-xs font-bold text-gray-500">Adicionar Fotos</span>
                            <input type="file" className="hidden" multiple accept="image/*" onChange={onRenameFilesChange} />
                          </label>
                        ) : (
                          <div className="space-y-3">
                            <div className="p-4 bg-gray-50 rounded-2xl border border-gray-100 flex items-center justify-between">
                              <div className="flex items-center gap-3">
                                <ImageIcon className="text-red-600" size={20} />
                                <span className="text-sm font-bold">{renameFiles.length} fotos</span>
                              </div>
                              <button onClick={() => setRenameFiles([])} className="text-gray-400 hover:text-red-600 transition-colors"><X size={18} /></button>
                            </div>
                            <button 
                              onClick={generateExcelTemplate}
                              className="w-full py-2.5 bg-white border-2 border-red-100 text-red-600 text-xs font-bold rounded-xl hover:bg-red-50 hover:border-red-200 transition-all flex items-center justify-center gap-2"
                            >
                              <Table size={14} />
                              Gerar Modelo Excel
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Excel Selection */}
                      <div className="space-y-4">
                        <label className="text-xs font-bold uppercase tracking-widest text-gray-400">2. Tabela de Nomes (Excel)</label>
                        {!renameExcel ? (
                          <label className="flex flex-col items-center justify-center w-full h-48 border-2 border-dashed border-gray-200 rounded-2xl cursor-pointer hover:border-red-400 hover:bg-red-50/30 transition-all">
                            <Table className="text-gray-300 mb-2" size={24} />
                            <span className="text-xs font-bold text-gray-500">Adicionar Excel (.xlsx)</span>
                            <input type="file" className="hidden" accept=".xlsx, .xls, .csv" onChange={onRenameExcelChange} />
                          </label>
                        ) : (
                          <div className="p-4 bg-gray-50 rounded-2xl border border-gray-100 flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              <Table className="text-green-600" size={20} />
                              <span className="text-sm font-bold truncate max-w-[120px]">{renameExcel.name}</span>
                            </div>
                            <button onClick={() => setRenameExcel(null)} className="text-gray-400 hover:text-red-600"><X size={18} /></button>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="p-4 bg-gray-50 rounded-xl border border-gray-100">
                      <p className="text-[10px] text-gray-500 leading-relaxed font-medium">
                        <strong className="text-gray-800">Instruções:</strong> Coluna A = Nome atual da foto (ex: KW9999). Coluna B = Novo nome (ex: 151289). A extensão original será mantida se não fornecida no novo nome.
                      </p>
                    </div>

                    <AnimatePresence mode="wait">
                      {state.status === 'idle' && (
                        <button 
                          disabled={renameFiles.length === 0 || !renameExcel}
                          onClick={processRenaming} 
                          className={`w-full py-5 font-bold rounded-2xl shadow-xl flex items-center justify-center gap-3 transition-all ${renameFiles.length > 0 && renameExcel ? 'bg-red-600 text-white hover:bg-red-700' : 'bg-gray-100 text-gray-400 cursor-not-allowed'}`}
                        >
                          Renomear e Baixar <Download size={20} />
                        </button>
                      )}
                      {state.status === 'processing' && (
                        <div className="space-y-4 py-4">
                          <div className="flex items-center justify-between text-sm font-bold">
                            <span>{state.message}</span>
                            <span className="text-red-600">{Math.round(state.progress)}%</span>
                          </div>
                          <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                            <div className="h-full bg-red-600 transition-all duration-300" style={{width: `${state.progress}%`}} />
                          </div>
                        </div>
                      )}
                      {state.status === 'completed' && <div className="p-8 bg-green-50 text-center rounded-3xl font-bold text-green-700">Concluído! {extractedCount} fotos renomeadas.</div>}
                      {state.status === 'error' && <div className="p-8 bg-red-50 text-center rounded-3xl font-bold text-red-700">{state.message}</div>}
                    </AnimatePresence>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right Column: Real-time Feed (Visible for PDF or as history for Converter) */}
          <div className={`${activeTab === 'pdf' ? 'lg:col-span-12 xl:col-span-5' : 'hidden md:block lg:col-span-12 xl:col-span-5'} space-y-6`}>
            <div className="bg-white rounded-3xl border border-gray-200 shadow-sm overflow-hidden flex flex-col h-full min-h-[400px]">
              <div className="p-5 border-b border-gray-100 bg-gray-50/50 flex items-center justify-between">
                <h3 className="font-bold text-gray-900 flex items-center gap-2">
                  <Download size={18} className="text-red-600" />
                  {activeTab === 'pdf' ? 'Itens Extraídos' : 'Arquivos Convertidos'}
                </h3>
                <span className="text-xs font-bold bg-red-100 text-red-700 px-2.5 py-1 rounded-full">
                  {extractedCount}
                </span>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-3 max-h-[500px]">
                {activeTab === 'pdf' ? (
                  extractedItems.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-center p-8 space-y-3 opacity-40">
                      <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center">
                        <FileText size={20} className="text-gray-400" />
                      </div>
                      <p className="text-xs font-medium text-gray-500">As fotos processadas aparecerão aqui</p>
                    </div>
                  ) : (
                    <AnimatePresence initial={false}>
                      {extractedItems.map((item, idx) => (
                        <motion.div key={`${item.ref}-${idx}`} initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} className="flex items-center justify-between p-3 bg-white border border-gray-100 rounded-xl shadow-sm group">
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="w-8 h-8 bg-gray-50 rounded-lg flex items-center justify-center text-gray-400 group-hover:text-red-600"><CheckCircle2 size={14} /></div>
                            <div className="min-w-0">
                              <p className="text-xs font-bold text-gray-800 truncate">{item.ref}.jpg</p>
                              <p className="text-[10px] text-gray-400 font-medium">Página {item.page}</p>
                            </div>
                          </div>
                          <div className="text-[10px] font-bold text-green-600 bg-green-50 px-2 py-0.5 rounded-md">OK</div>
                        </motion.div>
                      ))}
                    </AnimatePresence>
                  )
                ) : activeTab === 'converter' ? (
                  convFiles.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-center p-8 space-y-3 opacity-40">
                      <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center"><Download size={20} className="text-gray-400" /></div>
                      <p className="text-xs font-medium text-gray-500">Aguardando fotos para converter</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                       {convFiles.slice(0, 20).map((f, i) => (
                         <div key={i} className="flex items-center justify-between p-2.5 bg-gray-50 rounded-lg border border-gray-100">
                           <span className="text-[10px] font-medium text-gray-600 truncate max-w-[150px]">{f.name}</span>
                           <span className="text-[10px] text-gray-400">→ {targetExt.toUpperCase()}</span>
                         </div>
                       ))}
                       {convFiles.length > 20 && <p className="text-[10px] text-gray-400 text-center">E mais {convFiles.length - 20} arquivos...</p>}
                    </div>
                  )
                ) : (
                  /* RENAMER FEED */
                  renameFiles.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-center p-8 space-y-3 opacity-40">
                      <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center"><ImageIcon size={20} className="text-gray-400" /></div>
                      <p className="text-xs font-medium text-gray-500">Aguardando fotos para renomear</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                       {renameFiles.slice(0, 20).map((f, i) => (
                         <div key={i} className="flex items-center justify-between p-2.5 bg-gray-50 rounded-lg border border-gray-100">
                           <span className="text-[10px] font-medium text-gray-600 truncate max-w-[150px]">{f.name}</span>
                           <span className="text-[10px] text-gray-400 font-bold uppercase">Foto</span>
                         </div>
                       ))}
                       {renameFiles.length > 20 && <p className="text-[10px] text-gray-400 text-center">E mais {renameFiles.length - 20} arquivos...</p>}
                    </div>
                  )
                )}
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="max-w-6xl mx-auto px-6 py-12 border-t border-gray-200 mt-12">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-2 opacity-50">
            <div className="w-6 h-6 bg-gray-400 rounded flex items-center justify-center text-white">
              <FileText size={14} />
            </div>
            <span className="text-sm font-bold tracking-tight">PDF para Fotos</span>
          </div>
          <p className="text-xs text-gray-400 font-medium">
            © 2024 • Ferramenta de Extração Inteligente de Catálogos
          </p>
          <div className="flex gap-4 text-xs font-bold text-gray-400">
            <span className="hover:text-red-600 cursor-pointer transition-colors">Termos</span>
            <span className="hover:text-red-600 cursor-pointer transition-colors">Privacidade</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
