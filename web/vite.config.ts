import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Cornerstone: el loader DICOM se excluye del prebundle para que su worker
// resuelva bien la URL; sus dependencias CommonJS (parser y códecs) sí se prebundlean.
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ['@cornerstonejs/dicom-image-loader'],
    include: [
      'dicom-parser',
      'pako',
      '@cornerstonejs/codec-libjpeg-turbo-8bit/decodewasmjs',
      '@cornerstonejs/codec-charls/decodewasmjs',
      '@cornerstonejs/codec-openjpeg/decodewasmjs',
      '@cornerstonejs/codec-openjph/wasmjs',
      '@cornerstonejs/codec-libjxl/decodewasmjs',
    ],
  },
  worker: { format: 'es' },
})
