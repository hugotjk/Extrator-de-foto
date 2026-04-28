/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Upload, FileText, Download, Loader2, CheckCircle2, AlertCircle, X } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import JSZip from 'jszip';
import { getPdfDocument, getPageImage, cropImage } from './lib/pdfProcessor';
import { extractProductsFromPage } from './lib/gemini';

interface ProcessingState {
  status: 'idle' | 'loading' | 'processing' | 'completed' | 'error';
  message: string;
  progress: number;
}

export default function App() {
  const [file, setFile] = useState<File | null>(null);
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

      // Automatic optimization based on file size
      const sizeInMB = selectedFile.size / (1024 * 1024);
      if (sizeInMB > 50) {
        setQuality(0.5);
        setScale(1.0);
        setIsOptimized(true);
      } else if (sizeInMB > 20) {
        setQuality(0.6);
        setScale(1.2);
        setIsOptimized(true);
      } else {
        setQuality(0.7);
        setScale(1.5);
        setIsOptimized(false);
      }
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
      const CONCURRENCY = 2; // Process 2 pages at a time
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
              <h1 className="font-bold text-xl tracking-tight text-gray-900">PDF para Fotos</h1>
              <p className="text-[10px] text-gray-400 font-medium uppercase tracking-wider">Extração Inteligente</p>
            </div>
          </div>
          <div className="hidden sm:flex items-center gap-6 text-sm font-medium text-gray-500">
            <span className="hover:text-red-600 cursor-pointer transition-colors">Como funciona</span>
            <span className="hover:text-red-600 cursor-pointer transition-colors">Segurança</span>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-12">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* Left Column: Main Action */}
          <div className="lg:col-span-7 space-y-8">
            <div className="space-y-3">
              <h2 className="text-4xl font-extrabold tracking-tight text-gray-900 leading-tight">
                Extraia imagens e <span className="text-red-600">renomeie</span> automaticamente.
              </h2>
              <p className="text-lg text-gray-500 leading-relaxed">
                Igual ao iLovePDF, mas com o poder da IA para identificar referências e organizar seus arquivos.
              </p>
            </div>

            {/* Upload Area */}
            <div className="bg-white rounded-3xl border border-gray-200 shadow-xl shadow-gray-200/50 overflow-hidden">
              <div className="p-8">
                {!file ? (
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

                    {/* Optimization Alert */}
                    {isOptimized && state.status === 'idle' && (
                      <motion.div 
                        initial={{ opacity: 0, y: -10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="p-4 bg-blue-50 border border-blue-100 rounded-2xl flex items-start gap-3"
                      >
                        <div className="w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center text-blue-600 shrink-0">
                          <AlertCircle size={18} />
                        </div>
                        <p className="text-xs text-blue-800 leading-relaxed font-medium">
                          <strong className="block mb-0.5">Otimização Ativa</strong>
                          Detectamos um arquivo grande. Ajustamos a resolução para garantir rapidez e um ZIP final leve.
                        </p>
                      </motion.div>
                    )}

                    {/* Quality Selector */}
                    {state.status === 'idle' && (
                      <div className="p-5 bg-gray-50 rounded-2xl border border-gray-100 space-y-4">
                        <div className="flex items-center justify-between">
                          <div className="flex flex-col">
                            <label className="text-sm font-bold text-gray-800">Qualidade das Fotos</label>
                            <span className="text-[10px] text-gray-500 font-medium uppercase tracking-wider">Ajuste o peso do arquivo final</span>
                          </div>
                          <span className="text-xs font-bold bg-white border border-gray-200 text-gray-700 px-3 py-1 rounded-lg shadow-sm">
                            {Math.round(quality * 100)}%
                          </span>
                        </div>
                        <input 
                          type="range" 
                          min="0.1" 
                          max="1" 
                          step="0.1" 
                          value={quality} 
                          onChange={(e) => {
                            setQuality(parseFloat(e.target.value));
                            setIsOptimized(false);
                          }}
                          className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-red-600"
                        />
                        <div className="flex justify-between text-[10px] text-gray-400 font-bold uppercase tracking-widest">
                          <span>Menor Peso</span>
                          <span>Máxima Qualidade</span>
                        </div>
                      </div>
                    )}

                    <AnimatePresence mode="wait">
                      {state.status === 'idle' && (
                        <motion.button
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, scale: 0.95 }}
                          onClick={processPdf}
                          className="w-full py-5 bg-red-600 hover:bg-red-700 text-white font-bold rounded-2xl shadow-xl shadow-red-200 transition-all active:scale-[0.98] flex items-center justify-center gap-3 text-lg"
                        >
                          Extrair e Renomear
                          <Download size={20} />
                        </motion.button>
                      )}

                      {(state.status === 'loading' || state.status === 'processing') && (
                        <motion.div
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          className="space-y-6 py-4"
                        >
                          <div className="flex items-center justify-between text-sm font-bold text-gray-700">
                            <div className="flex items-center gap-2">
                              <Loader2 className="animate-spin text-red-600" size={18} />
                              <span>{state.message}</span>
                            </div>
                            <span className="text-red-600">{Math.round(state.progress)}%</span>
                          </div>
                          <div className="w-full h-3 bg-gray-100 rounded-full overflow-hidden border border-gray-200 p-0.5">
                            <motion.div 
                              className="h-full bg-red-600 rounded-full shadow-sm"
                              initial={{ width: 0 }}
                              animate={{ width: `${state.progress}%` }}
                              transition={{ duration: 0.5 }}
                            />
                          </div>
                          <p className="text-center text-xs text-gray-400 font-medium italic">
                            Isso pode levar alguns minutos dependendo do tamanho do PDF...
                          </p>
                        </motion.div>
                      )}

                      {state.status === 'completed' && (
                        <motion.div
                          initial={{ opacity: 0, scale: 0.9 }}
                          animate={{ opacity: 1, scale: 1 }}
                          className="p-8 bg-green-50 border border-green-100 rounded-3xl text-center space-y-4"
                        >
                          <div className="w-16 h-16 bg-green-100 rounded-2xl flex items-center justify-center text-green-600 mx-auto border border-green-200">
                            <CheckCircle2 size={32} />
                          </div>
                          <div>
                            <h3 className="text-xl font-bold text-green-900">Sucesso!</h3>
                            <p className="text-sm text-green-700 font-medium">
                              {extractedCount} fotos foram extraídas e renomeadas com sucesso.
                            </p>
                          </div>
                          <button 
                            onClick={() => {
                              setFile(null);
                              setState({ status: 'idle', message: '', progress: 0 });
                              setExtractedItems([]);
                            }}
                            className="px-6 py-2.5 bg-green-600 text-white rounded-xl font-bold hover:bg-green-700 transition-colors shadow-lg shadow-green-100"
                          >
                            Novo Arquivo
                          </button>
                        </motion.div>
                      )}

                      {state.status === 'error' && (
                        <motion.div
                          initial={{ opacity: 0, scale: 0.9 }}
                          animate={{ opacity: 1, scale: 1 }}
                          className="p-8 bg-red-50 border border-red-100 rounded-3xl text-center space-y-4"
                        >
                          <div className="w-16 h-16 bg-red-100 rounded-2xl flex items-center justify-center text-red-600 mx-auto border border-red-200">
                            <AlertCircle size={32} />
                          </div>
                          <div>
                            <h3 className="text-xl font-bold text-red-900">Erro no Processamento</h3>
                            <p className="text-sm text-red-700 font-medium mt-1">
                              {state.message}
                            </p>
                          </div>
                          {errorDetails && (
                            <div className="text-[10px] text-red-400 bg-white p-3 rounded-xl border border-red-50 max-h-32 overflow-y-auto font-mono text-left">
                              {errorDetails}
                            </div>
                          )}
                          <button 
                            onClick={() => setState({ status: 'idle', message: '', progress: 0 })}
                            className="px-6 py-2.5 bg-red-600 text-white rounded-xl font-bold hover:bg-red-700 transition-colors shadow-lg shadow-red-100"
                          >
                            Tentar Novamente
                          </button>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right Column: Real-time Feed */}
          <div className="lg:col-span-5 space-y-6">
            <div className="bg-white rounded-3xl border border-gray-200 shadow-sm overflow-hidden flex flex-col h-full min-h-[400px]">
              <div className="p-5 border-b border-gray-100 bg-gray-50/50 flex items-center justify-between">
                <h3 className="font-bold text-gray-900 flex items-center gap-2">
                  <Download size={18} className="text-red-600" />
                  Itens Extraídos
                </h3>
                <span className="text-xs font-bold bg-red-100 text-red-700 px-2.5 py-1 rounded-full">
                  {extractedCount}
                </span>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-3 max-h-[500px]">
                {extractedItems.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center p-8 space-y-3 opacity-40">
                    <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center">
                      <FileText size={20} className="text-gray-400" />
                    </div>
                    <p className="text-xs font-medium text-gray-500">
                      As fotos aparecerão aqui conforme forem identificadas
                    </p>
                  </div>
                ) : (
                  <AnimatePresence initial={false}>
                    {extractedItems.map((item, idx) => (
                      <motion.div
                        key={`${item.ref}-${idx}`}
                        initial={{ opacity: 0, x: 20 }}
                        animate={{ opacity: 1, x: 0 }}
                        className="flex items-center justify-between p-3 bg-white border border-gray-100 rounded-xl shadow-sm hover:border-red-200 transition-colors group"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-8 h-8 bg-gray-50 rounded-lg flex items-center justify-center text-gray-400 group-hover:bg-red-50 group-hover:text-red-600 transition-colors">
                            <CheckCircle2 size={14} />
                          </div>
                          <div className="min-w-0">
                            <p className="text-xs font-bold text-gray-800 truncate">
                              {item.ref}.jpg
                            </p>
                            <p className="text-[10px] text-gray-400 font-medium">Página {item.page}</p>
                          </div>
                        </div>
                        <div className="text-[10px] font-bold text-green-600 bg-green-50 px-2 py-0.5 rounded-md">
                          OK
                        </div>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                )}
              </div>
              {extractedItems.length > 0 && (
                <div className="p-4 border-t border-gray-100 bg-gray-50/50">
                  <p className="text-[10px] text-gray-400 text-center font-medium italic">
                    Mostrando os últimos 50 itens identificados
                  </p>
                </div>
              )}
            </div>

            {/* Features Info */}
            <div className="grid grid-cols-2 gap-4">
              <div className="p-4 bg-white rounded-2xl border border-gray-200 space-y-2">
                <div className="w-8 h-8 bg-orange-50 rounded-lg flex items-center justify-center text-orange-600">
                  <CheckCircle2 size={16} />
                </div>
                <h4 className="text-xs font-bold text-gray-900">IA Visual</h4>
                <p className="text-[10px] text-gray-500 leading-relaxed font-medium">Detecta referências em qualquer posição.</p>
              </div>
              <div className="p-4 bg-white rounded-2xl border border-gray-200 space-y-2">
                <div className="w-8 h-8 bg-blue-50 rounded-lg flex items-center justify-center text-blue-600">
                  <CheckCircle2 size={16} />
                </div>
                <h4 className="text-xs font-bold text-gray-900">Privacidade</h4>
                <p className="text-[10px] text-gray-500 leading-relaxed font-medium">Processamento local e seguro.</p>
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
